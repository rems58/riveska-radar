import type { RawPost } from '../types.ts'
import { collecterReddit } from './reddit.ts'
import { collecterHackerNews } from './hackernews.ts'
import { collecterStackOverflow } from './stackoverflow.ts'
import { collecterBluesky } from './bluesky.ts'
import { collecterMastodon } from './mastodon.ts'
import { collecterRss } from './rss.ts'
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

/**
 * Lance toutes les sources en parallele.
 * Une source en panne est journalisee (avec son nom) puis ignoree : la collecte
 * ne doit jamais s'arreter parce qu'une seule API est indisponible.
 */
export async function collecterTout(sources: SourceCollecte[]): Promise<RawPost[]> {
  const resultats = await Promise.allSettled(sources.map((s) => s.collecter()))
  const vus = new Set<string>()
  const posts: RawPost[] = []

  resultats.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.warn(`[radar] source "${sources[i]!.nom}" en echec :`, r.reason)
      return
    }
    for (const p of r.value) {
      if (vus.has(p.id)) continue
      vus.add(p.id)
      posts.push(p)
    }
  })
  return posts
}

/**
 * Sources par defaut, cablees sur la configuration reelle.
 * getConfig() n'est appele qu'ici, au moment de l'appel, pas au chargement du module :
 * un import de ce fichier sans .env present ne doit jamais lever.
 */
export function collecteursParDefaut(): SourceCollecte[] {
  const cfg = getConfig()
  return [
    {
      nom: 'reddit',
      collecter: () => collecterReddit({
        clientId: cfg.redditClientId,
        clientSecret: cfg.redditClientSecret,
        userAgent: cfg.redditUserAgent,
      }),
    },
    { nom: 'hackernews', collecter: collecterHackerNews },
    { nom: 'stackoverflow', collecter: collecterStackOverflow },
    { nom: 'bluesky', collecter: collecterBluesky },
    { nom: 'mastodon', collecter: collecterMastodon },
    { nom: 'rss', collecter: collecterRss },
  ]
}
