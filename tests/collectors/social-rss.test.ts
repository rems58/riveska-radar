// tests/collectors/social-rss.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { collecterBluesky } from '../../src/collectors/bluesky.ts'
import { collecterMastodon } from '../../src/collectors/mastodon.ts'

afterEach(() => vi.restoreAllMocks())

describe('collecterBluesky', () => {
  it('se desactive proprement (log explicite, tableau vide) sans identifiants', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const posts = await collecterBluesky()

    expect(posts).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(String(warnSpy.mock.calls[0]![0])).toContain('BLUESKY_ID')
  })

  it('se desactive aussi si un seul des deux identifiants est fourni', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const posts = await collecterBluesky({ id: 'moi.bsky.social' })

    expect(posts).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('ouvre une session puis interroge searchPosts avec le token obtenu', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('createSession')) {
        return Promise.resolve(new Response(JSON.stringify({ accessJwt: 'jwt-de-test' }), { status: 200 }))
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            posts: [{
              uri: 'at://did:plc:xyz/app.bsky.feed.post/rkey1',
              author: { handle: 'dev.bsky.social' },
              record: { text: 'my app got rejected again', createdAt: '2026-08-01T10:00:00Z' },
            }],
          }),
          { status: 200 },
        ),
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const posts = await collecterBluesky({ id: 'moi.bsky.social', appPassword: 'xxxx-xxxx-xxxx-xxxx' })

    expect(posts).toHaveLength(1)
    expect(posts[0]!.auteur).toBe('dev.bsky.social')

    const appelSession = fetchMock.mock.calls.find((c) => String(c[0]).includes('createSession'))!
    expect(appelSession[1]?.method).toBe('POST')
    const corps = JSON.parse(String(appelSession[1]?.body))
    expect(corps).toEqual({ identifier: 'moi.bsky.social', password: 'xxxx-xxxx-xxxx-xxxx' })

    const appelRecherche = fetchMock.mock.calls.find((c) => String(c[0]).includes('searchPosts'))!
    expect((appelRecherche[1]?.headers as Record<string, string>).Authorization).toBe('Bearer jwt-de-test')
  })

  it('renvoie un tableau vide (et journalise) si l authentification echoue', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 401 })))
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const posts = await collecterBluesky({ id: 'moi.bsky.social', appPassword: 'mauvais' })

    expect(posts).toEqual([])
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('authentification'))).toBe(true)
  })

  it('un auteur null ne fait pas perdre les autres posts de la reponse', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('createSession')) {
        return Promise.resolve(new Response(JSON.stringify({ accessJwt: 'jwt' }), { status: 200 }))
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            posts: [
              {
                uri: 'at://did:plc:supprime/app.bsky.feed.post/rkeyA',
                author: null,
                record: { text: 'compte supprime', createdAt: '2026-08-01T10:00:00Z' },
              },
              {
                uri: 'at://did:plc:xyz/app.bsky.feed.post/rkeyB',
                author: { handle: 'dev.bsky.social' },
                record: { text: 'my app got rejected again', createdAt: '2026-08-01T10:00:00Z' },
              },
            ],
          }),
          { status: 200 },
        ),
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const posts = await collecterBluesky({ id: 'moi.bsky.social', appPassword: 'xxxx' })
    expect(posts).toHaveLength(2)
    const sansAuteur = posts.find((p) => p.id === 'bluesky:rkeyA')
    expect(sansAuteur).toBeDefined()
    expect(sansAuteur!.auteur).toBe('inconnu')
    expect(posts.find((p) => p.id === 'bluesky:rkeyB')).toBeDefined()
  })

  it('ignore un post dont l URI ne fournit aucun rkey exploitable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (url.includes('createSession')) {
        return Promise.resolve(new Response(JSON.stringify({ accessJwt: 'jwt' }), { status: 200 }))
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            posts: [{
              uri: '',
              author: { handle: 'dev.bsky.social' },
              record: { text: 'uri malformee', createdAt: '2026-08-01T10:00:00Z' },
            }],
          }),
          { status: 200 },
        ),
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const posts = await collecterBluesky({ id: 'moi.bsky.social', appPassword: 'xxxx' })
    expect(posts).toEqual([])
  })
})

describe('collecterMastodon', () => {
  it('retire les balises HTML du contenu', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{
        id: '77', url: 'https://mastodon.social/@dev/77', account: { acct: 'dev' },
        content: '<p>App <b>rejected</b> again</p>', created_at: '2026-08-01T10:00:00Z',
      }]), { status: 200 }),
    ))
    const posts = await collecterMastodon()
    expect(posts[0]!.contenu).toBe('App rejected again')
  })

  it('renvoie un tableau vide sans lever si la reponse n est pas un tableau de statuts', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'rate limited' }), { status: 200 }),
    ))
    expect(await collecterMastodon()).toEqual([])
  })

  it('remplace un acct absent par "inconnu"', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify([{
        id: '78', url: 'https://mastodon.social/@x/78', account: {},
        content: 'texte', created_at: '2026-08-01T10:00:00Z',
      }]), { status: 200 }),
    ))
    const posts = await collecterMastodon()
    expect(posts[0]!.auteur).toBe('inconnu')
  })
})
