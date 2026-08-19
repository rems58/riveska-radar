import { describe, it, expect, vi } from 'vitest'
import { executerRecheck } from '../../src/jobs/recheck.ts'
import { ouvrirDb } from '../../src/db.ts'

describe('executerRecheck', () => {
  it('ne fait rien si aucune echeance n est atteinte', async () => {
    const db = ouvrirDb(':memory:')
    db.marquerVu({ id: 'reddit:a', auteur: 'bob', url: 'u', score: 80, recheckLe: new Date(Date.now() + 60_000) })
    const notifier = vi.fn(async () => true)
    const r = await executerRecheck({ db, compterReponses: async () => 3, notifier })
    expect(r.verifies).toBe(0)
    expect(notifier).not.toHaveBeenCalled()
  })

  it('notifie quand un post reste sans reponse', async () => {
    const db = ouvrirDb(':memory:')
    db.marquerVu({ id: 'reddit:a', auteur: 'bob', url: 'https://reddit.com/a', score: 80, recheckLe: new Date(Date.now() - 1000) })
    const notifier = vi.fn(async (_texte: string) => true)
    const r = await executerRecheck({ db, compterReponses: async () => 0, notifier })
    expect(r.verifies).toBe(1)
    expect(r.sansReponse).toBe(1)
    expect(notifier).toHaveBeenCalledTimes(1)
    expect(notifier.mock.calls[0]![0]).toContain('https://reddit.com/a')
  })

  it('ne notifie pas un post qui a recu des reponses', async () => {
    const db = ouvrirDb(':memory:')
    db.marquerVu({ id: 'reddit:a', auteur: 'bob', url: 'u', score: 80, recheckLe: new Date(Date.now() - 1000) })
    const notifier = vi.fn(async () => true)
    const r = await executerRecheck({ db, compterReponses: async () => 5, notifier })
    expect(r.sansReponse).toBe(0)
    expect(notifier).not.toHaveBeenCalled()
  })

  it('marque le re-check comme fait pour ne pas boucler', async () => {
    const db = ouvrirDb(':memory:')
    db.marquerVu({ id: 'reddit:a', auteur: 'bob', url: 'u', score: 80, recheckLe: new Date(Date.now() - 1000) })
    await executerRecheck({ db, compterReponses: async () => 0, notifier: async () => true })
    expect(db.aRecheck()).toHaveLength(0)
  })

  it('traite un post inaccessible (compterReponses leve) sans le renotifier ni le rebloquer', async () => {
    const db = ouvrirDb(':memory:')
    db.marquerVu({ id: 'reddit:a', auteur: 'bob', url: 'u', score: 80, recheckLe: new Date(Date.now() - 1000) })
    const notifier = vi.fn(async () => true)
    const compterReponses = vi.fn(async () => {
      throw new Error('404')
    })
    const r = await executerRecheck({ db, compterReponses, notifier })
    expect(r.verifies).toBe(1)
    expect(r.sansReponse).toBe(0)
    expect(notifier).not.toHaveBeenCalled()
    expect(db.aRecheck()).toHaveLength(0)
  })
})
