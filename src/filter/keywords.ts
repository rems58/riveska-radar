/**
 * Signaux de douleur : la personne est bloquee sur la publication.
 * Tout en minuscules, compares sur du texte normalise sans accents.
 */
export const SIGNAUX_DOULEUR: string[] = [
  // Rejets de store
  'app rejected', 'app was rejected', 'rejected by apple', 'rejected from app store',
  'guideline 4.2.6', 'guideline 4.3', 'metadata rejected', 'binary rejected',
  'app rejetee', 'rejet app store', 'refusee par apple',
  'app abgelehnt', 'ablehnung app store',
  'app rechazada', 'rechazada por apple',
  'app rifiutata', 'rifiutata da apple',
  // Testeurs Google Play
  '12 testers', '20 testers', 'closed testing', 'testers requirement',
  '12 testeurs', '20 testeurs', 'test ferme',
  '12 tester', 'geschlossener test',
  '12 probadores', 'prueba cerrada',
  '12 tester chiusi', 'test chiuso',
  // Build / Mac
  'no mac to build', 'without a mac', 'dont have a mac', 'need a mac to publish',
  'pas de mac', 'sans mac pour', 'besoin d un mac',
  'kein mac', 'ohne mac',
  'sin mac', 'necesito un mac',
  'senza mac', 'non ho un mac',
  // Compte developpeur
  'apple developer account stuck', 'developer account problem', 'd-u-n-s',
  'compte developpeur bloque', 'probleme compte developpeur',
  'entwicklerkonto problem',
  'cuenta de desarrollador problema',
  'account sviluppatore problema',
  // Premiere publication
  'how to publish my app', 'publish my first app', 'help publishing app',
  'cant publish my app', 'struggling to publish',
  'comment publier mon app', 'publier ma premiere app', 'aide pour publier',
  'wie veroeffentliche ich', 'app veroeffentlichen hilfe',
  'como publicar mi app', 'ayuda para publicar',
  'come pubblicare la mia app', 'aiuto per pubblicare',
]

/** Signaux "vibe-code" : la cible exacte de Riveska. */
export const SIGNAUX_VIBECODE: string[] = [
  'bolt.new', 'lovable.dev', 'lovable app', 'rork.app', 'rork ai', 'v0.dev',
  'built with ai', 'vibe coded', 'vibe coding', 'no code app store',
  'code genere par ia', 'app generee par ia',
]

/**
 * Anti-signaux : si present, le post est jete meme s'il contient un signal.
 * Evite les offres d'emploi, la pub d'agences et les articles.
 */
export const ANTI_SIGNAUX: string[] = [
  'we are hiring', 'we re hiring', 'job opening', 'looking to hire', 'hiring now',
  'nous recrutons', 'offre d emploi',
  'wir stellen ein', 'stellenangebot',
  'estamos contratando', 'oferta de empleo',
  'stiamo assumendo', 'offerta di lavoro',
  'our agency offers', 'our service helps you publish', 'dm me for promo',
  'check out my blog post', 'read my article',
]

// Plage des diacritiques combinants Unicode (U+0300 a U+036F), construite a partir
// des points de code pour eviter tout caractere combinant colle dans le source.
const DEBUT_DIACRITIQUES = String.fromCodePoint(0x0300)
const FIN_DIACRITIQUES = String.fromCodePoint(0x036f)
const REGEX_DIACRITIQUES = new RegExp(`[${DEBUT_DIACRITIQUES}-${FIN_DIACRITIQUES}]`, 'g')

/** Enleve les accents et passe en minuscules pour comparer sans surprise. */
export function normaliser(texte: string): string {
  return texte
    .toLowerCase()
    .normalize('NFD')
    .replace(REGEX_DIACRITIQUES, '')
}

// Metacaracteres regex a echapper avant de composer un pattern a partir d'un mot-cle
// brut (ex : le point de "bolt.new" ne doit pas jouer les jokers).
const REGEX_METACARACTERES = /[.*+?^${}()|[\]\\]/g

function echapperRegex(motCle: string): string {
  return motCle.replace(REGEX_METACARACTERES, '\\$&')
}

/**
 * Compile un mot-cle en regex a frontieres de mot, pour eviter les faux positifs
 * par sous-chaine (ex : "no mac to build" ne doit pas matcher dans un mot plus long,
 * "guideline 4.3" ne doit pas matcher "guideline 4.35"). Tous les mots-cles de nos
 * listes commencent et finissent par un caractere alphanumerique, donc \b se comporte
 * normalement aux deux bornes (le cas "d-u-n-s" reste couvert : \b matche entre le
 * debut de chaine/espace et "d", et entre "s" et la fin de chaine/espace ; les tirets
 * internes n'ont pas besoin de \b puisqu'ils font deja partie du mot-cle).
 */
function compilerMotCle(motCle: string): RegExp {
  return new RegExp(`\\b${echapperRegex(motCle)}\\b`)
}

/**
 * Regex precompilees au chargement du module (pas a chaque appel de prefiltrer,
 * qui tourne sur des centaines de posts).
 */
export const REGEX_SIGNAUX: RegExp[] = [...SIGNAUX_DOULEUR, ...SIGNAUX_VIBECODE].map(compilerMotCle)
export const REGEX_ANTI_SIGNAUX: RegExp[] = ANTI_SIGNAUX.map(compilerMotCle)
