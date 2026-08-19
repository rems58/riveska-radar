import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { parseConfig, getConfig, resetConfig } from '../src/config.ts'

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

  it('une chaine vide donne la valeur par defaut (pas 0)', () => {
    const cfg = parseConfig({ ...valide, SCORE_THRESHOLD: '' })
    expect(cfg.scoreThreshold).toBe(60)
  })

  it('une chaine vide donne la valeur par defaut pour les autres champs numeriques', () => {
    const cfg = parseConfig({ ...valide, MAX_POST_AGE_DAYS: '', RETENTION_DAYS: '' })
    expect(cfg.maxPostAgeDays).toBe(30)
    expect(cfg.retentionDays).toBe(90)
  })

  it('une chaine faite uniquement d espaces donne la valeur par defaut', () => {
    const cfg = parseConfig({ ...valide, SCORE_THRESHOLD: '   ' })
    expect(cfg.scoreThreshold).toBe(60)
  })

  it('une valeur non numerique leve une erreur', () => {
    expect(() => parseConfig({ ...valide, SCORE_THRESHOLD: 'beaucoup' })).toThrow()
  })

  it('une vraie valeur numerique est bien coercee', () => {
    const cfg = parseConfig({ ...valide, SCORE_THRESHOLD: '80' })
    expect(cfg.scoreThreshold).toBe(80)
  })

  it('rejette une cle privee tronquee au premier retour a la ligne (sans guillemets)', () => {
    // Reproduit exactement ce que process.loadEnvFile produit pour une valeur non
    // guillemetee contenant de vrais retours a la ligne : coupee des le premier,
    // BEGIN present mais END absent.
    expect(() => parseConfig({ ...valide, GOOGLE_SA_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----' })).toThrow(
      /GOOGLE_SA_PRIVATE_KEY/,
    )
  })

  it('le message d erreur de la cle privee tronquee oriente vers les guillemets doubles', () => {
    try {
      parseConfig({ ...valide, GOOGLE_SA_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----' })
      expect.unreachable('parseConfig aurait du lever')
    } catch (err) {
      expect(String(err)).toContain('guillemets')
    }
  })

  it('accepte une cle privee complete (BEGIN et END presents apres restauration des \\n)', () => {
    const cfg = parseConfig({
      ...valide,
      GOOGLE_SA_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nMIIabc123\\n-----END PRIVATE KEY-----\\n',
    })
    expect(cfg.googleSaPrivateKey).toContain('-----BEGIN PRIVATE KEY-----')
    expect(cfg.googleSaPrivateKey).toContain('-----END PRIVATE KEY-----')
    expect(cfg.googleSaPrivateKey).not.toContain('\\n')
  })

  it('n exige plus les identifiants Reddit (source facultative, API fermee)', () => {
    const { REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET, REDDIT_USER_AGENT, ...sansReddit } = valide
    const cfg = parseConfig(sansReddit)
    expect(cfg.redditClientId).toBeUndefined()
    expect(cfg.redditClientSecret).toBeUndefined()
    expect(cfg.redditUserAgent).toBeUndefined()
  })

  it('une variable Reddit vide se comporte comme absente (pas une chaine vide truthy)', () => {
    const cfg = parseConfig({ ...valide, REDDIT_CLIENT_ID: '', REDDIT_CLIENT_SECRET: '', REDDIT_USER_AGENT: '' })
    expect(cfg.redditClientId).toBeUndefined()
  })
})

describe('getConfig', () => {
  const envSauvegarde = { ...process.env }

  beforeEach(() => {
    resetConfig()
    process.env = { ...envSauvegarde }
    process.env.REDDIT_CLIENT_ID = 'id'
    process.env.REDDIT_CLIENT_SECRET = 'secret'
    process.env.REDDIT_USER_AGENT = 'riveska-radar/0.1'
    process.env.TELEGRAM_BOT_TOKEN = 'token'
    process.env.TELEGRAM_CHAT_ID = '123'
    process.env.GOOGLE_SA_EMAIL = 'sa@projet.iam.gserviceaccount.com'
    process.env.GOOGLE_SA_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----'
    process.env.SHEET_ID = 'sheet'
    process.env.OPENROUTER_API_KEY = 'or'
  })

  afterEach(() => {
    resetConfig()
    process.env = { ...envSauvegarde }
  })

  it('lit process.env et met en cache le resultat', () => {
    process.env.SHEET_ID = 'sheet-un'
    const cfg1 = getConfig()
    expect(cfg1.sheetId).toBe('sheet-un')

    process.env.SHEET_ID = 'sheet-deux'
    const cfg2 = getConfig()
    expect(cfg2).toBe(cfg1)
    expect(cfg2.sheetId).toBe('sheet-un')
  })

  it('apres resetConfig, une modification de process.env est reprise en compte', () => {
    process.env.SHEET_ID = 'sheet-un'
    const cfg1 = getConfig()
    expect(cfg1.sheetId).toBe('sheet-un')

    resetConfig()
    process.env.SHEET_ID = 'sheet-deux'
    const cfg2 = getConfig()
    expect(cfg2.sheetId).toBe('sheet-deux')
    expect(cfg2).not.toBe(cfg1)
  })
})
