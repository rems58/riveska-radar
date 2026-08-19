import type { RawPost } from '../types.ts'

/** Requetes lancees sur l'API Algolia de Hacker News. */
const REQUETES = [
  'app store rejected',
  'app store review',
  'publish ios app',
  'google play testers',
]

interface AlgoliaHit {
  objectID: string
  author: string | null
  title: string | null
  story_text: string | null
  comment_text: string | null
  created_at_i: number
}

/**
 * Interroge l'API Algolia de Hacker News (search_by_date, sans cle).
 * Toute panne unitaire est avalee : une requete en echec ne casse pas la collecte.
 */
export async function collecterHackerNews(): Promise<RawPost[]> {
  const vus = new Set<string>()
  const posts: RawPost[] = []

  for (const q of REQUETES) {
    const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(q)}&hitsPerPage=30`
    try {
      const r = await fetch(url)
      if (!r.ok) continue
      const j = (await r.json()) as { hits?: AlgoliaHit[] }
      for (const h of j.hits ?? []) {
        const id = `hackernews:${h.objectID}`
        if (vus.has(id)) continue
        vus.add(id)
        posts.push({
          id,
          source: 'hackernews',
          url: `https://news.ycombinator.com/item?id=${h.objectID}`,
          auteur: h.author ?? 'inconnu',
          titre: h.title ?? '',
          contenu: h.story_text ?? h.comment_text ?? '',
          publieLe: new Date(h.created_at_i * 1000),
        })
      }
    } catch {
      // Requete en echec : on continue avec les suivantes.
    }
  }
  return posts
}
