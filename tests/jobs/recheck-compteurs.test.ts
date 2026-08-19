import { describe, it, expect, vi, afterEach } from 'vitest'
import { compterReponses } from '../../src/jobs/recheck-compteurs.ts'

afterEach(() => vi.restoreAllMocks())

const OPTS = { redditUserAgent: 'riveska-radar/test' }

describe('compterReponses - Reddit', () => {
  it('compte les commentaires du second element du listing JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify([{ data: {} }, { data: { children: [1, 2, 3] } }]),
        { status: 200 },
      ),
    )
    vi.stubGlobal('fetch', fetchMock)

    const r = await compterReponses('https://reddit.com/r/x/comments/abc/titre/', OPTS)

    expect(r).toBe(3)
    const [urlAppelee, init] = fetchMock.mock.calls[0]!
    expect(String(urlAppelee)).toContain('.json')
    expect((init?.headers as Record<string, string>)['User-Agent']).toBe('riveska-radar/test')
  })

  it('renvoie -1 si le JSON ne ressemble pas au listing attendu', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 })))
    const r = await compterReponses('https://reddit.com/r/x/comments/abc/titre/', OPTS)
    expect(r).toBe(-1)
  })

  it('renvoie -1 si la requete echoue', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('reseau HS')))
    const r = await compterReponses('https://reddit.com/r/x/comments/abc/titre/', OPTS)
    expect(r).toBe(-1)
  })
})

describe('compterReponses - Hacker News', () => {
  it('compte les enfants directs de l item Algolia', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ children: [{}, {}] } ), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const r = await compterReponses('https://news.ycombinator.com/item?id=12345', OPTS)

    expect(r).toBe(2)
    const [urlAppelee] = fetchMock.mock.calls[0]!
    expect(String(urlAppelee)).toContain('12345')
    expect(String(urlAppelee)).toContain('hn.algolia.com')
  })

  it('renvoie -1 si l url ne contient pas d id exploitable', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const r = await compterReponses('https://news.ycombinator.com/item', OPTS)
    expect(r).toBe(-1)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('compterReponses - Stack Overflow', () => {
  it('lit answer_count sur la question renvoyee par l API StackExchange', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: [{ answer_count: 4 }] }), { status: 200 }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const r = await compterReponses('https://stackoverflow.com/questions/999/titre-de-la-question', OPTS)

    expect(r).toBe(4)
    const [urlAppelee] = fetchMock.mock.calls[0]!
    expect(String(urlAppelee)).toContain('999')
    expect(String(urlAppelee)).toContain('api.stackexchange.com')
  })

  it('renvoie -1 si items est vide', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 })))
    const r = await compterReponses('https://stackoverflow.com/questions/999/titre', OPTS)
    expect(r).toBe(-1)
  })
})

describe('compterReponses - sources non geres', () => {
  it('renvoie -1 sans appel reseau pour Bluesky, Mastodon et les autres URL (forums RSS...)', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    expect(await compterReponses('https://bsky.app/profile/x/post/1', OPTS)).toBe(-1)
    expect(await compterReponses('https://mastodon.social/@x/1', OPTS)).toBe(-1)
    expect(await compterReponses('https://example-forum.test/thread/1', OPTS)).toBe(-1)

    expect(fetchMock).not.toHaveBeenCalled()
  })
})
