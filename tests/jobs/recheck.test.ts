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

  it('ne marque pas le recheck fait quand la notification echoue - reessaie au run suivant', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = ouvrirDb(':memory:')
    db.marquerVu({ id: 'reddit:a', auteur: 'bob', url: 'https://reddit.com/a', score: 80, recheckLe: new Date(Date.now() - 1000) })
    const notifier = vi.fn(async () => false)

    const r1 = await executerRecheck({ db, compterReponses: async () => 0, notifier })
    expect(r1.sansReponse).toBe(1)
    expect(r1.notificationsEchouees).toBe(1)
    // Pas marque fait : aRecheck() doit representer la meme ligne au run suivant.
    expect(db.aRecheck().map((l) => l.id)).toEqual(['reddit:a'])

    const log = warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('Telegram echouee'))
    expect(log).toBeDefined()
  })

  it('marque enfin le recheck fait des que la notification finit par reussir', async () => {
    const db = ouvrirDb(':memory:')
    db.marquerVu({ id: 'reddit:a', auteur: 'bob', url: 'https://reddit.com/a', score: 80, recheckLe: new Date(Date.now() - 1000) })

    await executerRecheck({ db, compterReponses: async () => 0, notifier: async () => false })
    expect(db.aRecheck()).toHaveLength(1)

    await executerRecheck({ db, compterReponses: async () => 0, notifier: async () => true })
    expect(db.aRecheck()).toHaveLength(0)
  })

  it('abandonne (marque fait) apres MAX_ECHECS_TECHNIQUES echecs de notification repetes', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const db = ouvrirDb(':memory:')
    db.marquerVu({ id: 'reddit:a', auteur: 'bob', url: 'https://reddit.com/a', score: 80, recheckLe: new Date(Date.now() - 1000) })
    const notifier = vi.fn(async () => false)

    await executerRecheck({ db, compterReponses: async () => 0, notifier })
    await executerRecheck({ db, compterReponses: async () => 0, notifier })
    const r3 = await executerRecheck({ db, compterReponses: async () => 0, notifier })

    expect(notifier).toHaveBeenCalledTimes(3)
    expect(db.aRecheck()).toHaveLength(0) // abandonne : plus jamais represente
    expect(r3.notificationsEchouees).toBe(1)
    const log = warnSpy.mock.calls.map((c) => String(c[0])).find((m) => m.includes('abandonnee'))
    expect(log).toBeDefined()
  })

  it('un Telegram rate sur le recheck ne fait JAMAIS repasser le post pour "non vu" (dejaVu)', async () => {
    // Regression cruciale : ligne.id est un id de post REEL deja retenu par le
    // pipeline principal. Si le compteur de retry de recheck partageait la colonne
    // "echecs" du pipeline (enregistrerEchec), dejaVu() considererait ce post comme
    // "non vu" apres un simple Telegram rate ici, et radar.ts le re-collecterait,
    // re-scorerait et re-ecrirait au Sheet en double.
    const db = ouvrirDb(':memory:')
    db.marquerVu({ id: 'reddit:a', auteur: 'bob', url: 'https://reddit.com/a', score: 80, recheckLe: new Date(Date.now() - 1000) })
    expect(db.dejaVu('reddit:a')).toBe(true)

    await executerRecheck({ db, compterReponses: async () => 0, notifier: async () => false })

    expect(db.dejaVu('reddit:a')).toBe(true)
  })
})
