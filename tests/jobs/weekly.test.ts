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

  it('le taux reflete la fenetre de 7 jours, pas l historique complet du Sheet', async () => {
    const db = ouvrirDb(':memory:')
    const notifier = vi.fn(async () => true)
    // lireStatuts recoit la date de debut de fenetre et ne renvoie (comme le fera le
    // vrai lecteur de Sheet, Task 18) que les lignes dont date_detect est dans la
    // fenetre : 2 lignes recentes, pas les 10 lignes anciennes qui existent par ailleurs.
    const lireStatuts = vi.fn(async (_depuis: Date) => ['repondu', 'repondu'])
    const r = await executerWeekly({ db, lireStatuts, notifier })
    expect(r.detectes).toBe(2)
    expect(r.repondus).toBe(2)
    expect(formaterStats(r)).toContain('100%')
    expect(lireStatuts).toHaveBeenCalledWith(expect.any(Date))
  })

  it('n affiche pas un pourcentage errone : detectes et repondus viennent toujours de la meme liste de statuts', async () => {
    const db = ouvrirDb(':memory:')
    const notifier = vi.fn(async () => true)
    const r = await executerWeekly({
      db,
      lireStatuts: async () => ['repondu', 'ignore', 'nouveau', 'repondu', 'ignore'],
      notifier,
    })
    // detectes doit etre la taille de la liste renvoyee (population du Sheet dans la
    // fenetre), jamais un comptage independant tire d'une autre source (ex: posts_vus,
    // qui contient aussi les rejets et les entrees trigger: jamais ecrites au Sheet).
    expect(r.detectes).toBe(5)
  })
})
