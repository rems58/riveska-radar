import { describe, it, expect, vi, afterEach } from 'vitest'
import { collecterTout } from '../../src/collectors/index.ts'
import type { RawPost } from '../../src/types.ts'

afterEach(() => vi.restoreAllMocks())

function faux(id: string): RawPost {
  return {
    id, source: 'reddit', url: `https://x/${id}`, auteur: 'bob',
    titre: 't', contenu: 'c', publieLe: new Date(),
  }
}

describe('collecterTout', () => {
  it('concatene les resultats de toutes les sources', async () => {
    const posts = await collecterTout([
      { nom: 'a', collecter: async () => [faux('a')] },
      { nom: 'b', collecter: async () => [faux('b')] },
    ])
    expect(posts.map((p) => p.id).sort()).toEqual(['a', 'b'])
  })

  it('ignore une source en panne sans perdre les autres', async () => {
    const posts = await collecterTout([
      { nom: 'a', collecter: async () => [faux('a')] },
      { nom: 'source-hs', collecter: async () => { throw new Error('source HS') } },
      { nom: 'c', collecter: async () => [faux('c')] },
    ])
    expect(posts.map((p) => p.id).sort()).toEqual(['a', 'c'])
  })

  it('deduplique les ids identiques entre sources', async () => {
    const posts = await collecterTout([
      { nom: 'a', collecter: async () => [faux('a')] },
      { nom: 'b', collecter: async () => [faux('a')] },
    ])
    expect(posts).toHaveLength(1)
  })

  it('journalise le nom de la source en echec', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await collecterTout([
      { nom: 'reddit', collecter: async () => { throw new Error('token refuse') } },
    ])
    expect(warnSpy).toHaveBeenCalledTimes(1)
    const [message] = warnSpy.mock.calls[0]!
    expect(String(message)).toContain('reddit')
  })

  it('signale une source qui renvoie 0 post alors que d autres en renvoient (flux probablement casse)', async () => {
    const onSourceVide = vi.fn()
    await collecterTout(
      [
        { nom: 'a', collecter: async () => [faux('a')] },
        { nom: 'source-muette', collecter: async () => [] },
      ],
      onSourceVide,
    )
    expect(onSourceVide).toHaveBeenCalledTimes(1)
    expect(onSourceVide).toHaveBeenCalledWith('source-muette')
  })

  it('ne signale rien si toutes les sources renvoient 0 (pas d anomalie relative)', async () => {
    const onSourceVide = vi.fn()
    await collecterTout(
      [
        { nom: 'a', collecter: async () => [] },
        { nom: 'b', collecter: async () => [] },
      ],
      onSourceVide,
    )
    expect(onSourceVide).not.toHaveBeenCalled()
  })

  it('ne signale rien pour une source en echec (deja couverte par le warn d echec, pas un double signal)', async () => {
    const onSourceVide = vi.fn()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await collecterTout(
      [
        { nom: 'a', collecter: async () => [faux('a')] },
        { nom: 'source-hs', collecter: async () => { throw new Error('HS') } },
      ],
      onSourceVide,
    )
    expect(onSourceVide).not.toHaveBeenCalled()
  })

  it('sans callback fourni, journalise par defaut un avertissement explicite', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await collecterTout([
      { nom: 'a', collecter: async () => [faux('a')] },
      { nom: 'source-muette', collecter: async () => [] },
    ])
    const messages = warnSpy.mock.calls.map((c) => String(c[0]))
    expect(messages.some((m) => m.includes('source-muette'))).toBe(true)
  })
})
