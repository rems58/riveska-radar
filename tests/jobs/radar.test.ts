import { describe, it, expect, vi } from 'vitest'
import { executerRadar } from '../../src/jobs/radar.ts'
import { ouvrirDb } from '../../src/db.ts'
import type { RawPost, ScoredPost, EnrichedPost } from '../../src/types.ts'

function raw(id: string, titre = 'app rejected 4.2.6'): RawPost {
  return {
    id, source: 'reddit', url: `https://reddit.com/${id}`, auteur: 'bob',
    titre, contenu: '', publieLe: new Date(),
  }
}

function deps(over: Partial<Parameters<typeof executerRadar>[0]> = {}) {
  const db = ouvrirDb(':memory:')
  return {
    db,
    collecter: async (): Promise<RawPost[]> => [raw('reddit:a')],
    noter: async (p: RawPost): Promise<ScoredPost | null> => ({
      ...p, score: 90, langue: 'en' as const, probleme: 'rejet',
    }),
    enrichir: async (p: ScoredPost): Promise<EnrichedPost | null> => ({
      ...p, traductionFr: 'tr', brouillon: 'br',
    }),
    ecrireSheet: vi.fn(async () => 10),
    notifier: vi.fn(async () => true),
    seuil: 60,
    ageMaxJours: 30,
    retentionJours: 90,
    ...over,
  }
}

describe('executerRadar', () => {
  it('ecrit et notifie un prospect au-dessus du seuil', async () => {
    const d = deps()
    const r = await executerRadar(d)
    expect(r.retenus).toBe(1)
    expect(d.ecrireSheet).toHaveBeenCalledTimes(1)
    expect(d.notifier).toHaveBeenCalledTimes(1)
  })

  it('ignore un post deja vu', async () => {
    const d = deps()
    d.db.marquerVu({ id: 'reddit:a', auteur: 'bob', url: 'u', score: 90 })
    const r = await executerRadar(d)
    expect(r.retenus).toBe(0)
    expect(d.ecrireSheet).not.toHaveBeenCalled()
  })

  it('jette un post sans signal mots-cles sans appeler le LLM', async () => {
    const noter = vi.fn()
    const d = deps({ collecter: async () => [raw('reddit:b', 'best state library 2026')], noter })
    const r = await executerRadar(d)
    expect(r.retenus).toBe(0)
    expect(noter).not.toHaveBeenCalled()
  })

  it('jette un post sous le seuil de score', async () => {
    const d = deps({ noter: async (p) => ({ ...p, score: 20, langue: 'en' as const, probleme: 'x' }) })
    const r = await executerRadar(d)
    expect(r.retenus).toBe(0)
    expect(d.ecrireSheet).not.toHaveBeenCalled()
  })

  it('memorise le post retenu pour ne pas le retraiter', async () => {
    const d = deps()
    await executerRadar(d)
    expect(d.db.dejaVu('reddit:a')).toBe(true)
  })

  it('programme un re-check 48h plus tard', async () => {
    const d = deps()
    await executerRadar(d)
    expect(d.db.aRecheck()).toHaveLength(0)
  })

  it('purge les vieilles lignes a chaque passage', async () => {
    const d = deps()
    const vieux = new Date(Date.now() - 200 * 24 * 3600 * 1000)
    d.db.marquerVu({ id: 'reddit:vieux', auteur: 'x', url: 'u', score: 10, vuLe: vieux })
    const r = await executerRadar(d)
    expect(r.purges).toBe(1)
  })

  it('continue le traitement des autres posts si noter leve sur un post', async () => {
    const noter = vi
      .fn()
      .mockRejectedValueOnce(new Error('llm indisponible'))
      .mockResolvedValueOnce({ ...raw('reddit:b'), score: 90, langue: 'en' as const, probleme: 'rejet' })
    const d = deps({
      collecter: async () => [raw('reddit:a'), raw('reddit:b')],
      noter,
    })
    const r = await executerRadar(d)
    expect(r.retenus).toBe(1)
    expect(d.ecrireSheet).toHaveBeenCalledTimes(1)
    expect(d.notifier).toHaveBeenCalledTimes(1)
  })

  it('se termine proprement si ecrireSheet leve', async () => {
    const ecrireSheet = vi.fn(async () => {
      throw new Error('sheets indisponible')
    })
    const d = deps({ ecrireSheet })
    await expect(executerRadar(d)).resolves.toMatchObject({ retenus: 0 })
    expect(d.notifier).not.toHaveBeenCalled()
  })
})
