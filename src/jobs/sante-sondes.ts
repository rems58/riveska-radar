import { execFile } from 'node:child_process'
import { google } from 'googleapis'
import { citerOnglet } from '../sinks/sheets.ts'
import type { OptionsSheets } from '../sinks/sheets.ts'
import type { OptionsTelegram } from '../sinks/telegram.ts'
import { dateValideOuNull } from '../collectors/http.ts'
import type { EtatSheet, EtatTelegram, EtatOpenrouter } from './sante.ts'

/**
 * Sondes reseau/systeme de la commande "sante" (jobs/sante.ts les recoit injectees).
 * Trois contraintes qui les distinguent des collecteurs :
 *  - **Delai d'attente court et individuel** (8s) : une verification de sante qui
 *    reste bloquee ne sert a rien. Chaque sonde rend un etat, jamais une exception.
 *  - **Silencieuses** : aucune ne journalise en console (contrairement a
 *    collectors/http.ts), sans quoi les avertissements se melangeraient au rapport.
 *  - **Lecture seule** : scope Sheets en readonly, getMe cote Telegram, endpoint de
 *    compte cote OpenRouter. Aucune ne peut ecrire ni facturer quoi que ce soit.
 *
 * Aucune sonde ne parle a Reddit : le budget d'une requete par minute ne se depense
 * jamais pour une verification (voir collectors/reddit-rss.ts).
 */

const TIMEOUT_MS = 8_000
/** schtasks /v enumere TOUTES les taches de la machine : laisser un peu plus de marge. */
const TIMEOUT_SCHTASKS_MS = 15_000

interface ReponseHttp {
  statut: number | null
  json: unknown
  erreur: string | null
}

/** fetch minimal, silencieux, borne en temps. Ne leve jamais. */
async function appeler(url: string, init?: RequestInit): Promise<ReponseHttp> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(url, { ...init, signal: controller.signal })
    let json: unknown = null
    try {
      json = JSON.parse(await r.text())
    } catch {
      json = null
    }
    return { statut: r.status, json, erreur: null }
  } catch (err) {
    const raison = err instanceof Error ? err.message : String(err)
    return { statut: null, json: null, erreur: raison.includes('abort') ? `delai de ${TIMEOUT_MS / 1000}s depasse` : raison }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Google Sheets
// ---------------------------------------------------------------------------

function codeHttp(err: unknown): number | null {
  const e = err as { code?: number | string; status?: number; response?: { status?: number } }
  const brut = e?.code ?? e?.status ?? e?.response?.status
  const n = Number(brut)
  return Number.isFinite(n) ? n : null
}

/**
 * Lit la seule colonne date_detect (colonne A) de l'onglet configure : cela prouve
 * en un appel l'acces reel, la presence de l'onglet, le nombre de prospects et la
 * date du plus recent. Le scope demande est spreadsheets.READONLY : meme un bug de
 * cette commande ne pourrait pas ecrire dans le classeur de travail.
 */
export async function sonderSheet(o: OptionsSheets): Promise<EtatSheet> {
  try {
    const auth = new google.auth.JWT({
      email: o.email,
      key: o.clePrivee,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    })
    const api = google.sheets({ version: 'v4', auth })
    const r = await api.spreadsheets.values.get(
      { spreadsheetId: o.sheetId, range: `${citerOnglet(o.onglet)}!A1:A` },
      { timeout: TIMEOUT_MS },
    )

    // Seules les cellules qui portent une vraie date sont comptees : la ligne
    // d'en-tetes ("date_detect") et les lignes vides s'excluent d'elles-memes.
    let lignes = 0
    let dernier: Date | null = null
    for (const ligne of r.data.values ?? []) {
      const brut = ligne[0]
      if (typeof brut !== 'string') continue
      const date = dateValideOuNull(new Date(brut))
      if (!date) continue
      lignes++
      if (!dernier || date > dernier) dernier = date
    }

    return { ok: true, ongletTrouve: true, lignes, dernierProspect: dernier }
  } catch (err) {
    const code = codeHttp(err)
    const message = err instanceof Error ? err.message : String(err)
    // Google refuse une plage dont l'onglet n'existe pas avec un 400 "Unable to
    // parse range" : c'est un SHEET_TAB errone, pas un probleme de droits.
    if (/unable to parse range/i.test(message)) return { ok: false, code, ongletTrouve: false, message }
    return { ok: false, code, message }
  }
}

// ---------------------------------------------------------------------------
// Telegram
// ---------------------------------------------------------------------------

/**
 * getMe suffit a prouver que le token est valide et l'API joignable, et n'envoie
 * AUCUN message : l'utilisateur ne veut pas etre notifie a chaque verification.
 * L'envoi reel reste derriere le drapeau --notif (sinks/telegram.ts).
 */
export async function sonderTelegram(o: OptionsTelegram): Promise<EtatTelegram> {
  const r = await appeler(`https://api.telegram.org/bot${o.token}/getMe`)

  if (r.statut === 200) {
    const nom = (r.json as { result?: { username?: string } })?.result?.username
    return { ok: true, code: 200, nom: typeof nom === 'string' ? nom : undefined }
  }
  // Le token est dans l'URL : ne jamais renvoyer de message qui la contiendrait.
  return { ok: false, code: r.statut, message: r.erreur ?? undefined }
}

// ---------------------------------------------------------------------------
// OpenRouter
// ---------------------------------------------------------------------------

function nombreOuNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

/**
 * Valide la cle sur l'endpoint de compte (gratuit) et non sur /chat/completions :
 * verifier la sante ne doit rien couter. Le credit restant n'est pas expose de la
 * meme facon selon le type de compte, d'ou les trois sources essayees dans l'ordre.
 */
export async function sonderOpenrouter(cle: string): Promise<EtatOpenrouter> {
  const entetes = { Authorization: `Bearer ${cle}` }
  const [cleR, creditsR] = await Promise.all([
    appeler('https://openrouter.ai/api/v1/key', { headers: entetes }),
    appeler('https://openrouter.ai/api/v1/credits', { headers: entetes }),
  ])

  if (cleR.statut !== 200) {
    return { ok: false, code: cleR.statut, message: cleR.erreur ?? undefined }
  }

  const data = (cleR.json as { data?: Record<string, unknown> })?.data ?? {}
  const credits = (creditsR.json as { data?: Record<string, unknown> })?.data ?? {}

  const restantDeLaCle = nombreOuNull(data.limit_remaining)
  const totalCredits = nombreOuNull(credits.total_credits)
  const totalUsage = nombreOuNull(credits.total_usage)
  const plafond = nombreOuNull(data.limit)
  const usage = nombreOuNull(data.usage)

  let restant: number | null = restantDeLaCle
  if (restant === null && totalCredits !== null && totalUsage !== null) restant = totalCredits - totalUsage
  if (restant === null && plafond !== null && usage !== null) restant = plafond - usage

  // Rien d'autre n'est remonte que le credit : le champ "label" de l'API contient
  // par defaut un extrait de la cle elle-meme (voir EtatOpenrouter).
  return { ok: true, code: 200, restant: restant === null ? null : Math.round(restant * 100) / 100 }
}

// ---------------------------------------------------------------------------
// Taches planifiees (Windows)
// ---------------------------------------------------------------------------

/**
 * Sortie brute de `schtasks /query /fo csv /v`, ou null si la commande echoue
 * (autre systeme, schtasks absent, delai depasse) - l'absence de reponse est alors
 * annoncee comme "non verifie", jamais comme une panne.
 *
 * Decodage en latin1 volontaire : schtasks ecrit dans la page de codes OEM de la
 * console (cp850 en France), que Node ne sait pas decoder. latin1 preserve tout
 * l'ASCII - donc les noms de taches, les dates et les codes de resultat, les seuls
 * champs reellement lus - et se contente de deformer les accents des libelles.
 */
export function lireTachesPlanifiees(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'schtasks',
      ['/query', '/fo', 'csv', '/v'],
      { timeout: TIMEOUT_SCHTASKS_MS, maxBuffer: 32 * 1024 * 1024, encoding: 'latin1', windowsHide: true },
      (err, stdout) => resolve(err && !stdout ? null : stdout),
    )
  })
}
