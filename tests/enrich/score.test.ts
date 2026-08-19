import { describe, it, expect, vi, afterEach } from 'vitest'
import { noterPost } from '../../src/enrich/score.ts'
import type { RawPost } from '../../src/types.ts'

afterEach(() => vi.restoreAllMocks())

const post: RawPost = {
  id: 'reddit:1', source: 'reddit', url: 'https://reddit.com/1', auteur: 'bob',
  titre: 'App rejected 4.2.6', contenu: 'I built it with bolt and cannot publish',
  publieLe: new Date(),
}

function reponse(contenu: object) {
  return new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(contenu) } }] }),
    { status: 200 },
  )
}

describe('noterPost', () => {
  it('renvoie un ScoredPost quand le LLM repond correctement', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      reponse({ score: 88, langue: 'en', probleme: 'rejet 4.2.6 sur app vibe-codee' }),
    ))
    const r = await noterPost(post, { cle: 'k', modele: 'm' })
    expect(r).not.toBeNull()
    expect(r!.score).toBe(88)
    expect(r!.langue).toBe('en')
    expect(r!.probleme).toBe('rejet 4.2.6 sur app vibe-codee')
    expect(r!.id).toBe('reddit:1')
  })

  it('renvoie null si le LLM echoue', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('err', { status: 500 })))
    expect(await noterPost(post, { cle: 'k', modele: 'm' })).toBeNull()
  })

  it('renvoie null si la langue est hors des cinq supportees', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reponse({ score: 90, langue: 'ru', probleme: 'x' })))
    expect(await noterPost(post, { cle: 'k', modele: 'm' })).toBeNull()
  })

  it('applique un bonus de recidive', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reponse({ score: 50, langue: 'en', probleme: 'x' })))
    const r = await noterPost(post, { cle: 'k', modele: 'm', apparitionsPrecedentes: 2 })
    expect(r!.score).toBe(100)
  })

  it('ne double pas le score a la premiere apparition', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reponse({ score: 40, langue: 'en', probleme: 'x' })))
    const r = await noterPost(post, { cle: 'k', modele: 'm', apparitionsPrecedentes: 0 })
    expect(r!.score).toBe(40)
  })

  it('tronque le titre avant de l envoyer au LLM (cout)', async () => {
    const titreLong = 'x'.repeat(5000)
    const postTitreLong: RawPost = { ...post, titre: titreLong }
    const fetchMock = vi.fn().mockResolvedValue(reponse({ score: 50, langue: 'en', probleme: 'x' }))
    vi.stubGlobal('fetch', fetchMock)

    await noterPost(postTitreLong, { cle: 'k', modele: 'm' })

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    const corps = JSON.parse(init.body as string) as { messages: Array<{ content: string }> }
    const messageUtilisateur = corps.messages[1]!.content
    expect(messageUtilisateur).not.toContain(titreLong)
    expect(messageUtilisateur.length).toBeLessThan(2500)
  })
})
