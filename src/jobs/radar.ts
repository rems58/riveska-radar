import type { RawPost, ScoredPost, EnrichedPost } from '../types.ts'
import type { RadarDb } from '../db.ts'
import { MAX_ECHECS_TECHNIQUES } from '../db.ts'
import { prefiltrer } from '../filter/prefilter.ts'

const DELAI_RECHECK_MS = 48 * 3600 * 1000

export interface DepsRadar {
  db: RadarDb
  collecter: () => Promise<RawPost[]>
  noter: (p: RawPost, apparitions: number) => Promise<ScoredPost | null>
  enrichir: (p: ScoredPost) => Promise<EnrichedPost | null>
  ecrireSheet: (posts: EnrichedPost[]) => Promise<number | null>
  notifier: (p: EnrichedPost, ligne: number | null) => Promise<boolean>
  /**
   * Notification texte simple (meme forme que jobs/recheck.ts et jobs/triggers.ts),
   * utilisee uniquement quand un post est ABANDONNE definitivement (MAX_ECHECS_TECHNIQUES
   * atteint) : sans elle, un post qui a deja coute des appels LLM disparait sans aucun
   * temoin, sur un mini PC que personne ne surveille en continu.
   */
  notifierTexte: (texte: string) => Promise<boolean>
  seuil: number
  ageMaxJours: number
  retentionJours: number
}

export interface ResultatRadar {
  collectes: number
  candidats: number
  retenus: number
  purges: number
  notificationsEchouees: number
  /** Posts abandonnes definitivement (MAX_ECHECS_TECHNIQUES atteint) sur ce run. */
  abandons: number
}

/**
 * Enregistre un echec TECHNIQUE (pas un rejet legitime) et journalise distinctement
 * selon qu'il reste des tentatives ou que le post est desormais abandonne.
 * Les couches basses (http/llm/sheets/telegram) ne levent jamais : c'est ce chemin
 * (valeur null renvoyee), pas le try/catch, qui porte le gros du signal de panne.
 *
 * Renvoie true si le post vient d'etre abandonne definitivement (pour que l'appelant
 * incremente son compteur) : un post abandonne a deja ete facture (scoring et/ou
 * enrichissement LLM) sans jamais atteindre le Sheet - une notification Telegram avec
 * l'URL est le seul moyen de le rattraper a la main.
 */
async function signalerEchecTechnique(
  db: RadarDb,
  notifierTexte: (texte: string) => Promise<boolean>,
  poste: { id: string; auteur: string; url: string },
  etape: string,
): Promise<boolean> {
  const echecs = db.enregistrerEchec({ id: poste.id, auteur: poste.auteur, url: poste.url })
  if (echecs < MAX_ECHECS_TECHNIQUES) {
    console.warn(
      `[radar] pipeline : echec technique sur post ${poste.id} a l'etape "${etape}" ` +
        `(tentative ${echecs}/${MAX_ECHECS_TECHNIQUES}, nouvel essai au prochain run)`,
    )
    return false
  }

  console.warn(`[radar] pipeline : post ${poste.id} abandonne apres ${echecs} echecs (etape : ${etape})`)
  const notifie = await notifierTexte(
    `Prospect abandonne apres ${echecs} echecs techniques (etape : ${etape})\n` +
      `${poste.url}\nDeja facture en LLM, jamais ecrit au Sheet - a verifier a la main si besoin.`,
  )
  if (!notifie) {
    console.warn(`[radar] pipeline : notification d'abandon Telegram echouee pour ${poste.id}`)
  }
  return true
}

/**
 * Pipeline principal : collecte -> dedup -> filtre gratuit -> scoring LLM -> enrichissement
 * -> Sheet -> Telegram. N'envoie jamais rien a un tiers : le brouillon reste dans le Sheet.
 *
 * Chaque candidat est traite dans son propre try/catch : une exception imprevue sur un
 * post ne doit jamais faire perdre les candidats suivants du run. C'est le seul job qui
 * tourne 24/7 sans supervision humaine.
 *
 * Distinction cruciale entre deux echecs qui se ressemblent mais ne doivent JAMAIS
 * entrainer la meme consequence :
 *  - rejet legitime (noter a repondu, score sous le seuil) -> marquer vu pour de bon,
 *    on ne repaie jamais un scoring deja rendu ;
 *  - echec technique (noter/enrichir/ecrireSheet renvoie null : LLM ou Sheets injoignable,
 *    timeout...) -> NE PAS marquer vu, le post doit repasser au run suivant. Seul un
 *    echec technique repete 3 fois de suite sur le meme post l'abandonne definitivement
 *    (signalerEchecTechnique), pour eviter de le re-scorer - donc le repayer - a l'infini.
 */
export async function executerRadar(d: DepsRadar): Promise<ResultatRadar> {
  const purges = d.db.purger(d.retentionJours)

  const bruts = await d.collecter()
  const inedits = bruts.filter((p) => !d.db.dejaVu(p.id))
  const candidats = prefiltrer(inedits, d.ageMaxJours)

  let retenus = 0
  let notificationsEchouees = 0
  let abandons = 0

  for (const c of candidats) {
    try {
      // Deux garde-fous contre un doublement de score errone :
      // - excludeId (c.id) : un echec technique precedent sur CE MEME post a deja
      //   cree une ligne pour son auteur (enregistrerEchec) ; sans exclusion, un
      //   simple timeout transformerait le post en sa propre "apparition precedente"
      //   et doublerait son propre score au run suivant.
      // - 'inconnu' : versAuteur() renvoie 'inconnu' pour tout auteur absent/supprime,
      //   partage par tous les posts anonymes de toutes les sources - deux posts
      //   anonymes suffiraient a faire doubler le score d'un troisieme sans lien reel
      //   entre eux. Un auteur inconnu n'a jamais d'historique exploitable : jamais
      //   double dans ce cas.
      const apparitions = c.auteur === 'inconnu' ? 0 : d.db.compterApparitions(c.auteur, c.id)
      const note = await d.noter(c, apparitions)

      if (note === null) {
        if (await signalerEchecTechnique(d.db, d.notifierTexte, c, 'scoring')) abandons++
        continue
      }

      if (note.score < d.seuil) {
        // Rejet legitime : le LLM a repondu, le score est juste sous le seuil.
        d.db.marquerVu({ id: c.id, auteur: c.auteur, url: c.url, score: note.score })
        continue
      }

      const enrichi = await d.enrichir(note)
      if (enrichi === null) {
        if (await signalerEchecTechnique(d.db, d.notifierTexte, c, 'enrichissement')) abandons++
        continue
      }

      const ligne = await d.ecrireSheet([enrichi])
      if (ligne === null) {
        // Rien n'est arrive au prospect : ne pas notifier un succes qui n'a pas eu lieu.
        if (await signalerEchecTechnique(d.db, d.notifierTexte, c, 'ecriture Sheet')) abandons++
        continue
      }

      const notifie = await d.notifier(enrichi, ligne)
      if (!notifie) {
        // Le prospect est deja ecrit dans le Sheet (recuperable) : on ne condamne pas
        // le post pour autant, mais un Telegram rate = l'humain n'apprend jamais qu'un
        // prospect chaud est arrive s'il ne surveille pas le Sheet en direct.
        notificationsEchouees++
        console.warn(
          `[radar] pipeline : notification Telegram echouee pour ${c.id} (ligne ${ligne} du Sheet, prospect conserve)`,
        )
      }

      d.db.marquerVu({
        id: enrichi.id, auteur: enrichi.auteur, url: enrichi.url, score: enrichi.score,
        recheckLe: new Date(Date.now() + DELAI_RECHECK_MS),
      })
      retenus++
    } catch (err) {
      // "Les couches basses ne levent jamais" est une garantie de CONCEPTION, pas
      // d'execution : un bug de programmation (undefined.prop, regression future)
      // leve quand meme. Sans ce compte, un post qui declenche systematiquement une
      // exception reviendrait a chaque run et refacturerait un appel LLM a chaque
      // fois - boucle de facturation infinie. Le plafond de MAX_ECHECS_TECHNIQUES
      // s'applique donc ici exactement comme sur les retours null.
      const raison = err instanceof Error ? err.message : String(err)
      if (await signalerEchecTechnique(d.db, d.notifierTexte, c, `exception : ${raison}`)) abandons++
    }
  }

  const resultat: ResultatRadar = {
    collectes: bruts.length,
    candidats: candidats.length,
    retenus,
    purges,
    notificationsEchouees,
    abandons,
  }
  // Seule trace visible dans le Planificateur de taches Windows : un run silencieux
  // qui echoue partout resterait indetectable sans ce log.
  console.log(
    `[radar] run termine : ${resultat.collectes} collectes, ${resultat.candidats} candidats, ` +
      `${resultat.retenus} retenus, ${resultat.purges} purges, ` +
      `${resultat.notificationsEchouees} notifications echouees, ${resultat.abandons} abandons`,
  )
  return resultat
}
