import { z } from 'zod'

const schema = z.object({
  REDDIT_CLIENT_ID: z.string().min(1),
  REDDIT_CLIENT_SECRET: z.string().min(1),
  REDDIT_USER_AGENT: z.string().min(1),
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_CHAT_ID: z.string().min(1),
  GOOGLE_SA_EMAIL: z.string().min(1),
  GOOGLE_SA_PRIVATE_KEY: z.string().min(1),
  SHEET_ID: z.string().min(1),
  SHEET_TAB: z.string().default('Prospects'),
  OPENROUTER_API_KEY: z.string().min(1),
  OPENROUTER_MODEL: z.string().default('google/gemini-3.5-flash'),
  SCORE_THRESHOLD: z.coerce.number().default(60),
  MAX_POST_AGE_DAYS: z.coerce.number().default(30),
  RETENTION_DAYS: z.coerce.number().default(90),
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
    // Les cles privees stockees en .env portent des \n echappes : il faut les restaurer.
    googleSaPrivateKey: v.GOOGLE_SA_PRIVATE_KEY.replace(/\\n/g, '\n'),
    sheetId: v.SHEET_ID,
    sheetTab: v.SHEET_TAB,
    openrouterApiKey: v.OPENROUTER_API_KEY,
    openrouterModel: v.OPENROUTER_MODEL,
    scoreThreshold: v.SCORE_THRESHOLD,
    maxPostAgeDays: v.MAX_POST_AGE_DAYS,
    retentionDays: v.RETENTION_DAYS,
  }
}

let cache: Config | null = null

export function getConfig(): Config {
  if (!cache) cache = parseConfig(process.env)
  return cache
}
