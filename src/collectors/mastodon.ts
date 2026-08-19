import type { RawPost } from '../types.ts'

/** Instances Mastodon publiques surveillees. */
const INSTANCES = ['mastodon.social', 'fosstodon.org']

/** Hashtags surveilles sur chaque instance. */
const HASHTAGS = ['appstore', 'iosdev', 'androiddev', 'reactnative']

interface MastodonStatus {
  id: string
  url: string
  account: { acct: string }
  content: string
  created_at: string
}

/** Reduit le HTML des statuts Mastodon en texte brut lisible. */
function retirerHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Interroge les timelines publiques par hashtag de plusieurs instances Mastodon (sans token).
 * Toute panne unitaire est avalee : une instance ou un hashtag indisponible ne casse pas la collecte.
 */
export async function collecterMastodon(): Promise<RawPost[]> {
  const vus = new Set<string>()
  const posts: RawPost[] = []

  for (const instance of INSTANCES) {
    for (const tag of HASHTAGS) {
      const url = `https://${instance}/api/v1/timelines/tag/${tag}?limit=20`
      try {
        const r = await fetch(url)
        if (!r.ok) continue
        const statuses = (await r.json()) as MastodonStatus[]
        for (const s of statuses) {
          const id = `mastodon:${instance}:${s.id}`
          if (vus.has(id)) continue
          vus.add(id)
          const texte = retirerHtml(s.content)
          posts.push({
            id,
            source: 'mastodon',
            url: s.url,
            auteur: s.account.acct,
            titre: texte.slice(0, 120),
            contenu: texte,
            publieLe: new Date(s.created_at),
          })
        }
      } catch {
        // Instance/hashtag injoignable : on continue avec les suivants.
      }
    }
  }
  return posts
}
