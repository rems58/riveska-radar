import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  recupererTexte,
  recupererTexteAvecStatut,
  recupererJson,
  decoderEntitesHtml,
  versAuteur,
  dateValideOuNull,
} from '../../src/collectors/http.ts'

afterEach(() => vi.restoreAllMocks())

describe('recupererTexte / recupererJson (couche http commune)', () => {
  it('rend la main via le timeout quand fetch ne repond jamais', async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'))
          })
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const debut = Date.now()
    const resultat = await recupererTexte({ source: 'test', url: 'https://x/lent', timeoutMs: 30 })
    const duree = Date.now() - debut

    expect(resultat).toBeNull()
    expect(duree).toBeLessThan(2000)
  })

  it('journalise la source, l URL et la raison en cas d echec HTTP', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 503 })))

    const resultat = await recupererTexte({ source: 'ma-source', url: 'https://x/y', timeoutMs: 100 })

    expect(resultat).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const [message] = warnSpy.mock.calls[0]!
    expect(String(message)).toContain('ma-source')
    expect(String(message)).toContain('https://x/y')
  })

  it('journalise la source, l URL et la raison en cas de rejet reseau', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('DNS injoignable')))

    const resultat = await recupererTexte({ source: 'ma-source', url: 'https://x/y', timeoutMs: 100 })

    expect(resultat).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const [message] = warnSpy.mock.calls[0]!
    expect(String(message)).toContain('ma-source')
    expect(String(message)).toContain('https://x/y')
    expect(String(message)).toContain('DNS injoignable')
  })

  it('refuse une reponse trop volumineuse sans la propager', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const enorme = 'x'.repeat(6_000_000)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(enorme, { status: 200 })))

    const resultat = await recupererTexte({ source: 'gros-flux', url: 'https://x/rss', timeoutMs: 100 })

    expect(resultat).toBeNull()
    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('renvoie null (pas une exception) si le JSON est invalide', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('{not json', { status: 200 })))

    const resultat = await recupererJson({ source: 'test', url: 'https://x/y', timeoutMs: 100 })
    expect(resultat).toBeNull()
  })

  it('renvoie le JSON parse en cas de succes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ a: 1 }), { status: 200 })))
    const resultat = await recupererJson<{ a: number }>({ source: 'test', url: 'https://x/y' })
    expect(resultat).toEqual({ a: 1 })
  })
})

describe('recupererTexteAvecStatut', () => {
  it('renvoie le texte et le statut en cas de succes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('contenu', { status: 200 })))
    const r = await recupererTexteAvecStatut({ source: 'test', url: 'https://x/y' })
    expect(r).toEqual({ texte: 'contenu', statut: 200 })
  })

  it('renvoie le statut (ex: 429) meme en cas d echec HTTP, texte null', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('too many requests', { status: 429 })))
    const r = await recupererTexteAvecStatut({ source: 'test', url: 'https://x/y' })
    expect(r).toEqual({ texte: null, statut: 429 })
  })

  it('renvoie un statut null si la requete n a jamais abouti (panne reseau)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('DNS injoignable')))
    const r = await recupererTexteAvecStatut({ source: 'test', url: 'https://x/y' })
    expect(r).toEqual({ texte: null, statut: null })
  })
})

describe('decoderEntitesHtml', () => {
  it('decode amp en dernier pour ne pas re-interpreter un texte double-echappe', () => {
    expect(decoderEntitesHtml('&amp;lt;code&amp;gt;')).toBe('&lt;code&gt;')
  })

  it('decode les entites simples', () => {
    expect(decoderEntitesHtml('App rejected &amp; stuck')).toBe('App rejected & stuck')
  })
})

describe('versAuteur', () => {
  it('renvoie inconnu si la valeur est null, absente ou non-string', () => {
    expect(versAuteur(null)).toBe('inconnu')
    expect(versAuteur(undefined)).toBe('inconnu')
    expect(versAuteur(42)).toBe('inconnu')
    expect(versAuteur('')).toBe('inconnu')
  })

  it('renvoie la chaine telle quelle si valide', () => {
    expect(versAuteur('bob')).toBe('bob')
  })
})

describe('dateValideOuNull', () => {
  it('renvoie null pour une date invalide', () => {
    expect(dateValideOuNull(new Date(Number('pas-un-nombre')))).toBeNull()
    expect(dateValideOuNull(new Date(NaN))).toBeNull()
  })

  it('renvoie la date si elle est valide', () => {
    const d = new Date('2026-08-01T10:00:00Z')
    expect(dateValideOuNull(d)).toBe(d)
  })
})
