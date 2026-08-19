import { existsSync, readdirSync, statSync, openSync, readSync, closeSync, fstatSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { parseConfig } from '../config.ts'
import type { Config } from '../config.ts'
import type { OptionsSheets } from '../sinks/sheets.ts'
import type { OptionsTelegram } from '../sinks/telegram.ts'
import { processVivant } from '../verrou.ts'

/**
 * Commande "sante" : repond a la seule question qui compte sur un mini PC sans
 * surveillance - "est-ce que tout va bien ?" - en quelques secondes et sans rien
 * modifier. Trois regles fermes qui expliquent la forme de ce fichier :
 *
 *  - **Aucun appel a Reddit, jamais.** Le budget tolere est d'UNE requete par
 *    minute (voir collectors/reddit-rss.ts) : le depenser pour une verification
 *    prolongerait la penalite au lieu de la laisser retomber. L'etat de Reddit se
 *    lit uniquement dans logs/reddit.log.
 *  - **Aucun appel LLM de scoring.** Verifier la cle OpenRouter interroge son
 *    endpoint de compte (gratuit), jamais /chat/completions.
 *  - **Aucune ecriture.** Pas de ligne dans le Sheet, pas de purge de la base,
 *    pas de pose de verrou (index.ts exempte cette commande), pas de message
 *    Telegram sauf demande explicite (--notif).
 *
 * Tout ce qui sort du process (reseau, schtasks, base) est injecte via DepsSante :
 * les tests ne touchent donc jamais le reseau.
 */

export type Marqueur = 'OK' | '!!' | '--'

export interface Ligne {
  marqueur: Marqueur
  texte: string
}

export interface Bloc {
  titre: string
  lignes: Ligne[]
}

const MINUTE_MS = 60_000
const HEURE_MS = 60 * MINUTE_MS
const JOUR_MS = 24 * HEURE_MS

export const COMMANDES_SURVEILLEES = ['radar', 'reddit', 'recheck', 'triggers', 'weekly'] as const
export type CommandeSurveillee = (typeof COMMANDES_SURVEILLEES)[number]

/** Cadence reelle de chaque tache planifiee (scripts/installer-taches.ps1). */
export const CADENCE_MS: Record<CommandeSurveillee, number> = {
  radar: 15 * MINUTE_MS,
  reddit: 1 * HEURE_MS,
  recheck: 6 * HEURE_MS,
  triggers: 1 * JOUR_MS,
  weekly: 7 * JOUR_MS,
}

/**
 * Un log est juge fige quand sa derniere ecriture depasse 3x la cadence de son job.
 * Marge volontairement large : une tache "Start when available" peut glisser, un run
 * radar peut durer plusieurs minutes (LLM lent). Au-dela de 3 cycles manques, ce
 * n'est plus du decalage, c'est une tache qui ne se declenche plus.
 */
export const TOLERANCE_LOG = 3

export const NOM_TACHE: Record<CommandeSurveillee, string> = {
  radar: 'RiveskaRadar-Radar',
  reddit: 'RiveskaRadar-Reddit',
  recheck: 'RiveskaRadar-Recheck',
  triggers: 'RiveskaRadar-Triggers',
  weekly: 'RiveskaRadar-Weekly',
}

/**
 * SCHED_S_TASK_HAS_NOT_RUN : la tache est enregistree mais ne s'est jamais
 * declenchee. Ce n'est PAS un echec - c'est l'etat normal des premieres heures
 * apres l'installation (et l'etat permanent d'une tache hebdomadaire installee
 * un mardi). Ne jamais l'afficher comme une erreur.
 */
export const CODE_JAMAIS_DECLENCHEE = 267011
/** SCHED_S_TASK_RUNNING : la tache tourne en ce moment meme. */
export const CODE_EN_COURS = 267009

/** Au-dela, un verrou encore detenu par un process vivant devient suspect (run bloque). */
const SEUIL_VERROU_SUSPECT_MS = 60 * MINUTE_MS

/** Seuil d'alerte sur le credit OpenRouter restant, dans la devise renvoyee par l'API. */
const SEUIL_CREDIT_BAS = 1

/** On ne lit que la fin des logs : ils vont jusqu'a 5 Mo avant rotation. */
const TAILLE_QUEUE_LOG = 64 * 1024

// ---------------------------------------------------------------------------
// Etats renvoyes par les sondes (implementees dans sante-sondes.ts)
// ---------------------------------------------------------------------------

export interface EtatSheet {
  ok: boolean
  /** Code HTTP renvoye par l'API Google, si connu. */
  code?: number | string | null
  /** false = la plage a ete refusee parce que l'onglet n'existe pas. */
  ongletTrouve?: boolean
  /** Nombre de lignes de prospects (hors ligne d'en-tetes). */
  lignes?: number
  dernierProspect?: Date | null
  message?: string
}

export interface EtatTelegram {
  ok: boolean
  code?: number | null
  /** Nom d'utilisateur du bot renvoye par getMe. */
  nom?: string
  message?: string
}

export interface EtatOpenrouter {
  ok: boolean
  code?: number | null
  /**
   * Credit restant si l'API l'expose, null sinon (cle sans plafond, compte prepaye
   * illimite...). Volontairement le SEUL detail de compte remonte : le champ "label"
   * d'OpenRouter vaut par defaut un extrait de la cle elle-meme ("sk-or-v1-01a...ee0"),
   * qui n'a rien a faire dans un rapport destine a etre copie-colle.
   */
  restant?: number | null
  message?: string
}

export interface StatsDbSante {
  posts: number
  dernierAjout: Date | null
  /** Posts en echec technique, en attente d'une nouvelle tentative au prochain run. */
  enAttenteRetry: number
  /** Posts abandonnes definitivement (3 echecs a la meme etape). */
  abandons: number
  /** Abandons survenus ces 7 derniers jours - les seuls qui signalent une panne actuelle. */
  abandonsRecents: number
}

export interface DepsSante {
  /** Racine du projet : c'est la que vivent .env, radar.db, les *.lock et logs/. */
  racine: string
  cheminDb: string
  env: Record<string, string | undefined>
  /** true uniquement avec le drapeau --notif : envoie un vrai message Telegram. */
  notif: boolean
  maintenant?: Date
  /** process.platform par defaut ; injectable pour les tests. */
  plateforme?: string
  verifierSheet: (o: OptionsSheets) => Promise<EtatSheet>
  verifierTelegram: (o: OptionsTelegram) => Promise<EtatTelegram>
  envoyerTest: (o: OptionsTelegram) => Promise<boolean>
  verifierOpenrouter: (cle: string) => Promise<EtatOpenrouter>
  statsDb: (chemin: string) => StatsDbSante
  /** Sortie CSV de `schtasks /query /fo csv /v`, ou null si indisponible. */
  lireTaches: () => Promise<string | null>
}

export interface ResultatSante {
  blocs: Bloc[]
  rapport: string
  /** false des qu'une ligne "!!" existe : c'est le code de sortie 1 de la commande. */
  ok: boolean
}

// ---------------------------------------------------------------------------
// Formatage
// ---------------------------------------------------------------------------

/** Duree lisible d'un coup d'oeil : "12 min", "3 h 5 min", "2 j 2 h". */
export function formaterAge(ms: number): string {
  if (ms < MINUTE_MS) return "moins d'une minute"
  if (ms < HEURE_MS) return `${Math.floor(ms / MINUTE_MS)} min`
  if (ms < JOUR_MS) {
    const h = Math.floor(ms / HEURE_MS)
    const min = Math.floor((ms % HEURE_MS) / MINUTE_MS)
    return min > 0 ? `${h} h ${min} min` : `${h} h`
  }
  const j = Math.floor(ms / JOUR_MS)
  const h = Math.floor((ms % JOUR_MS) / HEURE_MS)
  return h > 0 ? `${j} j ${h} h` : `${j} j`
}

function deuxChiffres(n: number): string {
  return String(n).padStart(2, '0')
}

/** Date locale courte : l'utilisateur raisonne en heure locale, pas en UTC. */
function horodatageCourt(d: Date): string {
  return (
    `${deuxChiffres(d.getDate())}/${deuxChiffres(d.getMonth() + 1)}/${d.getFullYear()} ` +
    `${deuxChiffres(d.getHours())}:${deuxChiffres(d.getMinutes())}`
  )
}

export function aUnProbleme(blocs: Bloc[]): boolean {
  return blocs.some((b) => b.lignes.some((l) => l.marqueur === '!!'))
}

/**
 * Rapport compact : un bloc par domaine, un marqueur par ligne, une conclusion en
 * une ligne. La conclusion nomme les domaines en cause pour qu'un coup d'oeil au
 * bas de l'ecran suffise quand la sortie a defile.
 */
export function formaterRapport(blocs: Bloc[], maintenant: Date): string {
  const morceaux: string[] = [`Sante Riveska Radar - ${horodatageCourt(maintenant)}`, '']

  for (const bloc of blocs) {
    morceaux.push(`[${bloc.titre}]`)
    for (const l of bloc.lignes) morceaux.push(`  ${l.marqueur}  ${l.texte}`)
    morceaux.push('')
  }

  const enCause = blocs.filter((b) => b.lignes.some((l) => l.marqueur === '!!')).map((b) => b.titre)
  morceaux.push(
    enCause.length === 0
      ? 'Conclusion : tout va bien - aucun probleme detecte.'
      : `Conclusion : ${enCause.length} domaine(s) en defaut - ${enCause.join(', ')} : voir les lignes !! ci-dessus.`,
  )

  return morceaux.join('\n')
}

// ---------------------------------------------------------------------------
// Lecture des logs (UTF-16LE PowerShell + bruit NativeCommandError)
// ---------------------------------------------------------------------------

/**
 * lancer-job.ps1 ecrit ses logs avec le defaut de PowerShell 5.1 : UTF-16LE avec
 * BOM. Mais on ne lit que la FIN du fichier (les logs vont jusqu'a 5 Mo), donc le
 * BOM est souvent absent du buffer recu : d'ou la detection heuristique (en
 * UTF-16LE, un texte ASCII place un octet nul sur presque tous les rangs impairs).
 */
export function decoderTexteLog(buf: Buffer): string {
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8')
  return ressembleUtf16le(buf) ? buf.toString('utf16le') : buf.toString('utf8')
}

function ressembleUtf16le(buf: Buffer): boolean {
  const n = Math.min(buf.length, 1024)
  if (n < 4) return false
  let impairs = 0
  let nuls = 0
  for (let i = 1; i < n; i += 2) {
    impairs++
    if (buf[i] === 0) nuls++
  }
  return impairs > 0 && nuls / impairs > 0.6
}

/**
 * PowerShell 5.1 n'ecrit pas la stderr d'un process externe telle quelle : il
 * enveloppe chaque ligne dans un ErrorRecord, prefixe par "node : " et suivi de
 * quatre lignes de decor (position dans le script, soulignement ~~~, CategoryInfo,
 * FullyQualifiedErrorId: NativeCommandError). Tout console.warn du radar arrive
 * donc noye la-dedans dans les logs planifies - il faut le retirer avant de
 * chercher quoi que ce soit.
 */
export function nettoyerBruitPowershell(texte: string): string {
  const bruit = [
    /^\s*\+/, // "+ CategoryInfo", "+ FullyQualifiedErrorId", "+ ~~~~", "+ & $node ..."
    /^\s*(Au caract|At line:|Au niveau|At C:|Dans C:)/i, // en-tete de position, FR et EN
  ]
  return texte
    .split(/\r?\n/)
    .filter((l) => !bruit.some((r) => r.test(l)))
    // "node : [radar] telegram : ..." -> "[radar] telegram : ...". Le nom du process
    // est enumere plutot que devine par un motif large : PowerShell coupe aussi les
    // messages longs en plusieurs lignes, et une regle du type "<mot> : " decapiterait
    // la suite d'un message replie (ex: une ligne qui reprend a "terminee : ...").
    .map((l) => l.replace(/^\s*(node|node\.exe|powershell|powershell\.exe|pwsh)\s+:\s+/i, ''))
    .join('\n')
}

/**
 * Derniere ligne de fin de run trouvee dans la queue du log (index.ts journalise
 * `commande "<nom>" terminee : ...` a la fin de chaque commande). Les retours a la
 * ligne sont normalises AVANT la recherche : PowerShell coupe les messages longs
 * en plusieurs lignes, une recherche ligne par ligne les manquerait.
 */
export function dernierRunTermine(buf: Buffer): string | null {
  const texte = nettoyerBruitPowershell(decoderTexteLog(buf)).replace(/\s+/g, ' ')
  let debut = -1
  for (const m of texte.matchAll(/commande\s+"?[a-z]+"?\s+terminee/gi)) debut = m.index
  if (debut < 0) return null
  return texte.slice(debut, debut + 140).trim()
}

function lireQueue(chemin: string): Buffer {
  const fd = openSync(chemin, 'r')
  try {
    const taille = fstatSync(fd).size
    const brut = Math.max(0, taille - TAILLE_QUEUE_LOG)
    // Decalage pair obligatoire : couper au milieu d'une unite UTF-16LE decalerait
    // tout le reste du texte d'un octet et le rendrait illisible.
    const debut = brut % 2 === 0 ? brut : brut + 1
    const longueur = taille - debut
    const buf = Buffer.alloc(longueur)
    if (longueur > 0) readSync(fd, buf, 0, longueur, debut)
    return buf
  } finally {
    closeSync(fd)
  }
}

// ---------------------------------------------------------------------------
// Taches planifiees (Windows)
// ---------------------------------------------------------------------------

export interface TacheInfo {
  nom: string
  prochaine: string
  statut: string
  /** Horodatage du dernier declenchement tel qu'affiche par schtasks, brut. */
  dernierRun: string
  /** Code de sortie du dernier run, ou null si illisible. */
  dernierResultat: number | null
}

/**
 * Colonnes de `schtasks /query /fo csv /v`, reperees par POSITION et jamais par
 * nom : les en-tetes sont traduits selon la langue de Windows ("TaskName" ->
 * "NomTache"), l'ordre des colonnes, lui, ne change pas.
 */
const IDX_NOM = 1
const IDX_PROCHAINE = 2
const IDX_STATUT = 3
const IDX_DERNIER_RUN = 5
const IDX_RESULTAT = 6

function decouperCsv(ligne: string): string[] {
  const champs: string[] = []
  let courant = ''
  let dansGuillemets = false

  for (let i = 0; i < ligne.length; i++) {
    const c = ligne[i]
    if (dansGuillemets) {
      if (c === '"') {
        if (ligne[i + 1] === '"') {
          courant += '"'
          i++
        } else dansGuillemets = false
      } else courant += c
    } else if (c === '"') dansGuillemets = true
    else if (c === ',') {
      champs.push(courant)
      courant = ''
    } else courant += c
  }
  champs.push(courant)
  return champs
}

export function analyserTachesCsv(csv: string): TacheInfo[] {
  const taches: TacheInfo[] = []
  for (const ligne of csv.split(/\r?\n/)) {
    if (!ligne.trim()) continue
    const champs = decouperCsv(ligne)
    if (champs.length <= IDX_RESULTAT) continue

    const chemin = champs[IDX_NOM] ?? ''
    if (!chemin.includes('RiveskaRadar-')) continue

    const resultat = Number((champs[IDX_RESULTAT] ?? '').trim())
    taches.push({
      nom: chemin.split('\\').filter(Boolean).pop() ?? chemin,
      prochaine: (champs[IDX_PROCHAINE] ?? '').trim(),
      statut: (champs[IDX_STATUT] ?? '').trim(),
      dernierRun: (champs[IDX_DERNIER_RUN] ?? '').trim(),
      dernierResultat: Number.isFinite(resultat) ? resultat : null,
    })
  }
  return taches
}

/**
 * Sentinelles ecrites par schtasks dans la colonne "Last Run Time" d'une tache qui
 * ne s'est encore jamais declenchee : "N/A" selon la langue, ou la date plancher du
 * Planificateur (30/11/1999, affichee dans l'ordre local).
 */
const DERNIER_RUN_ABSENT = [/^n\s*\/?\s*a$/i, /^30[/-]11[/-]1999/, /^11[/-]30[/-]1999/, /^1999-11-30/]

/**
 * Vrai quand la tache est enregistree mais n'a jamais tourne : etat NORMAL des
 * premieres heures apres l'installation, et etat permanent d'une tache hebdomadaire
 * installee en milieu de semaine. Rien de ce qu'elle aurait du produire (son log,
 * en particulier) ne peut exister : ce n'est pas une panne, c'est une attente.
 */
export function jamaisDeclenchee(t: TacheInfo): boolean {
  if (t.dernierResultat === CODE_JAMAIS_DECLENCHEE) return true
  // Un run reussi ou en cours prime toujours sur une colonne "dernier run" douteuse :
  // mieux vaut manquer l'etat d'attente que contredire le reste du rapport.
  if (t.dernierResultat === 0 || tacheEnCours(t)) return false
  return t.dernierRun === '' || DERNIER_RUN_ABSENT.some((r) => r.test(t.dernierRun))
}

/** Vrai quand le Planificateur declare la tache en cours d'execution a cet instant. */
export function tacheEnCours(t: TacheInfo): boolean {
  return t.dernierResultat === CODE_EN_COURS || /running|en cours|s.ex[ée]cute/i.test(t.statut)
}

// ---------------------------------------------------------------------------
// Blocs
// ---------------------------------------------------------------------------

function ok(texte: string): Ligne {
  return { marqueur: 'OK', texte }
}
function ko(texte: string): Ligne {
  return { marqueur: '!!', texte }
}
function off(texte: string): Ligne {
  return { marqueur: '--', texte }
}

/**
 * Valide le .env exactement comme le fait un vrai run (parseConfig), et renvoie la
 * config si elle tient : sans elle, aucune verification reseau n'a de sens (on
 * n'aurait ni cle ni identifiant a tester), elles sont alors annoncees non faites
 * plutot que faussement vertes.
 */
export function analyserConfig(
  env: Record<string, string | undefined>,
  envPresent: boolean,
  cheminEnv: string,
): { bloc: Bloc; cfg: Config | null } {
  const lignes: Ligne[] = []
  let cfg: Config | null = null

  if (!envPresent) {
    lignes.push(
      ko(
        `fichier .env introuvable (${cheminEnv}) - copier .env.example puis le remplir ` +
          `(README > "Ou obtenir chaque identifiant")`,
      ),
    )
  }

  try {
    cfg = parseConfig(env)
  } catch (err) {
    const issues = (err as { issues?: { path?: (string | number | symbol)[]; message?: string }[] }).issues
    if (Array.isArray(issues) && issues.length > 0) {
      for (const i of issues) {
        const variable = i.path?.join('.') || '(inconnue)'
        lignes.push(ko(`${variable} : ${i.message ?? 'valeur refusee'}`))
      }
      lignes.push(ko('corriger ces variables dans .env, aucun run ne peut demarrer sans elles'))
    } else {
      lignes.push(ko(`configuration illisible - ${err instanceof Error ? err.message : String(err)}`))
    }
    return { bloc: { titre: 'Configuration', lignes }, cfg: null }
  }

  if (envPresent) lignes.push(ok('.env charge, toutes les variables obligatoires sont valides'))
  lignes.push(
    ok(
      `reglages : score min ${cfg.scoreThreshold}, age max ${cfg.maxPostAgeDays} j, ` +
        `retention ${cfg.retentionDays} j, modele ${cfg.openrouterModel}`,
    ),
  )

  if (!cfg.redditClientId || !cfg.redditClientSecret || !cfg.redditUserAgent) {
    lignes.push(off("Reddit OAuth desactive (API fermee cote Reddit) - la collecte Reddit passe par search.rss, c'est normal"))
  }
  if (!cfg.blueskyId || !cfg.blueskyAppPassword) {
    lignes.push(off('Bluesky desactive (BLUESKY_ID/BLUESKY_APP_PASSWORD absents) - source facultative, les autres continuent'))
  }

  return { bloc: { titre: 'Configuration', lignes }, cfg }
}

function blocSheet(etat: EtatSheet | null, cfg: Config | null, maintenant: Date): Bloc {
  const lignes: Ligne[] = []

  if (!cfg || !etat) {
    lignes.push(off('non verifie : la configuration doit etre corrigee d abord'))
    return { titre: 'Google Sheets', lignes }
  }

  if (etat.ongletTrouve === false) {
    lignes.push(
      ko(
        `onglet "${cfg.sheetTab}" absent du Sheet - le creer dans le classeur, ` +
          `ou corriger SHEET_TAB dans .env`,
      ),
    )
    return { titre: 'Google Sheets', lignes }
  }

  if (!etat.ok) {
    const code = etat.code ?? '?'
    if (code === 403 || code === '403') {
      lignes.push(
        ko(
          `Sheet inaccessible (403) - partager le Sheet en acces Editeur avec ${cfg.googleSaEmail}, ` +
            `et verifier que l'API Google Sheets est activee sur le projet Google Cloud`,
        ),
      )
    } else if (code === 401 || code === '401') {
      lignes.push(
        ko(
          `Sheet inaccessible (401) - cle de compte de service refusee : regenerer une cle JSON ` +
            `(IAM > Comptes de service) et recopier GOOGLE_SA_EMAIL/GOOGLE_SA_PRIVATE_KEY dans .env`,
        ),
      )
    } else if (code === 404 || code === '404') {
      lignes.push(
        ko(
          `Sheet introuvable (404) - SHEET_ID doit etre l'identifiant present dans l'URL du Sheet ` +
            `(docs.google.com/spreadsheets/d/<SHEET_ID>/edit), pas son nom`,
        ),
      )
    } else {
      lignes.push(
        ko(
          `Sheet inaccessible (${code})${etat.message ? ` - ${etat.message}` : ''} - verifier la connexion ` +
            `reseau de la machine, puis relancer sante`,
        ),
      )
    }
    return { titre: 'Google Sheets', lignes }
  }

  const n = etat.lignes ?? 0
  const dernier = etat.dernierProspect
    ? `dernier il y a ${formaterAge(maintenant.getTime() - etat.dernierProspect.getTime())}`
    : 'aucune date exploitable'
  lignes.push(ok(`Sheet accessible, onglet "${cfg.sheetTab}" present : ${n} prospect(s), ${dernier}`))
  return { titre: 'Google Sheets', lignes }
}

function blocTelegram(
  etat: EtatTelegram | null,
  notifDemandee: boolean,
  notifEnvoyee: boolean | null,
  cfg: Config | null,
): Bloc {
  const lignes: Ligne[] = []

  if (!cfg || !etat) {
    lignes.push(off('non verifie : la configuration doit etre corrigee d abord'))
    return { titre: 'Telegram', lignes }
  }

  if (etat.ok) {
    lignes.push(ok(`bot ${etat.nom ? `@${etat.nom} ` : ''}joignable (getMe)`))
  } else if (etat.code === 401) {
    lignes.push(
      ko(
        `bot Telegram refuse (401) - TELEGRAM_BOT_TOKEN invalide ou revoque : en regenerer un ` +
          `aupres de @BotFather et le recopier dans .env`,
      ),
    )
  } else {
    lignes.push(
      ko(
        `bot Telegram injoignable${etat.code ? ` (${etat.code})` : ''}` +
          `${etat.message ? ` - ${etat.message}` : ''} - verifier la connexion reseau de la machine`,
      ),
    )
  }

  if (!notifDemandee) {
    lignes.push(off("aucun message envoye (choix par defaut) - ajouter --notif pour un envoi de test reel"))
  } else if (notifEnvoyee) {
    lignes.push(ok(`message de test envoye au chat ${cfg.telegramChatId}`))
  } else {
    lignes.push(
      ko(
        `message de test refuse - verifier TELEGRAM_CHAT_ID (${cfg.telegramChatId}) et envoyer d'abord ` +
          `un message au bot depuis ce chat (l'API Telegram l'exige avant tout envoi)`,
      ),
    )
  }

  return { titre: 'Telegram', lignes }
}

function blocOpenrouter(etat: EtatOpenrouter | null, cfg: Config | null): Bloc {
  const lignes: Ligne[] = []

  if (!cfg || !etat) {
    lignes.push(off('non verifie : la configuration doit etre corrigee d abord'))
    return { titre: 'OpenRouter', lignes }
  }

  if (!etat.ok) {
    if (etat.code === 401 || etat.code === 403) {
      lignes.push(
        ko(
          `cle refusee (${etat.code}) - OPENROUTER_API_KEY invalide ou revoquee : en creer une sur ` +
            `openrouter.ai/keys. Sans elle le scoring s'arrete, la collecte continue a tourner pour rien`,
        ),
      )
    } else {
      lignes.push(
        ko(
          `OpenRouter injoignable${etat.code ? ` (${etat.code})` : ''}` +
            `${etat.message ? ` - ${etat.message}` : ''} - verifier la connexion reseau, puis relancer sante`,
        ),
      )
    }
    return { titre: 'OpenRouter', lignes }
  }

  if (typeof etat.restant === 'number') {
    if (etat.restant <= SEUIL_CREDIT_BAS) {
      lignes.push(
        ko(
          `credit presque epuise : ${etat.restant} $ restants - recharger sur openrouter.ai/credits. ` +
            `A zero, le scoring s'arrete alors que la collecte continue : plus aucun prospect n'arrive au Sheet`,
        ),
      )
    } else {
      lignes.push(ok(`cle valide - credit restant : ${etat.restant} $`))
    }
  } else {
    lignes.push(ok("cle valide - credit restant non expose par l'API (compte sans plafond)"))
  }

  return { titre: 'OpenRouter', lignes }
}

function blocDb(d: DepsSante, maintenant: Date): Bloc {
  const lignes: Ligne[] = []

  if (!existsSync(d.cheminDb)) {
    lignes.push(off(`base locale absente (${d.cheminDb}) - normale avant le premier run, elle se cree toute seule`))
    return { titre: 'Base locale', lignes }
  }

  let stats: StatsDbSante
  try {
    stats = d.statsDb(d.cheminDb)
  } catch (err) {
    lignes.push(
      ko(
        `base locale illisible - ${err instanceof Error ? err.message : String(err)}. ` +
          `Si elle est corrompue, la supprimer suffit (elle se reconstruit ; seul l'historique de ` +
          `deduplication est perdu, le Sheet n'est pas touche)`,
      ),
    )
    return { titre: 'Base locale', lignes }
  }

  const dernier = stats.dernierAjout
    ? `dernier ajout il y a ${formaterAge(maintenant.getTime() - stats.dernierAjout.getTime())}`
    : 'aucun post enregistre'
  lignes.push(ok(`base lisible : ${stats.posts} post(s) vu(s), ${dernier}`))

  if (stats.enAttenteRetry > 0) {
    lignes.push(
      ok(`${stats.enAttenteRetry} post(s) en echec technique, nouvelle tentative automatique au prochain run`),
    )
  }
  if (stats.abandonsRecents > 0) {
    lignes.push(
      ko(
        `${stats.abandonsRecents} abandon(s) definitif(s) ces 7 derniers jours (3 echecs a la meme etape) - ` +
          `leur URL a ete notifiee sur Telegram : les rattraper a la main, et chercher la cause dans les logs`,
      ),
    )
  } else if (stats.abandons > 0) {
    lignes.push(ok(`${stats.abandons} abandon(s) definitif(s) plus anciens que 7 jours (historique)`))
  }

  return { titre: 'Base locale', lignes }
}

interface ContenuVerrou {
  pid: number
  horodatage: number
}

function lireVerrou(chemin: string): ContenuVerrou | null {
  try {
    const brut: unknown = JSON.parse(readFileSync(chemin, 'utf8'))
    if (
      typeof brut === 'object' &&
      brut !== null &&
      typeof (brut as ContenuVerrou).pid === 'number' &&
      typeof (brut as ContenuVerrou).horodatage === 'number'
    ) {
      return brut as ContenuVerrou
    }
  } catch {
    // Illisible : traite comme un verrou corrompu ci-dessous.
  }
  return null
}

/** Verrou present sur le disque, deja interprete : lu une seule fois, exploite deux fois. */
interface EtatVerrou {
  commande: CommandeSurveillee
  /** null = fichier illisible ou corrompu. */
  contenu: ContenuVerrou | null
  /** Duree ecoulee depuis la pose du verrou, donc depuis le debut du run. */
  age: number
  /** true = le process qui l'a pose tourne toujours, un run est donc reellement en cours. */
  vivant: boolean
}

/**
 * Lit tous les *.lock une bonne fois. Le bloc Verrous les met en forme, le bloc Logs
 * s'en sert pour savoir quels runs tournent encore : les deux doivent raconter la
 * meme chose, ils partent donc de la meme lecture.
 */
function lireVerrous(d: DepsSante, maintenant: Date): EtatVerrou[] {
  const etats: EtatVerrou[] = []

  for (const commande of COMMANDES_SURVEILLEES) {
    const chemin = path.join(d.racine, `${commande}.lock`)
    if (!existsSync(chemin)) continue

    const contenu = lireVerrou(chemin)
    etats.push({
      commande,
      contenu,
      age: contenu ? maintenant.getTime() - contenu.horodatage : 0,
      vivant: contenu !== null && processVivant(contenu.pid),
    })
  }

  return etats
}

function blocVerrou(verrous: EtatVerrou[]): Bloc {
  const lignes: Ligne[] = []

  for (const { commande, contenu, age, vivant } of verrous) {
    if (!contenu) {
      lignes.push(
        ko(
          `${commande}.lock illisible - sera juge perime et remplace au prochain lancement, ` +
            `aucune action necessaire`,
        ),
      )
      continue
    }

    if (!vivant) {
      lignes.push(
        ko(
          `${commande}.lock laisse par un process disparu (pid ${contenu.pid}, il y a ${formaterAge(age)}) - ` +
            `un run s'est interrompu : il sera ignore automatiquement au prochain lancement, rien a supprimer ` +
            `a la main, mais chercher la cause dans logs/${commande}.log`,
        ),
      )
    } else if (age > SEUIL_VERROU_SUSPECT_MS) {
      lignes.push(
        ko(
          `run "${commande}" en cours depuis ${formaterAge(age)} (verrou ${commande}.lock) - anormalement long : lire ` +
            `logs/${commande}.log (un run reddit dure au plus ~12 min, un run radar quelques minutes)`,
        ),
      )
    } else {
      lignes.push(ok(`run "${commande}" en cours depuis ${formaterAge(age)} (verrou normal, rien a faire)`))
    }
  }

  if (lignes.length === 0) lignes.push(ok('aucun verrou : aucun run en cours'))
  return { titre: 'Verrous', lignes }
}

function blocTaches(taches: TacheInfo[] | null, plateforme: string): Bloc {
  const lignes: Ligne[] = []

  if (plateforme !== 'win32') {
    lignes.push(off(`taches planifiees non verifiees : Planificateur Windows uniquement (ici ${plateforme})`))
    return { titre: 'Taches planifiees', lignes }
  }
  if (taches === null) {
    lignes.push(off('schtasks n a pas repondu - taches planifiees non verifiees'))
    return { titre: 'Taches planifiees', lignes }
  }

  if (taches.length === 0) {
    lignes.push(
      off(
        `aucune tache RiveskaRadar-* enregistree sur cette machine - normal hors du mini PC de production ; ` +
          `pour l'installer : scripts/installer-taches.ps1 dans un PowerShell administrateur`,
      ),
    )
    return { titre: 'Taches planifiees', lignes }
  }

  for (const commande of COMMANDES_SURVEILLEES) {
    const nom = NOM_TACHE[commande]
    const tache = taches.find((t) => t.nom === nom)

    if (!tache) {
      lignes.push(
        ko(
          `${nom} absente du Planificateur alors que les autres y sont - relancer ` +
            `scripts/installer-taches.ps1 dans un PowerShell administrateur`,
        ),
      )
      continue
    }

    if (/disab|desactiv|désactiv/i.test(tache.statut)) {
      lignes.push(ko(`${nom} DESACTIVEE dans le Planificateur - la reactiver, sinon ce job ne tournera plus jamais`))
      continue
    }

    const prochaine = tache.prochaine ? `, prochaine ${tache.prochaine}` : ''
    if (tache.dernierResultat === 0) {
      lignes.push(ok(`${nom} : dernier run reussi${prochaine}`))
    } else if (jamaisDeclenchee(tache)) {
      lignes.push(ok(`${nom} : jamais declenchee pour l'instant (normal juste apres l'installation)${prochaine}`))
    } else if (tacheEnCours(tache)) {
      lignes.push(ok(`${nom} : en cours d'execution${prochaine}`))
    } else {
      lignes.push(
        ko(
          `${nom} : dernier resultat ${tache.dernierResultat} (echec) - lire logs/${commande}.log, ` +
            `puis schtasks /query /tn ${nom} /v /fo list pour le detail`,
        ),
      )
    }
  }

  return { titre: 'Taches planifiees', lignes }
}

/** Run reellement en cours au moment ou sante s'execute. */
interface RunEnCours {
  /** Duree ecoulee depuis le debut du run, ou null quand seul le Planificateur le signale. */
  depuis: number | null
  source: 'verrou' | 'planificateur'
}

/**
 * Ce que sante sait DEJA de l'etat courant quand elle attaque le bloc Logs. Sans ce
 * recoupement, elle concluait a la panne sur des etats que ses propres blocs Verrous
 * et Taches declaraient normaux dans la meme sortie : un run en cours n'a pas encore
 * ecrit sa ligne de fin, et une tache jamais declenchee n'a pas encore de log.
 */
interface ContexteLogs {
  enCours: Map<CommandeSurveillee, RunEnCours>
  /** Taches enregistrees qui ne se sont encore jamais declenchees : etat d'attente. */
  enAttente: Set<CommandeSurveillee>
}

function construireContexteLogs(verrous: EtatVerrou[], taches: TacheInfo[] | null): ContexteLogs {
  const enCours = new Map<CommandeSurveillee, RunEnCours>()
  const enAttente = new Set<CommandeSurveillee>()

  // Le verrou est la meilleure source : il date le debut du run.
  for (const v of verrous) {
    if (v.vivant) enCours.set(v.commande, { depuis: v.age, source: 'verrou' })
  }

  if (taches) {
    for (const commande of COMMANDES_SURVEILLEES) {
      const tache = taches.find((t) => t.nom === NOM_TACHE[commande])
      if (!tache) continue
      if (tacheEnCours(tache) && !enCours.has(commande)) {
        enCours.set(commande, { depuis: null, source: 'planificateur' })
      }
      if (jamaisDeclenchee(tache)) enAttente.add(commande)
    }
  }

  return { enCours, enAttente }
}

function blocLogs(d: DepsSante, maintenant: Date, ctx: ContexteLogs): Bloc {
  const lignes: Ligne[] = []
  const dossier = path.join(d.racine, 'logs')

  if (!existsSync(dossier)) {
    lignes.push(
      off(
        `aucun dossier logs/ - il n'existe que sur la machine qui execute les taches planifiees ` +
          `(les lancements manuels ecrivent dans la console)`,
      ),
    )
    return { titre: 'Logs', lignes }
  }

  const presents = new Set(readdirSync(dossier))

  for (const commande of COMMANDES_SURVEILLEES) {
    const fichier = `${commande}.log`
    const chemin = path.join(dossier, fichier)
    const enCours = ctx.enCours.get(commande)
    const enAttente = ctx.enAttente.has(commande)

    if (!presents.has(fichier)) {
      // Une tache qui ne s'est jamais declenchee n'a rien pu ecrire : c'est une
      // attente, pas une panne. Le bloc Taches affiche deja sa prochaine echeance.
      lignes.push(
        enAttente
          ? off(
              `logs/${fichier} pas encore cree - ${NOM_TACHE[commande]} ne s'est jamais declenchee pour ` +
                `l'instant, son log apparaitra a son premier run`,
            )
          : ko(
              `logs/${fichier} absent alors que d'autres logs existent - ${NOM_TACHE[commande]} n'a jamais rien ` +
                `ecrit : verifier qu'elle est bien enregistree (schtasks /query /tn ${NOM_TACHE[commande]})`,
            ),
      )
      continue
    }

    const age = maintenant.getTime() - statSync(chemin).mtime.getTime()
    const cadence = CADENCE_MS[commande]

    // La fraicheur reste le signal le plus utile - c'est lui qui revele une tache qui
    // a cesse de se declencher - mais elle ne veut rien dire tant que la tache n'a pas
    // eu son premier declenchement : le log date alors d'un lancement manuel.
    if (!enAttente && age > cadence * TOLERANCE_LOG) {
      lignes.push(
        ko(
          `logs/${fichier} fige depuis ${formaterAge(age)} alors que ce job tourne toutes les ` +
            `${formaterAge(cadence)} - la tache ne se declenche plus : verifier ${NOM_TACHE[commande]} ` +
            `dans le Planificateur (etat, compte d'execution, machine en veille ?)`,
        ),
      )
      continue
    }

    const fin = dernierRunTermine(lireQueue(chemin))
    if (fin === null) {
      // Pas de ligne de fin parce que le run n'est pas fini : le verrou ou le
      // Planificateur le disent en cours dans cette meme sortie.
      if (enCours) {
        const depuis =
          enCours.depuis === null
            ? `(${NOM_TACHE[commande]} en cours d'execution dans le Planificateur)`
            : `depuis ${formaterAge(enCours.depuis)} (verrou ${commande}.lock)`
        lignes.push(
          ok(
            `logs/${fichier} ecrit il y a ${formaterAge(age)} - run "${commande}" en cours ${depuis} : ` +
              `sa ligne de fin s'ecrira a la fin du run`,
          ),
        )
        continue
      }
      lignes.push(
        ko(
          `logs/${fichier} ecrit il y a ${formaterAge(age)} mais sans aucune fin de run dans sa fin de ` +
            `fichier - le dernier run s'est probablement interrompu : lire logs/${fichier}`,
        ),
      )
      continue
    }

    lignes.push(ok(`logs/${fichier} ecrit il y a ${formaterAge(age)} - ${fin}`))
  }

  return { titre: 'Logs', lignes }
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Enchaine les huit verifications et rend un rapport pret a afficher.
 * Les quatre verifications lentes (Sheet, Telegram, OpenRouter, schtasks) partent
 * EN PARALLELE : chacune porte son propre delai d'attente court, pour qu'une
 * source bloquee n'immobilise jamais la commande entiere. Les lectures locales
 * (base, verrous, logs) sont synchrones et instantanees.
 */
export async function executerSante(d: DepsSante): Promise<ResultatSante> {
  const maintenant = d.maintenant ?? new Date()
  const plateforme = d.plateforme ?? process.platform
  const cheminEnv = path.join(d.racine, '.env')

  const { bloc: blocConfig, cfg } = analyserConfig(d.env, existsSync(cheminEnv), cheminEnv)

  const optsSheets: OptionsSheets | null = cfg
    ? { email: cfg.googleSaEmail, clePrivee: cfg.googleSaPrivateKey, sheetId: cfg.sheetId, onglet: cfg.sheetTab }
    : null
  const optsTelegram: OptionsTelegram | null = cfg
    ? { token: cfg.telegramBotToken, chatId: cfg.telegramChatId }
    : null

  const [sheet, telegram, openrouter, csvTaches, notifEnvoyee] = await Promise.all([
    optsSheets ? d.verifierSheet(optsSheets) : Promise.resolve(null),
    optsTelegram ? d.verifierTelegram(optsTelegram) : Promise.resolve(null),
    cfg ? d.verifierOpenrouter(cfg.openrouterApiKey) : Promise.resolve(null),
    plateforme === 'win32' ? d.lireTaches() : Promise.resolve(null),
    d.notif && optsTelegram ? d.envoyerTest(optsTelegram) : Promise.resolve(null),
  ])

  // Verrous et taches sont lus une seule fois : les blocs Verrous, Taches et Logs
  // doivent raconter le meme etat, ils partent donc des memes donnees.
  const verrous = lireVerrous(d, maintenant)
  const taches = csvTaches === null ? null : analyserTachesCsv(csvTaches)
  const contexteLogs = construireContexteLogs(verrous, taches)

  const blocs: Bloc[] = [
    blocConfig,
    blocSheet(sheet, cfg, maintenant),
    blocTelegram(telegram, d.notif, notifEnvoyee, cfg),
    blocOpenrouter(openrouter, cfg),
    blocDb(d, maintenant),
    blocVerrou(verrous),
    blocTaches(taches, plateforme),
    blocLogs(d, maintenant, contexteLogs),
  ]

  return { blocs, rapport: formaterRapport(blocs, maintenant), ok: !aUnProbleme(blocs) }
}
