import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { getConfig } from './config.ts'
import { ouvrirDb } from './db.ts'
import type { RadarDb } from './db.ts'
import { collecterTout, collecteursParDefaut } from './collectors/index.ts'
import { recupererJson } from './collectors/http.ts'
import { noterPost } from './enrich/score.ts'
import { enrichirPost } from './enrich/draft.ts'
import { assurerEnTetes, ajouterLignes } from './sinks/sheets.ts'
import type { OptionsSheets } from './sinks/sheets.ts'
import { formaterProspect, envoyerTelegram } from './sinks/telegram.ts'
import type { OptionsTelegram } from './sinks/telegram.ts'
import { lireStatutsDepuis } from './sinks/sheets-lecture.ts'
import { executerRadar } from './jobs/radar.ts'
import { executerRecheck } from './jobs/recheck.ts'
import { executerTriggers } from './jobs/triggers.ts'
import { executerWeekly } from './jobs/weekly.ts'

// La base vit a cote du projet (src/.. = racine de riveska-radar/), pas dans un
// dossier temporaire : elle doit survivre entre deux executions planifiees.
const CHEMIN_DB = path.join(import.meta.dirname, '..', 'radar.db')

let dbPartagee: RadarDb | null = null

/** Une seule connexion SQLite par process, ouverte a la demande. */
function db(): RadarDb {
  if (!dbPartagee) dbPartagee = ouvrirDb(CHEMIN_DB)
  return dbPartagee
}

function optionsTelegram(): OptionsTelegram {
  const cfg = getConfig()
  return { token: cfg.telegramBotToken, chatId: cfg.telegramChatId }
}

function optionsSheets(): OptionsSheets {
  const cfg = getConfig()
  return { email: cfg.googleSaEmail, clePrivee: cfg.googleSaPrivateKey, sheetId: cfg.sheetId, onglet: cfg.sheetTab }
}

function notifierTelegram(texte: string): Promise<boolean> {
  return envoyerTelegram(texte, optionsTelegram())
}

interface ReponseListing {
  data?: { children?: unknown }
}

/**
 * Compte les reponses (commentaires) d'un post via l'endpoint JSON public de Reddit.
 * Les prospects viennent aussi de HN, Stack Overflow, Bluesky, Mastodon et de forums RSS :
 * seules les URL Reddit sont geree ici, tout le reste renvoie -1 (inconnu, pas une erreur).
 * Ne leve jamais : recupererJson (couche http commune) ne leve jamais non plus.
 */
async function compterReponses(url: string): Promise<number> {
  if (!/^https:\/\/(www\.)?reddit\.com\//.test(url)) {
    console.warn(`[radar] recheck : url non-Reddit, comptage de reponses non gere (${url})`)
    return -1
  }

  const cfg = getConfig()
  const donnees = await recupererJson<unknown>({
    source: 'recheck-reddit',
    url: `${url}.json`,
    init: { headers: { 'User-Agent': cfg.redditUserAgent } },
  })

  if (!Array.isArray(donnees) || donnees.length < 2) return -1
  const commentaires = (donnees[1] as ReponseListing | undefined)?.data?.children
  if (!Array.isArray(commentaires)) return -1
  return commentaires.length
}

async function commandeRadar(): Promise<void> {
  const cfg = getConfig()
  const opts = optionsSheets()
  await assurerEnTetes(opts)

  const resultat = await executerRadar({
    db: db(),
    collecter: () => collecterTout(collecteursParDefaut()),
    noter: (p, apparitions) =>
      noterPost(p, { cle: cfg.openrouterApiKey, modele: cfg.openrouterModel, apparitionsPrecedentes: apparitions }),
    enrichir: (p) => enrichirPost(p, { cle: cfg.openrouterApiKey, modele: cfg.openrouterModel }),
    ecrireSheet: (posts) => ajouterLignes(posts, opts),
    notifier: (p, ligne) => envoyerTelegram(formaterProspect(p, ligne), optionsTelegram()),
    seuil: cfg.scoreThreshold,
    ageMaxJours: cfg.maxPostAgeDays,
    retentionJours: cfg.retentionDays,
  })

  console.log('[radar] commande "radar" terminee :', resultat)
}

async function commandeRecheck(): Promise<void> {
  const resultat = await executerRecheck({
    db: db(),
    compterReponses,
    notifier: notifierTelegram,
  })

  console.log('[radar] commande "recheck" terminee :', resultat)
}

async function commandeTriggers(): Promise<void> {
  const resultat = await executerTriggers({
    db: db(),
    notifier: notifierTelegram,
  })

  console.log('[radar] commande "triggers" terminee :', resultat)
}

async function commandeWeekly(): Promise<void> {
  const opts = optionsSheets()
  const resultat = await executerWeekly({
    db: db(),
    lireStatuts: (depuis) => lireStatutsDepuis(depuis, opts),
    notifier: notifierTelegram,
  })

  console.log('[radar] commande "weekly" terminee :', resultat)
}

/**
 * Les quatre jobs, exposes par nom pour le CLI et pour les tests.
 * Construire cet objet n'appelle getConfig() nulle part : chaque commande ne lit
 * la config qu'a son execution reelle, pour qu'un simple import du module (les
 * tests) ne leve jamais en l'absence de .env.
 */
export const COMMANDES: Record<string, () => Promise<void>> = {
  radar: commandeRadar,
  recheck: commandeRecheck,
  triggers: commandeTriggers,
  weekly: commandeWeekly,
}

async function main(): Promise<void> {
  const commande = process.argv[2]
  const executer = commande ? COMMANDES[commande] : undefined

  if (!executer) {
    console.error(
      `[radar] usage : node src/index.ts <${Object.keys(COMMANDES).join('|')}>` +
        (commande ? ` (commande inconnue : "${commande}")` : ''),
    )
    process.exitCode = 1
    return
  }

  try {
    await executer()
  } catch (err) {
    const raison = err instanceof Error ? (err.stack ?? err.message) : String(err)
    console.error(`[radar] commande "${commande}" a echoue : ${raison}`)
    process.exitCode = 1
  }
}

// Ne se declenche que lorsque ce fichier est execute directement (node src/index.ts ...),
// jamais quand un test l'importe : process.argv[1] pointe alors vers le runner de test,
// pas vers src/index.ts, donc les URL ne correspondent pas.
const cheminExecute = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === cheminExecute) {
  void main()
}
