import type { RawPost } from '../types.ts'
import { recupererTexte, decoderEntitesHtml, versAuteur, dateValideOuNull } from './http.ts'

/** Flux RSS de forums surveilles. */
export const FLUX_FORUMS = [
  'https://forums.expo.dev/latest.rss',
  'https://developer.apple.com/forums/feed/app-store-distribution',
]

/** Extrait le contenu d'une balise XML, en gerant les sections CDATA. */
function extraireBalise(bloc: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))\\s*</${tag}>`, 'i')
  const m = re.exec(bloc)
  if (!m) return null
  const valeur = m[1] ?? m[2] ?? ''
  return decoderEntitesHtml(valeur.trim())
}

/**
 * Parse un flux RSS sans dependance XML : extrait les blocs <item> puis leurs
 * balises usuelles. Volontairement tolerant : un flux mal forme ne doit jamais lever.
 *
 * Cas particulier de la date : un pubDate absent est un cas legitime (beaucoup de
 * forums l'omettent) et retombe sur la date courante, valide par construction.
 * En revanche un pubDate present mais illisible (garbage) est rejete : on ignore
 * le post plutot que de laisser filer une Invalid Date.
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
    const auteur = versAuteur(extraireBalise(bloc, 'dc:creator'))

    let publieLe: Date | null
    if (pubDate === null) {
      publieLe = new Date()
    } else {
      publieLe = dateValideOuNull(new Date(pubDate))
      if (!publieLe) {
        console.warn(`[radar] forum : item "${titre}" ignore (pubDate illisible : ${pubDate})`)
        continue
      }
    }

    posts.push({
      id: `forum:${lien}`,
      source: 'forum',
      url: lien,
      auteur,
      titre,
      contenu: description,
      publieLe,
    })
  }
  return posts
}

/**
 * Recupere et parse les flux RSS des forums surveilles.
 * Toute panne unitaire est avalee : un flux indisponible ou trop volumineux ne casse pas la collecte.
 */
export async function collecterRss(): Promise<RawPost[]> {
  const vus = new Set<string>()
  const posts: RawPost[] = []

  for (const flux of FLUX_FORUMS) {
    const xml = await recupererTexte({ source: 'forum', url: flux })
    if (xml === null) continue

    for (const p of parserRss(xml)) {
      if (vus.has(p.id)) continue
      vus.add(p.id)
      posts.push(p)
    }
  }
  return posts
}
