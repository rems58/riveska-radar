/** Post brut renvoye par un collecteur, avant tout traitement. */
export interface RawPost {
  /** Identifiant stable et unique, prefixe par la source : "reddit:t3_abc123" */
  id: string
  source: 'reddit' | 'hackernews' | 'stackoverflow' | 'bluesky' | 'mastodon' | 'forum'
  url: string
  auteur: string
  titre: string
  contenu: string
  /** Date de publication du post d'origine. */
  publieLe: Date
}

/** Post retenu par le filtre mots-cles puis note par le LLM. */
export interface ScoredPost extends RawPost {
  score: number
  langue: 'fr' | 'en' | 'es' | 'it' | 'de'
  probleme: string
}

/** Post note, traduit et accompagne d'un brouillon : pret pour le Sheet. */
export interface EnrichedPost extends ScoredPost {
  traductionFr: string
  brouillon: string
}
