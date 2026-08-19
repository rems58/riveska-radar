import type { RawPost } from '../types.ts'
import { recupererJson, decoderEntitesHtml, versAuteur, dateValideOuNull } from './http.ts'

/** Requetes lancees sur l'API StackExchange (site stackoverflow). */
const REQUETES = [
  'app store rejected',
  'expo eas build publish',
  'google play closed testing',
]

/**
 * Construit un RawPost a partir d'un item brut renvoye par StackExchange.
 * Renvoie null (et journalise) si un champ indispensable manque ou est invalide.
 */
function posteDepuisItem(brut: unknown): RawPost | null {
  if (typeof brut !== 'object' || brut === null) return null
  const it = brut as Record<string, unknown>

  const idBrut = it.question_id
  if (typeof idBrut !== 'number' && typeof idBrut !== 'string') return null
  if (typeof it.link !== 'string') return null

  const publieLe = dateValideOuNull(new Date(Number(it.creation_date) * 1000))
  if (!publieLe) {
    console.warn(`[radar] stackoverflow : question ${idBrut} ignoree (date invalide ou absente)`)
    return null
  }

  const owner = typeof it.owner === 'object' && it.owner !== null ? (it.owner as Record<string, unknown>) : undefined

  return {
    id: `stackoverflow:${idBrut}`,
    source: 'stackoverflow',
    url: it.link,
    auteur: versAuteur(owner?.display_name),
    titre: decoderEntitesHtml(typeof it.title === 'string' ? it.title : ''),
    contenu: typeof it.body_markdown === 'string' ? it.body_markdown : '',
    publieLe,
  }
}

/**
 * Interroge l'API StackExchange (search/advanced, site stackoverflow, sans cle).
 * Toute panne unitaire est avalee : une requete en echec ne casse pas la collecte.
 */
export async function collecterStackOverflow(): Promise<RawPost[]> {
  const vus = new Set<string>()
  const posts: RawPost[] = []

  for (const q of REQUETES) {
    const url =
      'https://api.stackexchange.com/2.3/search/advanced' +
      `?order=desc&sort=creation&q=${encodeURIComponent(q)}&site=stackoverflow&filter=withbody`

    const j = await recupererJson<{ items?: unknown }>({ source: 'stackoverflow', url })
    if (!Array.isArray(j?.items)) continue

    for (const it of j.items) {
      const post = posteDepuisItem(it)
      if (!post) continue
      if (vus.has(post.id)) continue
      vus.add(post.id)
      posts.push(post)
    }
  }
  return posts
}
