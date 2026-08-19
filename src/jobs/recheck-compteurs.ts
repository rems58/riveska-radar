import { recupererJson } from '../collectors/http.ts'

/**
 * Compte les reponses d'un post pour le suivi 48h (jobs/recheck.ts).
 *
 * Couverture PARTIELLE et assumee : Hacker News et Stack Overflow exposent une API
 * publique adaptee (API Algolia, API StackExchange). Reddit, Bluesky, Mastodon et les
 * forums RSS n'en ont pas (ou plus) d'equivalent - ces sources renvoient -1 (inconnu).
 * C'est documente dans le README : ce n'est pas une couverture universelle, et il ne
 * faut pas laisser croire le contraire.
 * Ne leve jamais : recupererJson (couche http commune) ne leve jamais non plus.
 */

export interface OptionsCompterReponses {
  /**
   * Conserve pour compatibilite d'API mais IGNORE : voir compterReponsesReddit.
   * @deprecated N'a plus d'effet - Reddit ne fait plus l'objet d'un suivi 48h.
   */
  redditUserAgent?: string
}

/**
 * Reddit n'a JAMAIS de suivi 48h, quelle que soit la source qui a collecte le post
 * (API OAuth desactivee, ou search.rss). Compter les reponses d'un post precis
 * demanderait de taper l'endpoint JSON par-post (`<url>.json`) - un chemin `/.json`
 * au meme titre que `/new.json`/`/search.json`, que Reddit garde deliberement ferme
 * (403/401 mesures, Responsible Builder Policy). C'est une CONTRAINTE, pas une
 * preference : on ne le contourne jamais, meme quand REDDIT_USER_AGENT est configure
 * pour une autre raison. Renvoie -1 (inconnu) inconditionnellement, sans appel reseau.
 */
function compterReponsesReddit(): number {
  return -1
}

interface ItemHackerNews {
  children?: unknown
}

function idHackerNews(url: string): string | null {
  try {
    return new URL(url).searchParams.get('id')
  } catch {
    return null
  }
}

/**
 * Compte les enfants DIRECTS de l'item Algolia (top-level, comme Reddit qui ne
 * compte pas non plus les reponses aux reponses) : suffisant pour detecter
 * "personne n'a repondu", qui est tout ce que jobs/recheck.ts a besoin de savoir.
 */
async function compterReponsesHackerNews(url: string): Promise<number> {
  const id = idHackerNews(url)
  if (!id) return -1

  const item = await recupererJson<ItemHackerNews>({
    source: 'recheck-hackernews',
    url: `https://hn.algolia.com/api/v1/items/${id}`,
  })

  return Array.isArray(item?.children) ? item.children.length : -1
}

interface ReponseStackExchange {
  items?: { answer_count?: unknown }[]
}

function idStackOverflow(url: string): string | null {
  return /\/questions\/(\d+)/.exec(url)?.[1] ?? null
}

async function compterReponsesStackOverflow(url: string): Promise<number> {
  const id = idStackOverflow(url)
  if (!id) return -1

  const reponse = await recupererJson<ReponseStackExchange>({
    source: 'recheck-stackoverflow',
    url: `https://api.stackexchange.com/2.3/questions/${id}?site=stackoverflow`,
  })

  const compte = reponse?.items?.[0]?.answer_count
  return typeof compte === 'number' ? compte : -1
}

/**
 * Aiguille vers le compteur adapte a la source de l'URL. Renvoie -1 (inconnu, pas
 * une erreur) pour toute URL non reconnue - jamais d'exception.
 */
export async function compterReponses(url: string, _o: OptionsCompterReponses = {}): Promise<number> {
  if (/^https:\/\/(www\.)?reddit\.com\//.test(url)) return compterReponsesReddit()
  if (/^https:\/\/news\.ycombinator\.com\//.test(url)) return compterReponsesHackerNews(url)
  if (/^https:\/\/(www\.)?stackoverflow\.com\//.test(url)) return compterReponsesStackOverflow(url)
  return -1
}
