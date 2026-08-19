import { describe, it, expect, vi } from 'vitest'
import { executerReddit } from '../../src/jobs/reddit.ts'
import { ouvrirDb } from '../../src/db.ts'
import type { RawPost, ScoredPost, EnrichedPost } from '../../src/types.ts'

function raw(id: string, titre = 'app rejected 4.2.6'): RawPost {
  return {
    id, source: 'reddit', url: `https://reddit.com/${id}`, auteur: 'bob',
    titre, contenu: '', publieLe: new Date(),
  }
}

/**
 * executerReddit delegue integralement a jobs/pipeline.ts (executerPipeline), deja
 * couvert en profondeur par tests/jobs/radar.test.ts (meme fonction partagee, testee
 * via executerRadar). Ces tests-ci ne verifient donc que le CABLAGE specifique a la
 * commande reddit : le collecteur passe est bien invoque, le pipeline aval fonctionne
 * de bout en bout, et le job se comporte comme un job de pipeline normal (dedup,
 * retenue, abandon) sans avoir a reproduire tous les cas deja couverts ailleurs.
 */
describe('executerReddit', () => {
  it('collecte via le collecteur fourni et retient un prospect au-dessus du seuil', async () => {
    const db = ouvrirDb(':memory:')
    const collecter = vi.fn(async (): Promise<RawPost[]> => [raw('reddit:abc')])
    const ecrireSheet = vi.fn(async () => 5)
    const notifier = vi.fn(async () => true)

    const r = await executerReddit({
      db,
      collecter,
      noter: async (p): Promise<ScoredPost | null> => ({ ...p, score: 90, langue: 'en', probleme: 'rejet' }),
      enrichir: async (p): Promise<EnrichedPost | null> => ({ ...p, traductionFr: 'tr', brouillon: 'br' }),
      ecrireSheet,
      notifier,
      notifierTexte: vi.fn(async () => true),
      seuil: 60,
      ageMaxJours: 30,
      retentionJours: 90,
    })

    expect(collecter).toHaveBeenCalledTimes(1)
    expect(r.retenus).toBe(1)
    expect(ecrireSheet).toHaveBeenCalledTimes(1)
    expect(notifier).toHaveBeenCalledTimes(1)
  })

  it('memorise le post pour la deduplication partagee avec radar.ts (meme RadarDb)', async () => {
    const db = ouvrirDb(':memory:')
    await executerReddit({
      db,
      collecter: async () => [raw('reddit:abc')],
      noter: async (p) => ({ ...p, score: 90, langue: 'en' as const, probleme: 'x' }),
      enrichir: async (p) => ({ ...p, traductionFr: 't', brouillon: 'b' }),
      ecrireSheet: async () => 1,
      notifier: async () => true,
      notifierTexte: async () => true,
      seuil: 60,
      ageMaxJours: 30,
      retentionJours: 90,
    })

    // Le meme id ('reddit:abc') est desormais "vu" pour n'importe quel job qui
    // partage cette base - radar.ts ne le recollecterait pas si l'API OAuth Reddit
    // le renvoyait aussi un jour.
    expect(db.dejaVu('reddit:abc')).toBe(true)
  })
})
