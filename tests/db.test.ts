import { describe, it, expect, beforeEach } from 'vitest'
import { ouvrirDb, type RadarDb } from '../src/db.ts'

describe('RadarDb', () => {
  let db: RadarDb
  beforeEach(() => {
    db = ouvrirDb(':memory:')
  })

  it('signale un post inconnu comme non vu', () => {
    expect(db.dejaVu('reddit:abc')).toBe(false)
  })

  it('signale un post enregistre comme vu', () => {
    db.marquerVu({ id: 'reddit:abc', auteur: 'bob', url: 'https://r/1', score: 80 })
    expect(db.dejaVu('reddit:abc')).toBe(true)
  })

  it('compte les apparitions precedentes d un meme auteur', () => {
    db.marquerVu({ id: 'reddit:a', auteur: 'bob', url: 'https://r/1', score: 70 })
    db.marquerVu({ id: 'reddit:b', auteur: 'bob', url: 'https://r/2', score: 75 })
    expect(db.compterApparitions('bob')).toBe(2)
    expect(db.compterApparitions('alice')).toBe(0)
  })

  it('rend les posts a re-verifier une fois leur echeance passee', () => {
    const passe = new Date(Date.now() - 1000)
    const futur = new Date(Date.now() + 60_000)
    db.marquerVu({ id: 'reddit:a', auteur: 'bob', url: 'https://r/1', score: 70, recheckLe: passe })
    db.marquerVu({ id: 'reddit:b', auteur: 'ana', url: 'https://r/2', score: 70, recheckLe: futur })
    const a = db.aRecheck()
    expect(a.map((p) => p.id)).toEqual(['reddit:a'])
  })

  it('ne rend plus un post dont le re-check est fait', () => {
    const passe = new Date(Date.now() - 1000)
    db.marquerVu({ id: 'reddit:a', auteur: 'bob', url: 'https://r/1', score: 70, recheckLe: passe })
    db.marquerRecheckFait('reddit:a')
    expect(db.aRecheck()).toHaveLength(0)
  })

  it('purge les lignes plus vieilles que la retention', () => {
    const vieux = new Date(Date.now() - 100 * 24 * 3600 * 1000)
    db.marquerVu({ id: 'reddit:vieux', auteur: 'bob', url: 'https://r/1', score: 70, vuLe: vieux })
    db.marquerVu({ id: 'reddit:neuf', auteur: 'bob', url: 'https://r/2', score: 70 })
    const supprimes = db.purger(90)
    expect(supprimes).toBe(1)
    expect(db.dejaVu('reddit:vieux')).toBe(false)
    expect(db.dejaVu('reddit:neuf')).toBe(true)
  })

  it('compte les prospects retenus depuis une date', () => {
    db.marquerVu({ id: 'reddit:a', auteur: 'bob', url: 'https://r/1', score: 80 })
    db.marquerVu({ id: 'reddit:b', auteur: 'ana', url: 'https://r/2', score: 90 })
    const depuis = new Date(Date.now() - 3600 * 1000)
    expect(db.compterDepuis(depuis)).toBe(2)
  })

  it('ne reannule pas un re-check deja fait quand on remarque le post sans recheckLe', () => {
    const passe = new Date(Date.now() - 1000)
    db.marquerVu({ id: 'reddit:a', auteur: 'bob', url: 'https://r/1', score: 70, recheckLe: passe })
    db.marquerRecheckFait('reddit:a')
    db.marquerVu({ id: 'reddit:a', auteur: 'bob', url: 'https://r/1', score: 75 })
    expect(db.aRecheck()).toHaveLength(0)
  })

  it('ne perd pas l echeance de re-check quand on remarque le post sans recheckLe', () => {
    const passe = new Date(Date.now() - 1000)
    db.marquerVu({ id: 'reddit:a', auteur: 'bob', url: 'https://r/1', score: 70, recheckLe: passe })
    db.marquerVu({ id: 'reddit:a', auteur: 'bob', url: 'https://r/1', score: 75 })
    expect(db.aRecheck().map((p) => p.id)).toEqual(['reddit:a'])
  })

  it('un nouveau recheckLe explicite ecrase bien l ancien', () => {
    const passe = new Date(Date.now() - 1000)
    const futur = new Date(Date.now() + 60_000)
    db.marquerVu({ id: 'reddit:a', auteur: 'bob', url: 'https://r/1', score: 70, recheckLe: passe })
    db.marquerVu({ id: 'reddit:a', auteur: 'bob', url: 'https://r/1', score: 75, recheckLe: futur })
    expect(db.aRecheck()).toHaveLength(0)
  })
})
