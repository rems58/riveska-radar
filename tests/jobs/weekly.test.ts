import { describe, it, expect, vi } from 'vitest'
import { executerWeekly, formaterStats } from '../../src/jobs/weekly.ts'
import { ouvrirDb } from '../../src/db.ts'

describe('formaterStats', () => {
  it('affiche les compteurs et le taux de reponse', () => {
    const t = formaterStats({ detectes: 20, repondus: 5, ignores: 3, nouveaux: 12 })
    expect(t).toContain('20')
    expect(t).toContain('5')
    expect(t).toContain('25%')
  })

  it('gere zero detection sans division par zero', () => {
    const t = formaterStats({ detectes: 0, repondus: 0, ignores: 0, nouveaux: 0 })
    expect(t).toContain('0%')
  })
})

describe('executerWeekly', () => {
  it('agrege les statuts du Sheet et notifie', async () => {
    const db = ouvrirDb(':memory:')
    db.marquerVu({ id: 'a', auteur: 'x', url: 'u', score: 80 })
    const notifier = vi.fn(async () => true)
    const r = await executerWeekly({
      db,
      lireStatuts: async () => ['repondu', 'repondu', 'nouveau', 'ignore'],
      notifier,
    })
    expect(r.repondus).toBe(2)
    expect(r.nouveaux).toBe(1)
    expect(r.ignores).toBe(1)
    expect(notifier).toHaveBeenCalledTimes(1)
  })

  it('notifie meme une semaine vide', async () => {
    const db = ouvrirDb(':memory:')
    const notifier = vi.fn(async () => true)
    await executerWeekly({ db, lireStatuts: async () => [], notifier })
    expect(notifier).toHaveBeenCalledTimes(1)
  })

  it('compte les statuts sans tenir compte de la casse ni des espaces', async () => {
    const db = ouvrirDb(':memory:')
    const notifier = vi.fn(async () => true)
    const r = await executerWeekly({
      db,
      lireStatuts: async () => ['Repondu ', ' IGNORE', 'nouveau', ' Repondu'],
      notifier,
    })
    expect(r.repondus).toBe(2)
    expect(r.ignores).toBe(1)
    expect(r.nouveaux).toBe(1)
  })
})
