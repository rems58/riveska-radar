import { describe, it, expect } from 'vitest'
import { collecterTout } from '../../src/collectors/index.ts'
import type { RawPost } from '../../src/types.ts'

function faux(id: string): RawPost {
  return {
    id, source: 'reddit', url: `https://x/${id}`, auteur: 'bob',
    titre: 't', contenu: 'c', publieLe: new Date(),
  }
}

describe('collecterTout', () => {
  it('concatene les resultats de toutes les sources', async () => {
    const posts = await collecterTout([async () => [faux('a')], async () => [faux('b')]])
    expect(posts.map((p) => p.id).sort()).toEqual(['a', 'b'])
  })

  it('ignore une source en panne sans perdre les autres', async () => {
    const posts = await collecterTout([
      async () => [faux('a')],
      async () => { throw new Error('source HS') },
      async () => [faux('c')],
    ])
    expect(posts.map((p) => p.id).sort()).toEqual(['a', 'c'])
  })

  it('deduplique les ids identiques entre sources', async () => {
    const posts = await collecterTout([async () => [faux('a')], async () => [faux('a')]])
    expect(posts).toHaveLength(1)
  })
})
