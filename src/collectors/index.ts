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
 * Lance tous les collecteurs en parallele.
 * Une source en panne est journalisee puis ignoree : la collecte ne doit jamais
 * s'arreter parce qu'une seule API est indisponible.
 */
export async function collecterTout(collecteurs: Collecteur[]): Promise<RawPost[]> {
  const resultats = await Promise.allSettled(collecteurs.map((c) => c()))
  const vus = new Set<string>()
  const posts: RawPost[] = []

  for (const r of resultats) {
    if (r.status === 'rejected') {
      console.warn('[radar] source en echec :', r.reason)
      continue
    }
    for (const p of r.value) {
      if (vus.has(p.id)) continue
      vus.add(p.id)
      posts.push(p)
    }
  }
  return posts
}

/**
 * Collecteurs par defaut, cables sur la configuration reelle.
 * getConfig() n'est appele qu'ici, au moment de l'appel, pas au chargement du module :
 * un import de ce fichier sans .env present ne doit jamais lever.
 */
export function collecteursParDefaut(): Collecteur[] {
  const cfg = getConfig()
  return [
    () => collecterReddit({
      clientId: cfg.redditClientId,
      clientSecret: cfg.redditClientSecret,
      userAgent: cfg.redditUserAgent,
    }),
    collecterHackerNews,
    collecterStackOverflow,
    collecterBluesky,
    collecterMastodon,
    collecterRss,
  ]
}
