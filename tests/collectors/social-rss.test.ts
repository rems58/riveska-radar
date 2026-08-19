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
})
