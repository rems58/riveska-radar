// tests/collectors/reddit.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { collecterReddit, SUBREDDITS } from '../../src/collectors/reddit.ts'

afterEach(() => vi.restoreAllMocks())

describe('collecterReddit', () => {
  it('surveille les subreddits de developpement mobile', () => {
    expect(SUBREDDITS).toContain('reactnative')
    expect(SUBREDDITS).toContain('expo')
    expect(SUBREDDITS).toContain('iOSProgramming')
  })

  it('convertit une reponse Reddit en RawPost', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 }),
      )
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            data: {
              children: [
                {
                  data: {
                    id: 'abc123',
                    author: 'bob',
                    title: 'App rejected',
                    selftext: 'guideline 4.2.6',
                    permalink: '/r/expo/comments/abc123/app_rejected/',
                    created_utc: 1_760_000_000,
                  },
                },
              ],
            },
          }),
          { status: 200 },
        ),
      )
    vi.stubGlobal('fetch', fetchMock)

    const posts = await collecterReddit({ clientId: 'id', clientSecret: 'secret', userAgent: 'ua' })

    expect(posts.length).toBeGreaterThan(0)
    const p = posts[0]!
    expect(p.id).toBe('reddit:abc123')
    expect(p.source).toBe('reddit')
    expect(p.auteur).toBe('bob')
    expect(p.url).toBe('https://reddit.com/r/expo/comments/abc123/app_rejected/')
    expect(p.contenu).toBe('guideline 4.2.6')
    expect(p.publieLe).toBeInstanceOf(Date)
  })

  it('renvoie un tableau vide si le token est refuse', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('unauthorized', { status: 401 })))
    const posts = await collecterReddit({ clientId: 'id', clientSecret: 'bad', userAgent: 'ua' })
    expect(posts).toEqual([])
  })

  it('deduplique les posts remontes par plusieurs subreddits', async () => {
    const meme = {
      data: {
        children: [
          {
            data: {
              id: 'dup1', author: 'bob', title: 'app rejected', selftext: '',
              permalink: '/r/expo/comments/dup1/x/', created_utc: 1_760_000_000,
            },
          },
        ],
      },
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 }),
      )
      .mockResolvedValue(new Response(JSON.stringify(meme), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const posts = await collecterReddit({ clientId: 'id', clientSecret: 's', userAgent: 'ua' })
    const ids = posts.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('renvoie un tableau vide si le fetch du token rejette (panne reseau)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('reseau indisponible')))
    const posts = await collecterReddit({ clientId: 'id', clientSecret: 'secret', userAgent: 'ua' })
    expect(posts).toEqual([])
  })

  it('remplace un auteur null par "inconnu", jamais null dans le RawPost', async () => {
    const reponse = {
      data: {
        children: [
          {
            data: {
              id: 'susp1', author: null, title: 'compte suspendu', selftext: '',
              permalink: '/r/expo/comments/susp1/x/', created_utc: 1_760_000_000,
            },
          },
        ],
      },
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 }))
      .mockResolvedValue(new Response(JSON.stringify(reponse), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const posts = await collecterReddit({ clientId: 'id', clientSecret: 's', userAgent: 'ua' })
    const post = posts.find((p) => p.id === 'reddit:susp1')
    expect(post).toBeDefined()
    expect(post!.auteur).toBe('inconnu')
    expect(post!.auteur).not.toBeNull()
  })

  it('ignore un post dont created_utc est absent, sans Invalid Date', async () => {
    const reponse = {
      data: {
        children: [
          {
            data: {
              id: 'nodate1', author: 'bob', title: 'sans date', selftext: '',
              permalink: '/r/expo/comments/nodate1/x/',
              // created_utc absent
            },
          },
        ],
      },
    }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 }))
      .mockResolvedValue(new Response(JSON.stringify(reponse), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const posts = await collecterReddit({ clientId: 'id', clientSecret: 's', userAgent: 'ua' })
    expect(posts.find((p) => p.id === 'reddit:nodate1')).toBeUndefined()
    expect(posts.some((p) => Number.isNaN(p.publieLe.getTime()))).toBe(false)
  })

  it('renvoie un tableau vide sans lever si children n est pas un tableau', async () => {
    const reponse = { data: { children: { pas: 'un tableau' } } }
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'tok' }), { status: 200 }))
      .mockResolvedValue(new Response(JSON.stringify(reponse), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const posts = await collecterReddit({ clientId: 'id', clientSecret: 's', userAgent: 'ua' })
    expect(posts).toEqual([])
  })
})
