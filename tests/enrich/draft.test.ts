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
})
