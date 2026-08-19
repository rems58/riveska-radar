// tests/collectors/social-rss.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { collecterBluesky } from '../../src/collectors/bluesky.ts'
import { collecterMastodon } from '../../src/collectors/mastodon.ts'
import { collecterRss, FLUX_FORUMS } from '../../src/collectors/rss.ts'

afterEach(() => vi.restoreAllMocks())

describe('collecterBluesky', () => {
  it('convertit une reponse searchPosts en RawPost', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        posts: [{
          uri: 'at://did:plc:xyz/app.bsky.feed.post/rkey1',
          author: { handle: 'dev.bsky.social' },
          record: { text: 'my app got rejected again', createdAt: '2026-08-01T10:00:00Z' },
        }],
      }), { status: 200 }),
    ))
    const posts = await collecterBluesky()
    const p = posts[0]!
    expect(p.source).toBe('bluesky')
    expect(p.auteur).toBe('dev.bsky.social')
    expect(p.url).toBe('https://bsky.app/profile/dev.bsky.social/post/rkey1')
  })

  it('un auteur null ne fait pas perdre les autres posts de la reponse', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
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
      }), { status: 200 }),
    ))
    const posts = await collecterBluesky()
    expect(posts).toHaveLength(2)
    const sansAuteur = posts.find((p) => p.id === 'bluesky:rkeyA')
    expect(sansAuteur).toBeDefined()
    expect(sansAuteur!.auteur).toBe('inconnu')
    expect(sansAuteur!.auteur).not.toBeNull()
    expect(posts.find((p) => p.id === 'bluesky:rkeyB')).toBeDefined()
  })

  it('ignore un post dont l URI ne fournit aucun rkey exploitable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        posts: [{
          uri: '',
          author: { handle: 'dev.bsky.social' },
          record: { text: 'uri malformee', createdAt: '2026-08-01T10:00:00Z' },
        }],
      }), { status: 200 }),
    ))
    const posts = await collecterBluesky()
    expect(posts.some((p) => p.id === 'bluesky:')).toBe(false)
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

describe('collecterRss', () => {
  it('surveille au moins un forum', () => {
    expect(FLUX_FORUMS.length).toBeGreaterThan(0)
  })

  it('parse un flux RSS minimal', async () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <item>
        <title>App rejected 4.2.6</title>
        <link>https://forum.example/t/1</link>
        <description>Need help publishing</description>
        <pubDate>Fri, 01 Aug 2026 10:00:00 GMT</pubDate>
      </item>
    </channel></rss>`
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(xml, { status: 200 })))
    const posts = await collecterRss()
    expect(posts.length).toBeGreaterThan(0)
    expect(posts[0]!.titre).toBe('App rejected 4.2.6')
    expect(posts[0]!.url).toBe('https://forum.example/t/1')
    expect(posts[0]!.source).toBe('forum')
  })

  it('renvoie un tableau vide sans tout charger si le flux depasse la limite de taille', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const xmlEnorme =
      `<?xml version="1.0"?><rss><channel><item><title>t</title>` +
      `<link>https://forum.example/t/1</link><description>${'x'.repeat(6_000_000)}</description>` +
      `</item></channel></rss>`
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(xmlEnorme, { status: 200 })))
    const posts = await collecterRss()
    expect(posts).toEqual([])
  })

  it('decode un titre double-echappe sans le transformer en balise reelle', async () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <item>
        <title>&amp;lt;code&amp;gt;</title>
        <link>https://forum.example/t/2</link>
      </item>
    </channel></rss>`
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(xml, { status: 200 })))
    const posts = await collecterRss()
    expect(posts[0]!.titre).toBe('&lt;code&gt;')
  })
})
