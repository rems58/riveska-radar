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
import { acquerirVerrou, libererVerrou } from './verrou.ts'

// La base, le .env et les verrous vivent a cote du projet (src/.. = racine de
// riveska-radar/), pas dans un dossier temporaire ni relativement au repertoire
// courant : le Planificateur de taches peut lancer node depuis n'importe ou.
const RACINE = path.join(import.meta.dirname, '..')
const CHEMIN_DB = path.join(RACINE, 'radar.db')
const CHEMIN_ENV = path.join(RACINE, '.env')

// Duree au-dela de laquelle un verrou est considere perime meme si son process
// semble encore vivant (garde-fou contre un PID recycle par l'OS apres un crash).
// Tres large par rapport a la duree normale d'un run : ~40 appels Reddit sequentiels
// + jusqu'a 2 appels LLM par candidat peuvent legitimement prendre plusieurs minutes.
const DUREE_MAX_VERROU_MS = 20 * 60 * 1000

/**
 * Charge le fichier .env a la racine du projet dans process.env. Node ne le fait
 * jamais de lui-meme (contrairement a la croyance repandue) : sans cet appel,
 * getConfig() ne voit jamais les variables du .env et zod echoue avec un message
 * qui ressemble a une mauvaise configuration alors que le fichier est correct.
 *
 * - Un .env absent (chemin par defaut) n'est PAS une erreur : on poursuit et laisse
 *   la validation zod de getConfig() expliquer precisement ce qui manque.
 * - Une variable deja presente dans process.env (lancement manuel, CI, tache
 *   planifiee avec des variables d'environnement systeme) n'est jamais ecrasee :
 *   c'est le comportement natif de process.loadEnvFile, documente ici pour que ce
 *   ne soit pas une surprise silencieuse.
 */
export function chargerEnv(chemin: string = CHEMIN_ENV): void {
  try {
    process.loadEnvFile(chemin)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code
    if (code === 'ENOENT') return
    console.warn(
      `[radar] .env : echec de lecture de ${chemin} - ${err instanceof Error ? err.message : String(err)}`,
    )
  }
}

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

function cheminVerrou(commande: string): string {
  return path.join(RACINE, `${commande}.lock`)
}

async function main(): Promise<void> {
  const commande = process.argv[2]
  const executer = commande ? COMMANDES[commande] : undefined

  if (!commande || !executer) {
    console.error(
      `[radar] usage : node src/index.ts <${Object.keys(COMMANDES).join('|')}>` +
        (commande ? ` (commande inconnue : "${commande}")` : ''),
    )
    process.exitCode = 1
    return
  }

  chargerEnv()

  // Le Planificateur relance radar toutes les 15 minutes sans verifier si le run
  // precedent est termine. Un chevauchement ferait scorer/facturer deux fois les
  // memes posts (marquerVu n'intervient qu'apres scoring+enrichissement+ecriture).
  const verrou = cheminVerrou(commande)
  if (!acquerirVerrou(verrou, DUREE_MAX_VERROU_MS)) {
    console.warn(
      `[radar] commande "${commande}" ignoree : un run est deja en cours (verrou ${verrou}).`,
    )
    return
  }

  try {
    await executer()
  } catch (err) {
    const raison = err instanceof Error ? (err.stack ?? err.message) : String(err)
    console.error(`[radar] commande "${commande}" a echoue : ${raison}`)
    process.exitCode = 1
  } finally {
    libererVerrou(verrou)
  }
}

// Ne se declenche que lorsque ce fichier est execute directement (node src/index.ts ...),
// jamais quand un test l'importe : process.argv[1] pointe alors vers le runner de test,
// pas vers src/index.ts, donc les URL ne correspondent pas.
const cheminExecute = process.argv[1] ? pathToFileURL(process.argv[1]).href : ''
if (import.meta.url === cheminExecute) {
  void main()
}
