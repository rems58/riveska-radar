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

const CHANNEL_VIDE = '<?xml version="1.0"?><rss><channel></channel></rss>'

/**
 * Un objet Response ne peut etre lu (.text()) qu'une seule fois : le reutiliser tel
 * quel via mockResolvedValue casse tout test qui appelle executerTriggers plusieurs
 * fois. Une Response fraiche est donc fabriquee a chaque appel fetch().
 *
 * De plus, FLUX_PLATEFORMES contient 3 URLs (2 Apple, 1 Google) : renvoyer le meme
 * xml contenant l'item pour les 3 le ferait traiter 3 fois DANS LE MEME RUN (comme
 * 3 flux distincts annoncant la meme chose), faussant les compteurs. On ne sert le
 * xml fourni que sur le flux Android (celui dont l'URL correspond au lien de l'item
 * de test), et un channel vide sur les autres - comme en realite, chaque flux a son
 * propre contenu.
 */
function stubFetchAvec(xml: string) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) =>
      Promise.resolve(new Response(url.includes('android') ? xml : CHANNEL_VIDE, { status: 200 })),
    ),
  )
}

describe('executerTriggers', () => {
  it('surveille au moins un flux Apple et un flux Google', () => {
    expect(FLUX_PLATEFORMES.length).toBeGreaterThanOrEqual(2)
  })

  it('notifie une annonce contenant un mot-cle de rupture', async () => {
    stubFetchAvec(xmlAvecItem)
    const db = ouvrirDb(':memory:')
    const notifier = vi.fn(async (_texte: string) => true)
    const r = await executerTriggers({ db, notifier })
    expect(r.nouvelles).toBeGreaterThan(0)
    expect(notifier).toHaveBeenCalled()
    expect(notifier.mock.calls[0]![0]).toContain('API 35')
  })

  it('ne renotifie pas une annonce deja vue', async () => {
    stubFetchAvec(xmlAvecItem)
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

  it('journalise et compte un echec de notification', async () => {
    stubFetchAvec(xmlAvecItem)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = ouvrirDb(':memory:')
    const notifier = vi.fn(async (_texte: string) => false)
    const r = await executerTriggers({ db, notifier })
    // Notification ratee : l'annonce n'est pas comptee comme delivree.
    expect(r.nouvelles).toBe(0)
    expect(r.notificationsEchouees).toBe(1)
    const log = warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.toLowerCase().includes('notification'))
    expect(log).toBeDefined()
  })

  it('ne marque pas une annonce vue si la notification echoue - renotifiee au run suivant', async () => {
    stubFetchAvec(xmlAvecItem)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = ouvrirDb(':memory:')
    const id = 'trigger:https://developer.android.com/news/1'

    const echoue = vi.fn(async (_texte: string) => false)
    const r1 = await executerTriggers({ db, notifier: echoue })
    expect(r1.nouvelles).toBe(0)
    expect(db.dejaVu(id)).toBe(false)

    // Run suivant : le flux RSS represente encore le meme item (il reste dans le flux
    // plusieurs jours), Telegram fonctionne cette fois -> l'annonce est enfin livree.
    const reussit = vi.fn(async (_texte: string) => true)
    const r2 = await executerTriggers({ db, notifier: reussit })
    expect(r2.nouvelles).toBe(1)
    expect(db.dejaVu(id)).toBe(true)
    expect(reussit).toHaveBeenCalledTimes(1)
  })

  it('marque l annonce vue des que la notification reussit - pas de doublon au run suivant', async () => {
    stubFetchAvec(xmlAvecItem)
    const db = ouvrirDb(':memory:')
    const notifier1 = vi.fn(async (_texte: string) => true)
    const r1 = await executerTriggers({ db, notifier: notifier1 })
    expect(r1.nouvelles).toBe(1)

    const notifier2 = vi.fn(async (_texte: string) => true)
    const r2 = await executerTriggers({ db, notifier: notifier2 })
    expect(r2.nouvelles).toBe(0)
    expect(notifier2).not.toHaveBeenCalled()
  })

  it('abandonne une annonce apres des echecs de notification repetes (plafond coherent avec radar.ts)', async () => {
    stubFetchAvec(xmlAvecItem)
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = ouvrirDb(':memory:')
    const id = 'trigger:https://developer.android.com/news/1'
    const notifier = vi.fn(async (_texte: string) => false)

    await executerTriggers({ db, notifier })
    await executerTriggers({ db, notifier })
    await executerTriggers({ db, notifier })
    expect(db.dejaVu(id)).toBe(true)
    expect(notifier).toHaveBeenCalledTimes(3)

    // 4e run : l'annonce est deja "vue" (abandonnee), plus de nouvelle tentative.
    await executerTriggers({ db, notifier })
    expect(notifier).toHaveBeenCalledTimes(3)
  })

  it('traite un flux Atom (le blog Android Developers, remplacement du flux 404) comme un flux RSS', async () => {
    // Forme reelle d'un flux Blogger/Atom (verifiee en appel reel le 2026-08-19) :
    // <link> est une balise auto-fermante avec href, pas un texte entre <link>...</link>.
    const xmlAtom =
      "<?xml version='1.0'?><feed xmlns='http://www.w3.org/2005/Atom'><entry>" +
      "<title type='text'>Upcoming requirement: apps must target API 35</title>" +
      "<published>2026-08-01T10:00:00.000-07:00</published>" +
      "<link rel='replies' href='https://android-developers.googleblog.com/comments'/>" +
      "<link rel='alternate' type='text/html' href='https://android-developers.googleblog.com/2026/08/api35.html'/>" +
      "</entry></feed>"
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation((url: string) =>
        Promise.resolve(new Response(url.includes('googleblog') ? xmlAtom : CHANNEL_VIDE, { status: 200 })),
      ),
    )
    const db = ouvrirDb(':memory:')
    const notifier = vi.fn(async (_texte: string) => true)
    const r = await executerTriggers({ db, notifier })
    expect(r.nouvelles).toBe(1)
    expect(notifier.mock.calls[0]![0]).toContain('API 35')
    expect(notifier.mock.calls[0]![0]).toContain('api35.html')
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
