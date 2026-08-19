import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { getConfig } from './config.ts'
import { ouvrirDb } from './db.ts'
import type { RadarDb } from './db.ts'
import { collecterTout, collecteursParDefaut, avertirSourceVide } from './collectors/index.ts'
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
import { compterReponses } from './jobs/recheck-compteurs.ts'
import { acquerirVerrou, libererVerrou, rafraichirVerrou } from './verrou.ts'

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

// Nettement plus court que DUREE_MAX_VERROU_MS : un run legitime qui depasse 20 min
// (LLM lent) ne doit jamais se faire evincer par un nouvel appelant tant qu'il
// rafraichit periodiquement son verrou (voir verrou.ts, Fix 6).
const INTERVALLE_RAFRAICHISSEMENT_VERROU_MS = 5 * 60 * 1000

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

async function commandeRadar(): Promise<void> {
  const cfg = getConfig()
  const opts = optionsSheets()
  await assurerEnTetes(opts)

  const resultat = await executerRadar({
    db: db(),
    collecter: () =>
      collecterTout(collecteursParDefaut(), (nom) => {
        // Journalise (comportement par defaut) ET persiste, pour que le bilan
        // hebdomadaire puisse signaler une source restee muette plusieurs jours,
        // pas seulement le run courant.
        avertirSourceVide(nom)
        db().enregistrerSourceVide(nom)
      }),
    noter: (p, apparitions) =>
      noterPost(p, { cle: cfg.openrouterApiKey, modele: cfg.openrouterModel, apparitionsPrecedentes: apparitions }),
    enrichir: (p) => enrichirPost(p, { cle: cfg.openrouterApiKey, modele: cfg.openrouterModel }),
    ecrireSheet: (posts) => ajouterLignes(posts, opts),
    notifier: (p, ligne) => envoyerTelegram(formaterProspect(p, ligne), optionsTelegram()),
    notifierTexte: notifierTelegram,
    seuil: cfg.scoreThreshold,
    ageMaxJours: cfg.maxPostAgeDays,
    retentionJours: cfg.retentionDays,
  })

  console.log('[radar] commande "radar" terminee :', resultat)
}

async function commandeRecheck(): Promise<void> {
  const cfg = getConfig()
  const resultat = await executerRecheck({
    db: db(),
    compterReponses: (url) => compterReponses(url, { redditUserAgent: cfg.redditUserAgent }),
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

const SEPT_JOURS_MS = 7 * 24 * 3600 * 1000

async function commandeWeekly(): Promise<void> {
  const opts = optionsSheets()
  const resultat = await executerWeekly({
    db: db(),
    lireStatuts: (depuis) => lireStatutsDepuis(depuis, opts),
    notifier: notifierTelegram,
  })

  // Garde-fou "source vide" (collectors/index.ts) : signale dans le bilan hebdo une
  // source restee muette plusieurs jours de suite, pas seulement journalisee en console
  // (que personne ne lit sur un mini PC sans surveillance). Message separe pour ne pas
  // toucher le format deja teste de executerWeekly/formaterStats.
  const sourcesVides = db().compterSourcesVidesDepuis(new Date(Date.now() - SEPT_JOURS_MS))
  const entrees = Object.entries(sourcesVides)
  if (entrees.length > 0) {
    const detail = entrees.map(([nom, n]) => `${nom} (${n}x)`).join(', ')
    await notifierTelegram(`Sources muettes cette semaine (0 post alors que d'autres en ont renvoye) : ${detail}`)
  }

  console.log('[radar] commande "weekly" terminee :', resultat, '| sources vides:', sourcesVides)
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

  // .unref() : ce timer ne doit jamais, a lui seul, maintenir le process eveille -
  // le clearInterval du finally est le chemin normal, ceci est un filet de securite.
  const rafraichissement = setInterval(
    () => rafraichirVerrou(verrou),
    INTERVALLE_RAFRAICHISSEMENT_VERROU_MS,
  ).unref()

  try {
    await executer()
  } catch (err) {
    const raison = err instanceof Error ? (err.stack ?? err.message) : String(err)
    console.error(`[radar] commande "${commande}" a echoue : ${raison}`)
    process.exitCode = 1
  } finally {
    clearInterval(rafraichissement)
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
