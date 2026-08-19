import type { RawPost } from '../types.ts'

/** Flux RSS de forums surveilles. */
export const FLUX_FORUMS = [
  'https://forums.expo.dev/latest.rss',
  'https://developer.apple.com/forums/feed/app-store-distribution',
]

/** Decode les entites HTML minimales presentes dans les flux RSS. */
function decoderHtml(texte: string): string {
  return texte
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

/** Extrait le contenu d'une balise XML, en gerant les sections CDATA. */
function extraireBalise(bloc: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))\\s*</${tag}>`, 'i')
  const m = re.exec(bloc)
  if (!m) return null
  const valeur = m[1] ?? m[2] ?? ''
  return decoderHtml(valeur.trim())
}

/**
 * Parse un flux RSS sans dependance XML : extrait les blocs <item> puis leurs
 * balises usuelles. Volontairement tolerant : un flux mal forme ne doit jamais lever.
 */
function parserRss(xml: string): RawPost[] {
  const posts: RawPost[] = []
  const items = xml.match(/<item[^>]*>[\s\S]*?<\/item>/gi) ?? []

  for (const bloc of items) {
    const lien = extraireBalise(bloc, 'link')
    if (!lien) continue

    const titre = extraireBalise(bloc, 'title') ?? ''
    const description = extraireBalise(bloc, 'description') ?? ''
    const pubDate = extraireBalise(bloc, 'pubDate')
    const auteur = extraireBalise(bloc, 'dc:creator') ?? 'inconnu'

    posts.push({
      id: `forum:${lien}`,
      source: 'forum',
      url: lien,
      auteur,
      titre,
      contenu: description,
      publieLe: pubDate ? new Date(pubDate) : new Date(),
    })
  }
  return posts
}

/**
 * Recupere et parse les flux RSS des forums surveilles.
 * Toute panne unitaire est avalee : un flux indisponible ne casse pas la collecte.
 */
export async function collecterRss(): Promise<RawPost[]> {
  const vus = new Set<string>()
  const posts: RawPost[] = []

  for (const flux of FLUX_FORUMS) {
    try {
      const r = await fetch(flux)
      if (!r.ok) continue
      const xml = await r.text()
      for (const p of parserRss(xml)) {
        if (vus.has(p.id)) continue
        vus.add(p.id)
        posts.push(p)
      }
    } catch {
      // Flux injoignable : on continue avec les suivants.
    }
  }
  return posts
}
