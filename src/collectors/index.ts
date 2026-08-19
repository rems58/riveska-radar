import type { RawPost } from '../types.ts'
import { collecterReddit } from './reddit.ts'
import { collecterHackerNews } from './hackernews.ts'
import { collecterStackOverflow } from './stackoverflow.ts'
import { collecterBluesky } from './bluesky.ts'
import { collecterMastodon } from './mastodon.ts'
import { getConfig } from '../config.ts'

export type Collecteur = () => Promise<RawPost[]>

/**
 * Une source nommee : le nom sert aux logs et aux futures statistiques.
 * Sans nom, un echec de collecteur (fonction anonyme) est indiagnostiquable.
 */
export interface SourceCollecte {
  nom: string
  collecter: Collecteur
}

/** Avertissement par defaut quand une source renvoie 0 post alors que d'autres en renvoient. */
export function avertirSourceVide(nom: string): void {
  console.warn(
    `[radar] source "${nom}" a renvoye 0 post alors que d'autres sources en ont renvoye - ` +
      `flux probablement casse (redirection, changement de format d'API...). ` +
      `Une reponse HTTP 200 avec 0 resultat exploitable ne leve jamais d'exception : ` +
      `sans ce signal, une source peut rester muette pendant des mois sans que rien ne le montre.`,
  )
}

/**
 * Lance toutes les sources en parallele.
 * Une source en panne (exception) est journalisee (avec son nom) puis ignoree : la
 * collecte ne doit jamais s'arreter parce qu'une seule API est indisponible.
 *
 * Garde-fou distinct : une source qui REPOND (pas d'exception) mais ne renvoie AUCUN
 * post alors qu'au moins une autre source en renvoie est un signal fort de flux casse
 * (redirection vers une page HTML, changement de format d'API, etc.) - c'est
 * precisement le cas qui n'etait jamais journalise avant, et qui a permis a plusieurs
 * sources de rester mortes en silence. onSourceVide est appele une fois par source
 * concernee ; par defaut il journalise, mais un appelant (ex: le job radar, pour
 * l'enregistrer en base et le faire remonter dans le bilan hebdo) peut le remplacer.
 * Si TOUTES les sources renvoient 0, ce n'est pas une anomalie relative (reseau
 * coupe, par exemple) : rien n'est signale ici, journaliser les echecs individuels suffit.
 */
export async function collecterTout(
  sources: SourceCollecte[],
  onSourceVide: (nom: string) => void = avertirSourceVide,
): Promise<RawPost[]> {
  const resultats = await Promise.allSettled(sources.map((s) => s.collecter()))
  const vus = new Set<string>()
  const posts: RawPost[] = []
  const comptesReussis: { nom: string; n: number }[] = []

  resultats.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.warn(`[radar] source "${sources[i]!.nom}" en echec :`, r.reason)
      return
    }
    comptesReussis.push({ nom: sources[i]!.nom, n: r.value.length })
    for (const p of r.value) {
      if (vus.has(p.id)) continue
      vus.add(p.id)
      posts.push(p)
    }
  })

  const auMoinsUneSourceNonVide = comptesReussis.some((c) => c.n > 0)
  if (auMoinsUneSourceNonVide) {
    for (const c of comptesReussis) {
      if (c.n === 0) onSourceVide(c.nom)
    }
  }

  return posts
}

/**
 * Sources par defaut, cablees sur la configuration reelle.
 * getConfig() n'est appele qu'ici, au moment de l'appel, pas au chargement du module :
 * un import de ce fichier sans .env present ne doit jamais lever.
 *
 * Le "forum" (flux RSS forums.expo.dev + developer.apple.com/forums) a ete retire :
 * verifie en appel reel le 2026-08-19, les deux flux sont morts (Expo redirige
 * entierement vers Discord depuis - aucune API RSS n'existe la-bas ; Apple bloque les
 * requetes automatisees derriere une verification anti-bot). Aucun flux de
 * remplacement fonctionnel n'a ete trouve pour ce role - voir README.
 *
 * Reddit et Bluesky sont FACULTATIFS (identifiants absents -> API fermee/non
 * authentifiee, voir README). Ils ne sont ajoutes a la liste que si leurs
 * identifiants sont presents : une source absente de la liste n'est jamais vue par
 * collecterTout, donc jamais confondue par le garde-fou "source vide" avec un flux
 * casse - le collecteur lui-meme sait aussi se desactiver proprement (teste
 * isolement), mais le filtrage ici evite en plus tout faux-positif du garde-fou.
 */
export function collecteursParDefaut(): SourceCollecte[] {
  const cfg = getConfig()
  const sources: SourceCollecte[] = [
    { nom: 'hackernews', collecter: collecterHackerNews },
    { nom: 'stackoverflow', collecter: collecterStackOverflow },
    { nom: 'mastodon', collecter: collecterMastodon },
  ]

  if (cfg.redditClientId && cfg.redditClientSecret && cfg.redditUserAgent) {
    const { redditClientId, redditClientSecret, redditUserAgent } = cfg
    sources.push({
      nom: 'reddit',
      collecter: () => collecterReddit({
        clientId: redditClientId,
        clientSecret: redditClientSecret,
        userAgent: redditUserAgent,
      }),
    })
  } else {
    console.warn(
      '[radar] reddit : source desactivee pour ce run (identifiants absents - API fermee en ' +
        'libre-service depuis la Responsible Builder Policy de Reddit, voir README).',
    )
  }

  if (cfg.blueskyId && cfg.blueskyAppPassword) {
    const { blueskyId, blueskyAppPassword } = cfg
    sources.push({
      nom: 'bluesky',
      collecter: () => collecterBluesky({ id: blueskyId, appPassword: blueskyAppPassword }),
    })
  } else {
    console.warn('[radar] bluesky : source desactivee pour ce run (BLUESKY_ID/BLUESKY_APP_PASSWORD absents).')
  }

  return sources
}
