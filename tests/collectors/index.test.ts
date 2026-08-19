import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { collecterTout, collecteursParDefaut } from '../../src/collectors/index.ts'
import { resetConfig } from '../../src/config.ts'
import type { RawPost } from '../../src/types.ts'

afterEach(() => vi.restoreAllMocks())

function faux(id: string): RawPost {
  return {
    id, source: 'reddit', url: `https://x/${id}`, auteur: 'bob',
    titre: 't', contenu: 'c', publieLe: new Date(),
  }
}

describe('collecterTout', () => {
  it('concatene les resultats de toutes les sources', async () => {
    const posts = await collecterTout([
      { nom: 'a', collecter: async () => [faux('a')] },
      { nom: 'b', collecter: async () => [faux('b')] },
    ])
    expect(posts.map((p) => p.id).sort()).toEqual(['a', 'b'])
  })

  it('ignore une source en panne sans perdre les autres', async () => {
    const posts = await collecterTout([
      { nom: 'a', collecter: async () => [faux('a')] },
      { nom: 'source-hs', collecter: async () => { throw new Error('source HS') } },
      { nom: 'c', collecter: async () => [faux('c')] },
    ])
    expect(posts.map((p) => p.id).sort()).toEqual(['a', 'c'])
  })

  it('deduplique les ids identiques entre sources', async () => {
    const posts = await collecterTout([
      { nom: 'a', collecter: async () => [faux('a')] },
      { nom: 'b', collecter: async () => [faux('a')] },
    ])
    expect(posts).toHaveLength(1)
  })

  it('journalise le nom de la source en echec', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await collecterTout([
      { nom: 'reddit', collecter: async () => { throw new Error('token refuse') } },
    ])
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const [message] = warnSpy.mock.calls[0]!
    expect(String(message)).toContain('reddit')
  })

  it('signale une source qui renvoie 0 post alors que d autres en renvoient (flux probablement casse)', async () => {
    const onSourceVide = vi.fn()
    await collecterTout(
      [
        { nom: 'a', collecter: async () => [faux('a')] },
        { nom: 'source-muette', collecter: async () => [] },
      ],
      onSourceVide,
    )
    expect(onSourceVide).toHaveBeenCalledTimes(1)
    expect(onSourceVide).toHaveBeenCalledWith('source-muette')
  })

  it('ne signale rien si toutes les sources renvoient 0 (pas d anomalie relative)', async () => {
    const onSourceVide = vi.fn()
    await collecterTout(
      [
        { nom: 'a', collecter: async () => [] },
        { nom: 'b', collecter: async () => [] },
      ],
      onSourceVide,
    )
    expect(onSourceVide).not.toHaveBeenCalled()
  })

  it('ne signale rien pour une source en echec (deja couverte par le warn d echec, pas un double signal)', async () => {
    const onSourceVide = vi.fn()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await collecterTout(
      [
        { nom: 'a', collecter: async () => [faux('a')] },
        { nom: 'source-hs', collecter: async () => { throw new Error('HS') } },
      ],
      onSourceVide,
    )
    expect(onSourceVide).not.toHaveBeenCalled()
  })

  it('sans callback fourni, journalise par defaut un avertissement explicite', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await collecterTout([
      { nom: 'a', collecter: async () => [faux('a')] },
      { nom: 'source-muette', collecter: async () => [] },
    ])
    const messages = warnSpy.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => m.includes('source-muette'))).toBe(true)
  })
})

describe('collecteursParDefaut', () => {
  const envSauvegarde = { ...process.env }

  beforeEach(() => {
    resetConfig()
    process.env = { ...envSauvegarde }
    process.env.TELEGRAM_BOT_TOKEN = 'token'
    process.env.TELEGRAM_CHAT_ID = '123'
    process.env.GOOGLE_SA_EMAIL = 'sa@projet.iam.gserviceaccount.com'
    process.env.GOOGLE_SA_PRIVATE_KEY = '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----'
    process.env.SHEET_ID = 'sheet'
    process.env.OPENROUTER_API_KEY = 'or'
    delete process.env.REDDIT_CLIENT_ID
    delete process.env.REDDIT_CLIENT_SECRET
    delete process.env.REDDIT_USER_AGENT
    delete process.env.BLUESKY_ID
    delete process.env.BLUESKY_APP_PASSWORD
  })

  afterEach(() => {
    resetConfig()
    process.env = { ...envSauvegarde }
  })

  it('exclut reddit et bluesky de la liste quand leurs identifiants sont absents', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const sources = collecteursParDefaut()
    const noms = sources.map((s) => s.nom)
    expect(noms).not.toContain('reddit')
    expect(noms).not.toContain('bluesky')
    expect(noms).toEqual(['hackernews', 'stackoverflow', 'mastodon'])
    // Signale une fois chacun, pour rester diagnosticable sans etre confondu par
    // le garde-fou "source vide" (qui ne voit meme pas ces sources exclues).
    const messages = warnSpy.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => m.includes('reddit'))).toBe(true)
    expect(messages.some((m) => m.includes('bluesky'))).toBe(true)
  })

  it('inclut reddit quand ses trois identifiants sont presents', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.REDDIT_CLIENT_ID = 'id'
    process.env.REDDIT_CLIENT_SECRET = 'secret'
    process.env.REDDIT_USER_AGENT = 'ua'
    const noms = collecteursParDefaut().map((s) => s.nom)
    expect(noms).toContain('reddit')
  })

  it('inclut bluesky quand ses deux identifiants sont presents', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    process.env.BLUESKY_ID = 'moi.bsky.social'
    process.env.BLUESKY_APP_PASSWORD = 'xxxx-xxxx-xxxx-xxxx'
    const noms = collecteursParDefaut().map((s) => s.nom)
    expect(noms).toContain('bluesky')
  })

  it('une source exclue de la liste ne declenche jamais le garde-fou "source vide"', async () => {
    // Regression du fix : reddit/bluesky desactives ne doivent jamais etre
    // confondus avec un flux casse par collecterTout, puisqu'ils n'apparaissent
    // meme pas dans la liste passee a collecterTout.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const onSourceVide = vi.fn()
    const sources = collecteursParDefaut()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 })))
    await collecterTout(sources, onSourceVide)
    expect(onSourceVide).not.toHaveBeenCalledWith('reddit')
    expect(onSourceVide).not.toHaveBeenCalledWith('bluesky')
  })
})
