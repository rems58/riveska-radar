import { describe, it, expect } from 'vitest'
import { parseConfig } from '../src/config.ts'

describe('parseConfig', () => {
  const valide = {
    REDDIT_CLIENT_ID: 'id',
    REDDIT_CLIENT_SECRET: 'secret',
    REDDIT_USER_AGENT: 'riveska-radar/0.1',
    TELEGRAM_BOT_TOKEN: 'token',
    TELEGRAM_CHAT_ID: '123',
    GOOGLE_SA_EMAIL: 'sa@projet.iam.gserviceaccount.com',
    GOOGLE_SA_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----',
    SHEET_ID: 'sheet',
    OPENROUTER_API_KEY: 'or',
  }

  it('applique les valeurs par defaut', () => {
    const cfg = parseConfig(valide)
    expect(cfg.scoreThreshold).toBe(60)
    expect(cfg.maxPostAgeDays).toBe(30)
    expect(cfg.retentionDays).toBe(90)
    expect(cfg.sheetTab).toBe('Prospects')
  })

  it('convertit les \\n echappes de la cle privee en vrais sauts de ligne', () => {
    const cfg = parseConfig(valide)
    expect(cfg.googleSaPrivateKey).toContain('\n')
    expect(cfg.googleSaPrivateKey).not.toContain('\\n')
  })

  it('rejette une config incomplete', () => {
    expect(() => parseConfig({ ...valide, SHEET_ID: undefined })).toThrow()
  })
})
