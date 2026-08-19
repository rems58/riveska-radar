import { z } from 'zod'

/**
 * Coercition numerique tolerante : une valeur absente ou une chaine vide/blanche
 * doit tomber sur la valeur par defaut, pas etre coercee en 0. z.coerce.number()
 * seul convertit '' en 0. Le .default() doit etre sur le schema INTERIEUR
 * (apres le preprocess) pour s'appliquer une fois '' transformee en undefined :
 * un .default() pose sur le wrapper exterieur ne verrait jamais cet undefined,
 * puisque le preprocess tourne avant lui sur la valeur brute ''.
 */
function nombreOptionnel(valeurDefaut: number) {
  return z.preprocess((valeur) => {
    if (typeof valeur === 'string' && valeur.trim() === '') return undefined
    return valeur
  }, z.coerce.number().default(valeurDefaut))
}

/**
 * Meme logique que nombreOptionnel, pour une chaine facultative : un .env qui
 * declare la variable vide (BLUESKY_ID=) doit se comporter comme une variable
 * absente, pas comme une chaine vide truthy passee plus loin dans le pipeline.
 */
function chaineOptionnelle() {
  return z.preprocess(
    (valeur) => (typeof valeur === 'string' && valeur.trim() === '' ? undefined : valeur),
    z.string().optional(),
  )
}

/**
 * Restaure les \n echappes (stockage .env sur une ligne) en vrais sauts de ligne,
 * puis verifie que le resultat ressemble a une cle PEM complete. Mesure reelle :
 * une cle collee SANS guillemets doubles dans le .env est coupee au premier retour
 * a la ligne par process.loadEnvFile (27 caracteres obtenus au lieu de ~1700, BEGIN
 * present mais END absent) - z.string().min(1) laissait passer ce fragment sans rien
 * signaler, et chaque appel Google Sheets echouait ensuite en silence (echec
 * technique -> le prospect disparait au bout de MAX_ECHECS_TECHNIQUES runs).
 * Bloquer ici, bruyamment, au demarrage, coute infiniment moins cher.
 */
const cleGooglePrivee = z
  .string()
  .min(1)
  .transform((v) => v.replace(/\\n/g, '\n'))
  .refine((v) => v.includes('-----BEGIN PRIVATE KEY-----') && v.includes('-----END PRIVATE KEY-----'), {
    message:
      'GOOGLE_SA_PRIVATE_KEY ne ressemble pas a une cle privee PEM complete ' +
      '(BEGIN/END manquant apres restauration des \\n). Cause la plus frequente : ' +
      'la valeur n\'est pas entre guillemets doubles dans le .env et a ete coupee au ' +
      'premier retour a la ligne. Entoure toute la valeur de guillemets doubles, ' +
      'voir README > "Ou obtenir chaque identifiant".',
  })

const schema = z.object({
  REDDIT_CLIENT_ID: z.string().min(1),
  REDDIT_CLIENT_SECRET: z.string().min(1),
  REDDIT_USER_AGENT: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHAT_ID: z.string().min(1),
  GOOGLE_SA_EMAIL: z.string().min(1),
  GOOGLE_SA_PRIVATE_KEY: cleGooglePrivee,
  SHEET_ID: z.string().min(1),
  SHEET_TAB: z.string().default('Prospects'),
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_MODEL: z.string().default('google/gemini-3.5-flash'),
  SCORE_THRESHOLD: nombreOptionnel(60),
  MAX_POST_AGE_DAYS: nombreOptionnel(30),
  RETENTION_DAYS: nombreOptionnel(90),
  // Facultatifs : la recherche Bluesky non authentifiee renvoie 403 (verifie en
  // reel le 2026-08-19, endpoint public.api.bsky.app) - sans ces identifiants,
  // le collecteur se desactive proprement plutot que d'echouer a chaque run.
  BLUESKY_ID: chaineOptionnelle(),
  BLUESKY_APP_PASSWORD: chaineOptionnelle(),
})

export interface Config {
  redditClientId: string
  redditClientSecret: string
  redditUserAgent: string
  telegramBotToken: string
  telegramChatId: string
  googleSaEmail: string
  googleSaPrivateKey: string
  sheetId: string
  sheetTab: string
  openrouterApiKey: string
  openrouterModel: string
  scoreThreshold: number
  maxPostAgeDays: number
  retentionDays: number
  /** Facultatif : absent -> le collecteur Bluesky se desactive proprement (voir README). */
  blueskyId?: string
  /** Mot de passe d'application Bluesky (pas le mot de passe du compte), facultatif. */
  blueskyAppPassword?: string
}

export function parseConfig(env: Record<string, string | undefined>): Config {
  const v = schema.parse(env)
  return {
    redditClientId: v.REDDIT_CLIENT_ID,
    redditClientSecret: v.REDDIT_CLIENT_SECRET,
    redditUserAgent: v.REDDIT_USER_AGENT,
    telegramBotToken: v.TELEGRAM_BOT_TOKEN,
    telegramChatId: v.TELEGRAM_CHAT_ID,
    googleSaEmail: v.GOOGLE_SA_EMAIL,
    // La restauration des \n echappes et la validation BEGIN/END sont faites par le
    // schema (cleGooglePrivee) : v.GOOGLE_SA_PRIVATE_KEY est deja la cle finale ici.
    googleSaPrivateKey: v.GOOGLE_SA_PRIVATE_KEY,
    sheetId: v.SHEET_ID,
    sheetTab: v.SHEET_TAB,
    openrouterApiKey: v.OPENROUTER_API_KEY,
    openrouterModel: v.OPENROUTER_MODEL,
    scoreThreshold: v.SCORE_THRESHOLD,
    maxPostAgeDays: v.MAX_POST_AGE_DAYS,
    retentionDays: v.RETENTION_DAYS,
    blueskyId: v.BLUESKY_ID,
    blueskyAppPassword: v.BLUESKY_APP_PASSWORD,
  }
}

let cache: Config | null = null

export function getConfig(): Config {
  if (!cache) cache = parseConfig(process.env)
  return cache
}

/** Vide le cache de getConfig(). Utile pour les tests qui modifient process.env. */
export function resetConfig(): void {
  cache = null
}
