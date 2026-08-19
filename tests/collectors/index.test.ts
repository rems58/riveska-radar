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
})
