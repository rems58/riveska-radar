import { decoderEntitesHtml } from './http.ts'

/**
 * Utilitaires de parsing RSS/Atom, sans dependance XML : partages par tout
 * consommateur de flux (aujourd'hui : src/jobs/triggers.ts, qui surveille les
 * annonces Apple/Google). Volontairement tolerants : un flux mal forme ne doit
 * jamais lever.
 *
 * Il n'y a plus de collecteur "forum" ici : les deux flux qui l'alimentaient
 * (forums.expo.dev/latest.rss, developer.apple.com/forums/feed/app-store-distribution)
 * sont morts, verifie en appel reel le 2026-08-19 - Expo redirige entierement vers
 * Discord (qui n'expose aucune API RSS), et Apple bloque les requetes automatisees
 * derriere une verification anti-bot (redirection vers /forums/verify-human/).
 * Aucun flux de remplacement fonctionnel n'a ete trouve pour ce role. Voir README.
 */

/**
 * Extrait le contenu d'une balise XML, en gerant les sections CDATA.
 */
export function extraireBalise(bloc: string, tag: string): string | null {
  const re = new RegExp(`<${tag}[^>]*>\\s*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))\\s*</${tag}>`, 'i')
  const m = re.exec(bloc)
  if (!m) return null
  const valeur = m[1] ?? m[2] ?? ''
  return decoderEntitesHtml(valeur.trim())
}

/**
 * Extrait les blocs <item>...</item> (RSS) ET <entry>...</entry> (Atom) d'un flux.
 * Un flux donne n'utilise jamais les deux formats a la fois : additionner les deux
 * recherches est donc sans risque et couvre les deux cas sans avoir a detecter le
 * format en amont. Sans le support Atom, un flux Atom valide (ex: les blogs Blogger/
 * Google, format par defaut) rendait silencieusement 0 item.
 */
export function extraireBlocsItem(xml: string): string[] {
  const items = xml.match(/<item[^>]*>[\s\S]*?<\/item>/gi) ?? []
  const entrees = xml.match(/<entry[^>]*>[\s\S]*?<\/entry>/gi) ?? []
  return [...items, ...entrees]
}

/**
 * Extrait l'URL "lisible" d'un bloc <item> (RSS) ou <entry> (Atom).
 * RSS : <link>URL en texte</link>.
 * Atom : plusieurs <link .../> auto-fermantes avec un attribut href ; on prend
 * celle marquee rel="alternate" (la page HTML), ou a defaut la premiere avec un href -
 * un <link> Atom n'a jamais de contenu texte, extraireBalise (qui cherche une balise
 * fermante) ne peut donc jamais l'extraire seul.
 */
export function extraireLien(bloc: string): string | null {
  const texte = extraireBalise(bloc, 'link')
  if (texte) return texte

  const liens = bloc.match(/<link\b[^>]*\/?>/gi) ?? []
  const alternatif = liens.find((l) => /rel=["']alternate["']/i.test(l))
  const choisi = alternatif ?? liens[0]
  if (!choisi) return null
  const m = /href=["']([^"']+)["']/i.exec(choisi)
  return m?.[1] ?? null
}
