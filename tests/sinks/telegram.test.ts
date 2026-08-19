import { describe, it, expect, vi, afterEach } from 'vitest'
import { formaterProspect, envoyerTelegram } from '../../src/sinks/telegram.ts'
import type { EnrichedPost } from '../../src/types.ts'

afterEach(() => vi.restoreAllMocks())

const post: EnrichedPost = {
  id: 'reddit:1', source: 'reddit', url: 'https://reddit.com/1', auteur: 'bob',
  titre: 'App rejected', contenu: 'guideline 4.2.6', publieLe: new Date(),
  score: 88, langue: 'en', probleme: 'rejet 4.2.6 sur app vibe-codee',
  traductionFr: 'App rejetee', brouillon: 'Salut, ...',
}

describe('formaterProspect', () => {
  it('inclut score, source, langue, probleme et lien', () => {
    const t = formaterProspect(post, 47)
    expect(t).toContain('88')
    expect(t).toContain('reddit')
    expect(t).toContain('EN')
    expect(t).toContain('rejet 4.2.6 sur app vibe-codee')
    expect(t).toContain('https://reddit.com/1')
    expect(t).toContain('47')
  })

  it('fonctionne sans numero de ligne', () => {
    const t = formaterProspect(post, null)
    expect(t).toContain('https://reddit.com/1')
  })
})

describe('envoyerTelegram', () => {
  it('poste le message sur l API Telegram', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const ok = await envoyerTelegram('coucou', { token: 'T', chatId: '42' })
    expect(ok).toBe(true)
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.telegram.org/botT/sendMessage')
    const body = JSON.parse((init as RequestInit).body as string)
    expect(body.chat_id).toBe('42')
    expect(body.text).toBe('coucou')
  })

  it('renvoie false si Telegram echoue', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('err', { status: 400 })))
    expect(await envoyerTelegram('x', { token: 'T', chatId: '42' })).toBe(false)
  })

  it('renvoie false en cas d erreur reseau', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    expect(await envoyerTelegram('x', { token: 'T', chatId: '42' })).toBe(false)
  })

  it('tronque le texte au dela de 4096 caracteres', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const long = 'z'.repeat(5000)
    await envoyerTelegram(long, { token: 'T', chatId: '42' })
    const [, init] = fetchMock.mock.calls[0]!
    const body = JSON.parse((init as RequestInit).body as string)
    expect((body.text as string).length).toBeLessThanOrEqual(4096)
  })

  it('ne fait jamais fuiter le token secret dans les logs en cas d echec', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('err', { status: 400 })))
    await envoyerTelegram('x', { token: 'SECRET_TOKEN_123', chatId: '42' })

    const fetchErrSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
    await envoyerTelegram('x', { token: 'SECRET_TOKEN_123', chatId: '42' })

    const tousLesAppels = [...warnSpy.mock.calls, ...fetchErrSpy.mock.calls].flat()
    for (const arg of tousLesAppels) {
      expect(String(arg)).not.toContain('SECRET_TOKEN_123')
    }
  })
})
