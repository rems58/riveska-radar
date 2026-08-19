import type { RawPost } from '../types.ts'

/** Requetes lancees sur l'endpoint public searchPosts de Bluesky. */
const REQUETES = [
  'app store rejected',
  'app rejected apple',
  'publish app store help',
]

interface BlueskyPost {
  uri: string
  author: { handle: string }
  record: { text: string; createdAt: string }
}

/** Extrait le rkey (dernier segment) d'un URI AT Protocol. */
function extraireRkey(uri: string): string {
  const segments = uri.split('/')
  return segments[segments.length - 1] ?? uri
}

/**
 * Interroge l'endpoint public app.bsky.feed.searchPosts (sans auth).
 * Toute panne unitaire est avalee : une requete en echec ne casse pas la collecte.
 */
export async function collecterBluesky(): Promise<RawPost[]> {
  const vus = new Set<string>()
  const posts: RawPost[] = []

  for (const q of REQUETES) {
    const url = `https://public.api.bsky.app/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(q)}&limit=25`
    try {
      const r = await fetch(url)
      if (!r.ok) continue
      const j = (await r.json()) as { posts?: BlueskyPost[] }
      for (const post of j.posts ?? []) {
        const rkey = extraireRkey(post.uri)
        const id = `bluesky:${rkey}`
        if (vus.has(id)) continue
        vus.add(id)
        posts.push({
          id,
          source: 'bluesky',
          url: `https://bsky.app/profile/${post.author.handle}/post/${rkey}`,
          auteur: post.author.handle,
          titre: post.record.text.slice(0, 120),
          contenu: post.record.text,
          publieLe: new Date(post.record.createdAt),
        })
      }
    } catch {
      // Requete en echec : on continue avec les suivantes.
    }
  }
  return posts
}
