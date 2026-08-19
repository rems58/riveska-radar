import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
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

  describe('enregistrerEchec', () => {
    it('un post en echec technique n est pas considere comme deja vu', () => {
      db.enregistrerEchec({ id: 'reddit:x', auteur: 'bob', url: 'https://r/1' })
      expect(db.dejaVu('reddit:x')).toBe(false)
    })

    it('cumule les echecs sur le meme post', () => {
      db.enregistrerEchec({ id: 'reddit:x', auteur: 'bob', url: 'https://r/1' })
      const deuxieme = db.enregistrerEchec({ id: 'reddit:x', auteur: 'bob', url: 'https://r/1' })
      expect(deuxieme).toBe(2)
    })

    it('abandonne definitivement un post apres 3 echecs techniques', () => {
      db.enregistrerEchec({ id: 'reddit:x', auteur: 'bob', url: 'https://r/1' })
      db.enregistrerEchec({ id: 'reddit:x', auteur: 'bob', url: 'https://r/1' })
      const troisieme = db.enregistrerEchec({ id: 'reddit:x', auteur: 'bob', url: 'https://r/1' })
      expect(troisieme).toBe(3)
      expect(db.dejaVu('reddit:x')).toBe(true)
    })

    it('marquerVu reinitialise le compteur d echecs d un post qui finit par reussir', () => {
      db.enregistrerEchec({ id: 'reddit:x', auteur: 'bob', url: 'https://r/1' })
      db.marquerVu({ id: 'reddit:x', auteur: 'bob', url: 'https://r/1', score: 90 })
      expect(db.dejaVu('reddit:x')).toBe(true)

      const apresReset = db.enregistrerEchec({ id: 'reddit:x', auteur: 'bob', url: 'https://r/1' })
      expect(apresReset).toBe(1)
    })
  })

  describe('migration de schema', () => {
    it('ouvre sans perte de donnees une base creee avant l ajout de la colonne echecs', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'radar-db-'))
      const fichier = path.join(dir, 'radar.db')
      try {
        // Simule une base ecrite par une version anterieure du code, sans colonne echecs.
        const ancienne = new Database(fichier)
        ancienne.exec(`
          CREATE TABLE posts_vus (
            id TEXT PRIMARY KEY,
            auteur TEXT NOT NULL,
            url TEXT NOT NULL,
            score INTEGER NOT NULL,
            vu_le INTEGER NOT NULL,
            recheck_le INTEGER,
            recheck_fait INTEGER NOT NULL DEFAULT 0
          );
        `)
        ancienne
          .prepare(
            `INSERT INTO posts_vus (id, auteur, url, score, vu_le, recheck_fait)
             VALUES (?, ?, ?, ?, ?, 0)`,
          )
          .run('reddit:ancien', 'bob', 'https://r/1', 80, Date.now())
        ancienne.close()

        const migree = ouvrirDb(fichier)
        // La donnee pre-existante n'est pas perdue et reste consideree comme traitee.
        expect(migree.dejaVu('reddit:ancien')).toBe(true)
        expect(migree.compterApparitions('bob')).toBe(1)
        // Le compteur d'echecs fonctionne desormais normalement sur cette base migree.
        migree.enregistrerEchec({ id: 'reddit:nouveau', auteur: 'ana', url: 'https://r/2' })
        expect(migree.dejaVu('reddit:nouveau')).toBe(false)
      } finally {
        // Sous Windows, better-sqlite3 garde un verrou sur le fichier tant que le process
        // vit (RadarDb n'expose pas de close()) : le nettoyage est best-effort, pas critique
        // puisqu'il s'agit d'un dossier temporaire genere par mkdtempSync.
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    })
  })
})
