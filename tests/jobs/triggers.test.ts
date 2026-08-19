import { describe, it, expect, vi, afterEach } from 'vitest'
import { executerTriggers, FLUX_PLATEFORMES } from '../../src/jobs/triggers.ts'
import { ouvrirDb } from '../../src/db.ts'

afterEach(() => vi.restoreAllMocks())

const xmlAvecItem = `<?xml version="1.0"?><rss><channel>
  <item>
    <title>Upcoming requirement: apps must target API 35</title>
    <link>https://developer.android.com/news/1</link>
    <pubDate>Fri, 01 Aug 2026 10:00:00 GMT</pubDate>
  </item>
</channel></rss>`

describe('executerTriggers', () => {
  it('surveille au moins un flux Apple et un flux Google', () => {
    expect(FLUX_PLATEFORMES.length).toBeGreaterThanOrEqual(2)
  })

  it('notifie une annonce contenant un mot-cle de rupture', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(xmlAvecItem, { status: 200 })))
    const db = ouvrirDb(':memory:')
    const notifier = vi.fn(async (_texte: string) => true)
    const r = await executerTriggers({ db, notifier })
    expect(r.nouvelles).toBeGreaterThan(0)
    expect(notifier).toHaveBeenCalled()
    expect(notifier.mock.calls[0]![0]).toContain('API 35')
  })

  it('ne renotifie pas une annonce deja vue', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(xmlAvecItem, { status: 200 })))
    const db = ouvrirDb(':memory:')
    await executerTriggers({ db, notifier: async () => true })
    const notifier = vi.fn(async () => true)
    const r = await executerTriggers({ db, notifier })
    expect(r.nouvelles).toBe(0)
    expect(notifier).not.toHaveBeenCalled()
  })

  it('ignore une annonce sans mot-cle de rupture', async () => {
    const xml = `<?xml version="1.0"?><rss><channel><item>
      <title>Meet the design awards winners</title>
      <link>https://developer.apple.com/news/2</link>
      <pubDate>Fri, 01 Aug 2026 10:00:00 GMT</pubDate>
    </item></channel></rss>`
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(xml, { status: 200 })))
    const db = ouvrirDb(':memory:')
    const notifier = vi.fn(async () => true)
    const r = await executerTriggers({ db, notifier })
    expect(r.nouvelles).toBe(0)
    expect(notifier).not.toHaveBeenCalled()
  })

  it('ignore un item sans lien exploitable', async () => {
    const xml = `<?xml version="1.0"?><rss><channel><item>
      <title>New requirement for all apps</title>
    </item></channel></rss>`
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(xml, { status: 200 })))
    const db = ouvrirDb(':memory:')
    const notifier = vi.fn(async () => true)
    const r = await executerTriggers({ db, notifier })
    expect(r.nouvelles).toBe(0)
    expect(notifier).not.toHaveBeenCalled()
  })
})
