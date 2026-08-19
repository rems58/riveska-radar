import type { RawPost } from '../types.ts'

/** Requetes lancees sur l'API StackExchange (site stackoverflow). */
const REQUETES = [
  'app store rejected',
  'expo eas build publish',
  'google play closed testing',
]

interface StackExchangeItem {
  question_id: number
  title: string
  body_markdown: string | null
  link: string
  creation_date: number
  owner?: { display_name?: string }
}

/** Decode les entites HTML minimales renvoyees par l'API StackExchange dans les titres. */
function decoderHtml(texte: string): string {
  return texte
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
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
    try {
      const r = await fetch(url)
      if (!r.ok) continue
      const j = (await r.json()) as { items?: StackExchangeItem[] }
      for (const it of j.items ?? []) {
        const id = `stackoverflow:${it.question_id}`
        if (vus.has(id)) continue
        vus.add(id)
        posts.push({
          id,
          source: 'stackoverflow',
          url: it.link,
          auteur: it.owner?.display_name ?? 'inconnu',
          titre: decoderHtml(it.title),
          contenu: it.body_markdown ?? '',
          publieLe: new Date(it.creation_date * 1000),
        })
      }
    } catch {
      // Requete en echec : on continue avec les suivantes.
    }
  }
  return posts
}
