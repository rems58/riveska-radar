// tests/collectors/reddit-rss.test.ts
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import {
  collecterRedditRss,
  REQUETES,
  DELAI_ENTRE_REQUETES_MS,
  DELAI_RETRY_APRES_429_MS,
  USER_AGENT,
} from '../../src/collectors/reddit-rss.ts'

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function entreePost(
  id: string,
  titre: string,
  opts: Partial<{ auteur: string; lien: string; date: string; contenu: string }> = {},
): string {
  return (
    `<entry><author><name>/u/${opts.auteur ?? 'quelquun'}</name></author>` +
    `<content type='html'>${opts.contenu ?? 'contenu du post'}</content>` +
    `<id>t3_${id}</id><link href='${opts.lien ?? `https://www.reddit.com/r/test/comments/${id}/x/`}' />` +
    `<updated>${opts.date ?? '2026-08-01T10:00:00+00:00'}</updated>` +
    `<published>${opts.date ?? '2026-08-01T10:00:00+00:00'}</published>` +
    `<title>${titre}</title></entry>`
  )
}

/** search.rss renvoie aussi des entrees "subreddit" (id t5_...) melangees aux posts. */
function entreeSubreddit(id: string): string {
  return (
    `<entry><content type='html'>description du sub</content><id>t5_${id}</id>` +
    `<link href='https://www.reddit.com/r/${id}/' /><updated>2020-01-01T00:00:00+00:00</updated>` +
    `<title>r/${id}</title></entry>`
  )
}

function feed(entries: string[]): string {
  return `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom">${entries.join('')}</feed>`
}

describe('collecterRedditRss - parsing', () => {
  it('convertit une entree post en RawPost, id prefixe reddit: SANS le prefixe t3_', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(feed([entreePost('abc123', 'App rejected help')]), { status: 200 })),
    )
    const posts = await collecterRedditRss(['app rejected'])
    expect(posts).toHaveLength(1)
    // Meme forme d id que collecterReddit (OAuth, src/collectors/reddit.ts) : la
    // deduplication partagee (RadarDb.dejaVu) doit traiter le meme post identiquement
    // quelle que soit la source qui l a collecte.
    expect(posts[0]!.id).toBe('reddit:abc123')
    expect(posts[0]!.source).toBe('reddit')
    expect(posts[0]!.titre).toBe('App rejected help')
  })

  it('ignore les entrees "subreddit" (id t5_) melangees par search.rss aux vrais posts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(feed([entreeSubreddit('expo'), entreePost('abc', 'App rejected')]), { status: 200 }),
      ),
    )
    const posts = await collecterRedditRss(['app rejected'])
    expect(posts).toHaveLength(1)
    expect(posts[0]!.id).toBe('reddit:abc')
  })

  it('extrait le pseudo depuis <author><name> sans le prefixe /u/', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(feed([entreePost('abc', 't', { auteur: 'bob' })]), { status: 200 })),
    )
    const posts = await collecterRedditRss(['q'])
    expect(posts[0]!.auteur).toBe('bob')
  })

  it('nettoie le HTML du contenu (balises retirees, entites decodees)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(feed([entreePost('abc', 't', { contenu: '&lt;p&gt;bonjour&lt;/p&gt;' })]), { status: 200 }),
      ),
    )
    const posts = await collecterRedditRss(['q'])
    expect(posts[0]!.contenu).toBe('bonjour')
  })

  it('deduplique au sein d une meme reponse', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(feed([entreePost('abc', 't1'), entreePost('abc', 't2')]), { status: 200 }),
      ),
    )
    const posts = await collecterRedditRss(['q'])
    expect(posts).toHaveLength(1)
  })

  it('ignore une entree sans lien exploitable', async () => {
    const sansLien = entreePost('abc', 't').replace(/<link[^>]*\/>/, '')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(feed([sansLien]), { status: 200 })))
    const posts = await collecterRedditRss(['q'])
    expect(posts).toEqual([])
  })

  it('ignore une entree sans date exploitable', async () => {
    const sansDate = entreePost('abc', 't').replace(/<updated>.*?<\/updated>/, '').replace(/<published>.*?<\/published>/, '')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(feed([sansDate]), { status: 200 })))
    const posts = await collecterRedditRss(['q'])
    expect(posts).toEqual([])
  })

  it('utilise un user-agent honnete qui identifie riveska-radar, jamais un navigateur', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(feed([]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    await collecterRedditRss(['q'])
    const init = fetchMock.mock.calls[0]![1] as RequestInit
    expect((init.headers as Record<string, string>)['User-Agent']).toBe(USER_AGENT)
    expect(USER_AGENT).not.toMatch(/mozilla|chrome|safari|webkit/i)
    expect(USER_AGENT).toContain('riveska-radar')
  })

  it('ne leve jamais si le flux est injoignable (panne reseau)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('reseau indisponible')))
    await expect(collecterRedditRss(['q'])).resolves.toEqual([])
  })
})

describe('collecterRedditRss - sequentiel strict et debit (contrainte Reddit mesuree)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it('espace chaque requete d au moins DELAI_ENTRE_REQUETES_MS, jamais en parallele', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(feed([]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const promesse = collecterRedditRss(['q1', 'q2', 'q3'])

    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1) // premiere requete immediate, pas d attente avant elle

    await vi.advanceTimersByTimeAsync(DELAI_ENTRE_REQUETES_MS - 1)
    expect(fetchMock).toHaveBeenCalledTimes(1) // pas encore la deuxieme : l attente n est pas ecoulee

    await vi.advanceTimersByTimeAsync(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    await vi.advanceTimersByTimeAsync(DELAI_ENTRE_REQUETES_MS)
    expect(fetchMock).toHaveBeenCalledTimes(3)

    await promesse
  })

  it('retente une fois apres un 429, avec un delai plus long ; succes au retry -> pas d arret', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response(feed([entreePost('abc', 'App rejected')]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const promesse = collecterRedditRss(['q1'])
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // Le retry attend un delai PLUS LONG que l espacement normal entre requetes.
    await vi.advanceTimersByTimeAsync(DELAI_RETRY_APRES_429_MS)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const posts = await promesse
    expect(posts).toHaveLength(1) // le retry a reussi : une limitation isolee ne bloque pas la collecte
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('429'))).toBe(true)
  })

  it('une requete dont le retry echoue AUSSI (2 reponses limitees consecutives) arrete tout le run', async () => {
    // Deux 429 consecutifs (tentative initiale + retry) sur LA MEME requete signalent
    // une IP en penalite, pas un incident isole : enchainer les requetes restantes
    // prolongerait la penalite au lieu de la laisser retomber (mesure reelle : la
    // meme URL a echoue en 429 en curl ET en fetch Node, une heure apres un succes).
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 })) // q1, 1ere tentative
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 })) // q1, retry -> toujours limite
      .mockResolvedValue(new Response(feed([entreePost('xyz', 'q2 post')]), { status: 200 })) // q2 : jamais tentee
    vi.stubGlobal('fetch', fetchMock)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const promesse = collecterRedditRss(['q1', 'q2', 'q3'])
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(DELAI_RETRY_APRES_429_MS)

    const posts = await promesse
    expect(posts).toEqual([]) // arret avant meme d avoir pu recolter quoi que ce soit
    expect(fetchMock).toHaveBeenCalledTimes(2) // q2 et q3 jamais tentees : pas de 3e/4e appel

    const log = warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('limitation'))
    expect(log).toBeDefined()
    expect(log).toContain('2 requete(s) restante(s)')
  })

  it('un 403 (blocage escalade) declenche EXACTEMENT le meme comportement qu un 429', async () => {
    // Mesure reelle : le 403 est la forme escaladee de la meme limite Reddit, pas
    // une erreur distincte - meme retry, meme arret anticipe si il persiste.
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('forbidden', { status: 403 }))
      .mockResolvedValueOnce(new Response('forbidden', { status: 403 }))
      .mockResolvedValue(new Response(feed([entreePost('xyz', 'q2')]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const promesse = collecterRedditRss(['q1', 'q2'])
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(DELAI_RETRY_APRES_429_MS)

    const posts = await promesse
    expect(posts).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(2) // q2 jamais tentee, meme raisonnement que pour 429
  })

  it('un 403 isole (retry reussi) ne declenche pas d arret', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('forbidden', { status: 403 }))
      .mockResolvedValueOnce(new Response(feed([entreePost('abc', 'App rejected')]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const promesse = collecterRedditRss(['q1'])
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(DELAI_RETRY_APRES_429_MS)
    const posts = await promesse
    expect(posts).toHaveLength(1)
  })

  it('une panne reseau (pas un 429/403) n est jamais retentee immediatement', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('DNS injoignable'))
      .mockResolvedValueOnce(new Response(feed([entreePost('xyz', 'q2')]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.spyOn(console, 'warn').mockImplementation(() => {})

    const promesse = collecterRedditRss(['q1', 'q2'])
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Pas de retry sur une panne reseau (contrairement au 429) : la requete suivante
    // attend seulement l espacement normal, jamais DELAI_RETRY_APRES_429_MS.
    await vi.advanceTimersByTimeAsync(DELAI_ENTRE_REQUETES_MS)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    const posts = await promesse
    expect(posts).toHaveLength(1)
  })
})

describe('REQUETES', () => {
  it('contient au plus une douzaine de requetes (contrainte de debit : 1/minute)', () => {
    expect(REQUETES.length).toBeLessThanOrEqual(12)
    expect(REQUETES.length).toBeGreaterThan(0)
  })

  it('couvre plusieurs langues (au moins l anglais et le francais)', () => {
    expect(REQUETES).toContain('app rejected')
    expect(REQUETES).toContain('app rejetee')
  })
})
