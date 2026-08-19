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

  it('jette un post sous le seuil de score et le marque vu (rejet legitime, non-regression)', async () => {
    const d = deps({ noter: async (p) => ({ ...p, score: 20, langue: 'en' as const, probleme: 'x' }) })
    const r = await executerRadar(d)
    expect(r.retenus).toBe(0)
    expect(d.ecrireSheet).not.toHaveBeenCalled()
    expect(d.db.dejaVu('reddit:a')).toBe(true)
  })

  it('un echec technique du scoring (noter renvoie null) ne condamne pas le post', async () => {
    const d = deps({ noter: async () => null })
    const r = await executerRadar(d)
    expect(r.retenus).toBe(0)
    expect(d.db.dejaVu('reddit:a')).toBe(false)
  })

  it('un echec technique de l enrichissement (enrichir renvoie null) ne condamne pas le post', async () => {
    const d = deps({ enrichir: async () => null })
    const r = await executerRadar(d)
    expect(r.retenus).toBe(0)
    expect(d.db.dejaVu('reddit:a')).toBe(false)
  })

  it('un echec technique d ecriture Sheet (ecrireSheet renvoie null) ne condamne pas le post et ne notifie pas', async () => {
    const ecrireSheet = vi.fn(async () => null)
    const d = deps({ ecrireSheet })
    const r = await executerRadar(d)
    expect(r.retenus).toBe(0)
    expect(d.db.dejaVu('reddit:a')).toBe(false)
    expect(d.notifier).not.toHaveBeenCalled()
  })

  it('abandonne definitivement un post apres 3 echecs techniques consecutifs', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = ouvrirDb(':memory:')
    const noter = vi.fn(async () => null)
    const base = deps({ db, collecter: async () => [raw('reddit:a')], noter })

    await executerRadar(base)
    await executerRadar(base)
    const r3 = await executerRadar(base)
    expect(r3.retenus).toBe(0)
    expect(db.dejaVu('reddit:a')).toBe(true)
    expect(noter).toHaveBeenCalledTimes(3)

    // 4e run : le post est deja "vu" (abandonne), donc filtre avant meme d'atteindre noter.
    const r4 = await executerRadar(base)
    expect(r4.candidats).toBe(0)
    expect(noter).toHaveBeenCalledTimes(3)

    const logAbandon = warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('abandonne'))
    expect(logAbandon).toBeDefined()
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

  it('journalise et compte un echec d envoi Telegram sans condamner le post', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const notifier = vi.fn(async () => false)
    const d = deps({ notifier })
    const r = await executerRadar(d)
    // Le prospect est deja ecrit dans le Sheet : un Telegram rate ne doit pas le perdre.
    expect(r.retenus).toBe(1)
    expect(r.notificationsEchouees).toBe(1)
    expect(d.db.dejaVu('reddit:a')).toBe(true)
    const log = warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.toLowerCase().includes('notification'))
    expect(log).toBeDefined()
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
