import type { RawPost } from '../types.ts'
import { recupererTexteAvecStatut, versAuteur, dateValideOuNull, retirerHtml } from './http.ts'
import { extraireBlocsItem, extraireBalise, extraireLien } from './rss.ts'

/**
 * Collecteur Reddit via search.rss (flux Atom public, servi pour la syndication).
 *
 * L'API OAuth de Reddit (src/collectors/reddit.ts) est fermee en libre-service
 * (Responsible Builder Policy) : /r/X/new.json et /search.json renvoient 403 meme
 * avec un user-agent de navigateur, verifie en appel reel le 2026-08-19. On NE
 * TOUCHE JAMAIS a ces chemins ni a api/v1/access_token : le 403/401 est un controle
 * d'acces deliberement ferme, pas une porte a forcer.
 *
 * search.rss est different : Reddit le sert delibermment pour la syndication (lecteurs
 * de flux). Le consommer est l'usage prevu d'un flux publie, pas un contournement.
 * Verifie en appel reel : /r/X/new.rss et /search.rss?q=... repondent 200 avec 25
 * entrees Atom, y compris une recherche sur tout Reddit (pas restreinte a un
 * subreddit) - c'est ce que ce collecteur utilise.
 *
 * Debit mesure le 2026-08-19 : 5 requetes espacees de 3s -> 1x200 puis 4x429 ; apres
 * un premier 429, +20s -> 200, +30s -> 429, +45s -> 200 (comportement non-monotone,
 * probablement une fenetre glissante cote Reddit). Conclusion prudente : une requete
 * par minute maximum, en SEQUENTIEL STRICT - jamais de parallelisme sur cette source.
 * C'est pourquoi ce collecteur n'est jamais appele par collecterTout (parallele) mais
 * par sa propre commande, planifiee une fois par heure (jobs/reddit.ts, "reddit").
 *
 * Mesure complementaire (meme jour, quelques heures plus tard) : la MEME url, avec
 * le meme user-agent, a echoue en 429 aussi bien en curl qu'en fetch Node - alors
 * qu'elle avait repondu 200 avec 25 entrees une heure plus tot. Ce n'est donc pas un
 * defaut de ce code : Reddit limite par IP et ESCALADE (429 puis 403, blocage
 * temporaire) si l'IP insiste. Consequence : une reponse limitee (429 OU 403) qui
 * persiste apres le retry declenche un ARRET IMMEDIAT de tout le run (voir
 * collecterRedditRss) - enchainer les requetes restantes prolongerait la penalite
 * au lieu de la laisser retomber. Le 403 recoit exactement le meme traitement que
 * le 429 : c'est la forme escaladee de la meme limite, pas une erreur distincte.
 */

/** Delai minimum entre deux requetes search.rss. Voir mesure ci-dessus : 1/minute. */
export const DELAI_ENTRE_REQUETES_MS = 60_000

/**
 * Delai avant de retenter une requete ayant recu un 429. Mesure : un retry a +45s
 * a fini par passer, mais +30s a echoue - le comportement n'est pas strictement
 * monotone (fenetre glissante probable). 90s laisse une marge confortable au-dela
 * du seul succes observe apres un 429, sans etre demesure sur une commande horaire.
 */
export const DELAI_RETRY_APRES_429_MS = 90_000

/** S'identifie honnetement aupres de Reddit : jamais un user-agent de navigateur. */
export const USER_AGENT = 'riveska-radar/0.1 (feed reader; +https://riveska.com)'

/**
 * Requetes couvrant les signaux de douleur (filter/keywords.ts) dans les 5 langues
 * supportees - un sous-ensemble volontairement limite a une douzaine : a 1
 * requete/minute (DELAI_ENTRE_REQUETES_MS), 12 requetes = 12 minutes par run, ce qui
 * reste raisonnable pour une commande horaire (jobs/reddit.ts) mais pas plus.
 * Deux requetes par langue (sauf l'anglais, plus large car c'est la langue dominante
 * sur Reddit), une par grande categorie de src/filter/keywords.ts : rejet de store,
 * probleme de compte developpeur ou premiere publication bloquee.
 */
export const REQUETES: string[] = [
  // Anglais : volume le plus fort sur Reddit, deux categories couvertes en plus du rejet.
  'app rejected', 'guideline 4.2.6', 'developer account problem', 'how to publish my app',
  // Francais
  'app rejetee', 'compte developpeur bloque',
  // Allemand
  'app abgelehnt', 'entwicklerkonto problem',
  // Espagnol
  'app rechazada', 'cuenta de desarrollador problema',
  // Italien
  'app rifiutata', 'account sviluppatore problema',
]

function pause(ms: number): Promise<void> {
  return new Promise((resoudre) => setTimeout(resoudre, ms))
}

function construireUrl(requete: string): string {
  return `https://www.reddit.com/search.rss?q=${encodeURIComponent(requete)}&sort=new&limit=25`
}

/**
 * 429 (rate-limit) et 403 (blocage temporaire) sont la MEME limite Reddit, juste a
 * deux degres d'escalade differents (mesure reelle : meme URL, meme user-agent -
 * 429 en curl comme en fetch une heure apres un 200 - donc une limitation par IP,
 * pas un defaut de ce code). Les deux declenchent le meme recul.
 */
function estLimite(statut: number | null): boolean {
  return statut === 429 || statut === 403
}

interface ResultatRequete {
  xml: string | null
  /**
   * true si la reponse - APRES le retry - est encore un 429/403. Le champ compte
   * a lui seul "deux reponses de limitation consecutives" (la tentative initiale
   * ET le retry) : voir collecterRedditRss, qui arrete tout le run des que ce champ
   * vaut true, sans tenter les requetes suivantes.
   */
  limite: boolean
}

/**
 * Recupere une page search.rss, avec UNE tentative de retry si (et seulement si)
 * la premiere reponse est limitee (429 ou 403) - une limitation isolee merite une
 * seconde chance apres un delai plus long, contrairement a une panne reseau ou un
 * 404 qui n'ont aucune raison de se resoudre en reessayant tout de suite.
 *
 * Si le retry est ENCORE limite, resultat.limite vaut true : deux reponses de
 * limitation consecutives sur la meme requete signalent une IP en penalite, pas
 * un incident isole - insister (essayer les requetes suivantes) ne ferait que
 * prolonger la penalite. C'est a l'appelant (collecterRedditRss) d'arreter tout
 * le run dans ce cas, pas a cette fonction de continuer seule.
 */
async function recupererAvecRetry(requete: string): Promise<ResultatRequete> {
  const url = construireUrl(requete)
  const options = { source: 'reddit-rss', url, init: { headers: { 'User-Agent': USER_AGENT } } }

  const premiere = await recupererTexteAvecStatut(options)
  if (premiere.texte !== null) return { xml: premiere.texte, limite: false }
  if (!estLimite(premiere.statut)) return { xml: null, limite: false }

  console.warn(
    `[radar] reddit-rss : ${premiere.statut} pour la requete "${requete}", nouvelle tentative dans ` +
      `${DELAI_RETRY_APRES_429_MS / 1000}s`,
  )
  await pause(DELAI_RETRY_APRES_429_MS)

  const deuxieme = await recupererTexteAvecStatut(options)
  if (deuxieme.texte !== null) return { xml: deuxieme.texte, limite: false }

  const toujoursLimite = estLimite(deuxieme.statut)
  if (!toujoursLimite) {
    console.warn(`[radar] reddit-rss : requete "${requete}" abandonnee (statut ${deuxieme.statut ?? 'reseau'})`)
  }
  return { xml: null, limite: toujoursLimite }
}

/**
 * Extrait le nom d'utilisateur depuis <author><name>/u/pseudo</name></author>.
 * Le "/u/" est un prefixe d'affichage Reddit, pas le pseudo lui-meme.
 */
function auteurDepuisEntree(bloc: string): string {
  const nom = extraireBalise(bloc, 'name')
  return versAuteur(nom?.replace(/^\/u\//, ''))
}

/**
 * L'id Atom d'une entree "post" a la forme t3_xxxxx (fullname Reddit ; t3 = lien/post).
 * search.rss renvoie AUSSI des entrees "subreddit" (id t5_xxxxx) melangees aux
 * resultats - on ne garde que les posts. Le prefixe t3_ est retire : l'API OAuth
 * (src/collectors/reddit.ts) construit ses ids sans lui (reddit:<id base36>), et les
 * deux sources doivent produire le MEME id pour le meme post afin que la
 * deduplication partagee (RadarDb.dejaVu) les traite comme un seul et meme post,
 * jamais comme un doublon.
 */
function idPost(bloc: string): string | null {
  const brut = extraireBalise(bloc, 'id')
  if (!brut?.startsWith('t3_')) return null
  return brut.slice('t3_'.length)
}

/**
 * Construit un RawPost a partir d'une entree Atom de search.rss.
 * Renvoie null (sans journaliser - un flux de recherche large contient normalement
 * des entrees non exploitables, ce n'est pas une anomalie) si ce n'est pas un post,
 * si le lien manque, ou si aucune date exploitable n'est presente.
 */
function posteDepuisEntree(bloc: string): RawPost | null {
  const id = idPost(bloc)
  if (!id) return null

  const lien = extraireLien(bloc)
  if (!lien) return null

  // Mesure reelle (2026-08-19) : les entrees "post" fournissent <published> ET
  // <updated> (identiques a la creation, Reddit ne semble jamais les faire diverger
  // sur ces flux) ; on prefere <published> quand present, <updated> en repli pour
  // rester tolerant a une variation future du flux.
  const dateBrute = extraireBalise(bloc, 'published') ?? extraireBalise(bloc, 'updated')
  const publieLe = dateValideOuNull(new Date(dateBrute ?? ''))
  if (!publieLe) return null

  const titre = extraireBalise(bloc, 'title') ?? ''
  const contenuHtml = extraireBalise(bloc, 'content') ?? ''

  return {
    id: `reddit:${id}`,
    source: 'reddit',
    url: lien,
    auteur: auteurDepuisEntree(bloc),
    titre,
    contenu: retirerHtml(contenuHtml),
    publieLe,
  }
}

/**
 * Collecte Reddit via search.rss, en SEQUENTIEL STRICT avec au moins
 * DELAI_ENTRE_REQUETES_MS entre deux requetes - jamais de Promise.all ici,
 * contrairement aux autres collecteurs (collecterTout les lance en parallele).
 * requetes est parametrable (defaut : REQUETES) pour les tests et la mesure reelle
 * de l'espacement sans devoir attendre les 12 requetes completes.
 * Ne leve jamais.
 *
 * ARRET ANTICIPE sur limitation persistante : si une requete reste limitee (429
 * ou 403) apres son retry, c'est le signal d'une IP en penalite, pas d'un incident
 * isole sur cette seule requete. Le run s'arrete alors immediatement SANS tenter
 * les requetes restantes - les enchainer prolongerait la penalite au lieu de la
 * laisser retomber. Mieux vaut zero post ce cycle-ci ; le prochain run (dans
 * l'heure) reessaiera depuis le debut.
 */
export async function collecterRedditRss(requetes: string[] = REQUETES): Promise<RawPost[]> {
  const vus = new Set<string>()
  const posts: RawPost[] = []

  for (let i = 0; i < requetes.length; i++) {
    if (i > 0) await pause(DELAI_ENTRE_REQUETES_MS)

    const resultat = await recupererAvecRetry(requetes[i]!)

    if (resultat.limite) {
      const restantes = requetes.length - i - 1
      console.warn(
        `[radar] reddit-rss : IP en limitation Reddit (429/403 persistant apres retry) - ` +
          `arret immediat du run, ${restantes} requete(s) restante(s) non tentee(s) pour ne pas ` +
          `prolonger la penalite. Le prochain run (planifie dans l'heure) reessaiera depuis le debut - ` +
          `ne pas relancer cette commande a la main, ca ne ferait qu'entretenir le blocage.`,
      )
      break
    }

    if (resultat.xml === null) continue

    for (const bloc of extraireBlocsItem(resultat.xml)) {
      const post = posteDepuisEntree(bloc)
      if (!post) continue
      if (vus.has(post.id)) continue
      vus.add(post.id)
      posts.push(post)
    }
  }

  return posts
}
