import type { RawPost } from '../types.ts'
import { recupererJson, versAuteur, dateValideOuNull } from './http.ts'

/** Requetes lancees sur l'API Algolia de Hacker News. */
const REQUETES = [
  'app store rejected',
  'app store review',
  'publish ios app',
  'google play testers',
]

/**
 * Construit un RawPost a partir d'un hit brut renvoye par Algolia.
 * Renvoie null (et journalise) si un champ indispensable manque ou est invalide.
 */
function posteDepuisHit(brut: unknown): RawPost | null {
  if (typeof brut !== 'object' || brut === null) return null
  const h = brut as Record<string, unknown>

  if (typeof h.objectID !== 'string') return null

  const publieLe = dateValideOuNull(new Date(Number(h.created_at_i) * 1000))
  if (!publieLe) {
    console.warn(`[radar] hackernews : post ${h.objectID} ignore (date invalide ou absente)`)
    return null
  }

  return {
    id: `hackernews:${h.objectID}`,
    source: 'hackernews',
    url: `https://news.ycombinator.com/item?id=${h.objectID}`,
    auteur: versAuteur(h.author),
    titre: typeof h.title === 'string' ? h.title : '',
    contenu: typeof h.story_text === 'string' ? h.story_text : typeof h.comment_text === 'string' ? h.comment_text : '',
    publieLe,
  }
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
    const j = await recupererJson<{ hits?: unknown }>({ source: 'hackernews', url })
    if (!Array.isArray(j?.hits)) continue

    for (const h of j.hits) {
      const post = posteDepuisHit(h)
      if (!post) continue
      if (vus.has(post.id)) continue
      vus.add(post.id)
      posts.push(post)
    }
  }
  return posts
}
