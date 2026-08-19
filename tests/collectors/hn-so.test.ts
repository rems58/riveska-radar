// tests/collectors/hn-so.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { collecterHackerNews } from '../../src/collectors/hackernews.ts'
import { collecterStackOverflow } from '../../src/collectors/stackoverflow.ts'

afterEach(() => vi.restoreAllMocks())

describe('collecterHackerNews', () => {
  it('convertit une reponse Algolia en RawPost', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        hits: [{
          objectID: '4242', author: 'alice', title: 'App store rejection hell',
          story_text: 'rejected three times', created_at_i: 1_760_000_000,
        }],
      }), { status: 200 }),
    ))
    const posts = await collecterHackerNews()
    const p = posts[0]!
    expect(p.id).toBe('hackernews:4242')
    expect(p.source).toBe('hackernews')
    expect(p.url).toBe('https://news.ycombinator.com/item?id=4242')
    expect(p.auteur).toBe('alice')
  })

  it('renvoie un tableau vide si l API echoue', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })))
    expect(await collecterHackerNews()).toEqual([])
  })

  it('renvoie un tableau vide sans lever si hits n est pas un tableau', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ hits: { pas: 'un tableau' } }), { status: 200 }),
    ))
    expect(await collecterHackerNews()).toEqual([])
  })

  it('ignore un hit dont created_at_i est absent, sans Invalid Date', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        hits: [{ objectID: '9', author: 'alice', title: 't', story_text: 'c' }],
      }), { status: 200 }),
    ))
    const posts = await collecterHackerNews()
    expect(posts).toEqual([])
  })
})

describe('collecterStackOverflow', () => {
  it('convertit une reponse StackExchange en RawPost et decode le HTML', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        items: [{
          question_id: 99, title: 'App rejected &amp; stuck', body_markdown: 'guideline 4.2.6',
          link: 'https://stackoverflow.com/q/99', creation_date: 1_760_000_000,
          owner: { display_name: 'carl' },
        }],
      }), { status: 200 }),
    ))
    const posts = await collecterStackOverflow()
    const p = posts[0]!
    expect(p.id).toBe('stackoverflow:99')
    expect(p.titre).toBe('App rejected & stuck')
    expect(p.auteur).toBe('carl')
  })

  it('renvoie un tableau vide si l API echoue', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('reseau')))
    expect(await collecterStackOverflow()).toEqual([])
  })

  it('renvoie un tableau vide sans lever si items n est pas un tableau', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ items: { pas: 'un tableau' } }), { status: 200 }),
    ))
    expect(await collecterStackOverflow()).toEqual([])
  })

  it('decode un titre double-echappe sans le transformer en balise reelle', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        items: [{
          question_id: 100, title: '&amp;lt;code&amp;gt;', body_markdown: '',
          link: 'https://stackoverflow.com/q/100', creation_date: 1_760_000_000,
          owner: { display_name: 'carl' },
        }],
      }), { status: 200 }),
    ))
    const posts = await collecterStackOverflow()
    expect(posts[0]!.titre).toBe('&lt;code&gt;')
  })
})
