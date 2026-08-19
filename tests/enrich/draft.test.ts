import { describe, it, expect, vi, afterEach } from 'vitest'
import { enrichirPost } from '../../src/enrich/draft.ts'
import type { ScoredPost } from '../../src/types.ts'

afterEach(() => vi.restoreAllMocks())

function scored(over: Partial<ScoredPost> = {}): ScoredPost {
  return {
    id: 'reddit:1', source: 'reddit', url: 'https://reddit.com/1', auteur: 'bob',
    titre: 'App rejected', contenu: 'guideline 4.2.6 help', publieLe: new Date(),
    score: 85, langue: 'en', probleme: 'rejet 4.2.6', ...over,
  }
}

function reponse(contenu: object) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(contenu) } }] }),
    { status: 200 },
  )
}

describe('enrichirPost', () => {
  it('produit traduction et brouillon pour un post etranger', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      reponse({ traductionFr: 'App rejetee, aide 4.2.6', brouillon: 'Salut, le 4.2.6 vise...' }),
    ))
    const r = await enrichirPost(scored(), { cle: 'k', modele: 'm' })
    expect(r!.traductionFr).toBe('App rejetee, aide 4.2.6')
    expect(r!.brouillon).toBe('Salut, le 4.2.6 vise...')
  })

  it('laisse la traduction vide pour un post deja en francais', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      reponse({ traductionFr: '', brouillon: 'Bonjour, ...' }),
    ))
    const r = await enrichirPost(scored({ langue: 'fr' }), { cle: 'k', modele: 'm' })
    expect(r!.traductionFr).toBe('')
    expect(r!.brouillon).toBe('Bonjour, ...')
  })

  it('renvoie null si le LLM echoue', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('err', { status: 500 })))
    expect(await enrichirPost(scored(), { cle: 'k', modele: 'm' })).toBeNull()
  })

  it('conserve les champs du ScoredPost', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reponse({ traductionFr: 't', brouillon: 'b' })))
    const r = await enrichirPost(scored({ score: 91 }), { cle: 'k', modele: 'm' })
    expect(r!.score).toBe(91)
    expect(r!.url).toBe('https://reddit.com/1')
  })

  it('rejette un brouillon demesurement long plutot que de polluer le Sheet', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      reponse({ traductionFr: '', brouillon: 'x'.repeat(5000) }),
    ))
    const r = await enrichirPost(scored(), { cle: 'k', modele: 'm' })
    expect(r).toBeNull()
    expect(warnSpy).toHaveBeenCalled()
  })

  it('rejette une traduction demesurement longue', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      reponse({ traductionFr: 'x'.repeat(10_000), brouillon: 'brouillon de longueur normale' }),
    ))
    const r = await enrichirPost(scored(), { cle: 'k', modele: 'm' })
    expect(r).toBeNull()
  })

  it('accepte un brouillon de longueur normale (non-regression)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      reponse({
        traductionFr: 'traduction normale',
        brouillon: 'Un brouillon de longueur tout a fait raisonnable, bien en dessous de la limite.',
      }),
    ))
    const r = await enrichirPost(scored(), { cle: 'k', modele: 'm' })
    expect(r).not.toBeNull()
    expect(r!.brouillon).toContain('raisonnable')
  })

  it('tronque le titre avant de l envoyer au LLM (cout)', async () => {
    const titreLong = 'x'.repeat(5000)
    const fetchMock = vi.fn().mockResolvedValue(reponse({ traductionFr: '', brouillon: 'ok' }))
    vi.stubGlobal('fetch', fetchMock)

    await enrichirPost(scored({ titre: titreLong }), { cle: 'k', modele: 'm' })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const corps = JSON.parse(init.body as string) as { messages: Array<{ content: string }> }
    const messageUtilisateur = corps.messages[1]!.content
    expect(messageUtilisateur).not.toContain(titreLong)
    expect(messageUtilisateur.length).toBeLessThan(2500)
  })
})
