import type { RawPost } from '../types.ts'
import { recupererJson, versAuteur, dateValideOuNull, retirerHtml } from './http.ts'

/** Instances Mastodon publiques surveillees. */
const INSTANCES = ['mastodon.social', 'fosstodon.org']

/** Hashtags surveilles sur chaque instance. */
const HASHTAGS = ['appstore', 'iosdev', 'androiddev', 'reactnative']

/**
 * Construit un RawPost a partir d'un statut brut renvoye par une instance Mastodon.
 * Renvoie null (et journalise) si un champ indispensable manque ou est invalide.
 */
function posteDepuisStatus(brut: unknown, instance: string): RawPost | null {
  if (typeof brut !== 'object' || brut === null) return null
  const s = brut as Record<string, unknown>

  if (typeof s.id !== 'string' || typeof s.url !== 'string') return null

  const publieLe = dateValideOuNull(new Date(typeof s.created_at === 'string' ? s.created_at : NaN))
  if (!publieLe) {
    console.warn(`[radar] mastodon : statut ${s.id} ignore (date invalide ou absente)`)
    return null
  }

  const account = typeof s.account === 'object' && s.account !== null ? (s.account as Record<string, unknown>) : undefined
  const texte = retirerHtml(typeof s.content === 'string' ? s.content : '')

  return {
    id: `mastodon:${instance}:${s.id}`,
    source: 'mastodon',
    url: s.url,
    auteur: versAuteur(account?.acct),
    titre: texte.slice(0, 120),
    contenu: texte,
    publieLe,
  }
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
      const statuses = await recupererJson<unknown>({ source: `mastodon:${instance}`, url })
      if (!Array.isArray(statuses)) continue

      for (const s of statuses) {
        const post = posteDepuisStatus(s, instance)
        if (!post) continue
        if (vus.has(post.id)) continue
        vus.add(post.id)
        posts.push(post)
      }
    }
  }
  return posts
}
