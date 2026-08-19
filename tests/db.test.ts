import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { ouvrirDb, statistiquesDb, MAX_ECHECS_TECHNIQUES, type RadarDb } from '../src/db.ts'

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

  it('exclut le post dont l id est fourni (evite qu un post se compte lui-meme)', () => {
    // Un echec technique cree une ligne pour CE post avant que son propre scoring
    // soit retente : sans exclusion, il se compterait comme sa propre apparition
    // precedente au run suivant et doublerait son propre score.
    db.enregistrerEchec({ id: 'reddit:a', auteur: 'bob', url: 'https://r/1' })
    expect(db.compterApparitions('bob', 'reddit:a')).toBe(0)
    expect(db.compterApparitions('bob')).toBe(1)
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

  describe('enregistrerEchecNotificationRecheck', () => {
    it('cumule les echecs sans toucher au compteur pipeline (echecs) du meme post', () => {
      db.marquerVu({ id: 'reddit:a', auteur: 'bob', url: 'u', score: 80 })
      expect(db.dejaVu('reddit:a')).toBe(true)

      db.enregistrerEchecNotificationRecheck('reddit:a')
      const deuxieme = db.enregistrerEchecNotificationRecheck('reddit:a')

      expect(deuxieme).toBe(2)
      // Le post reste "vu" : le compteur de retry recheck est totalement independant
      // du compteur pipeline lu par dejaVu().
      expect(db.dejaVu('reddit:a')).toBe(true)
    })

    it('marquerRecheckFait nettoie le compteur de retry associe', () => {
      db.marquerVu({ id: 'reddit:a', auteur: 'bob', url: 'u', score: 80, recheckLe: new Date(Date.now() - 1000) })
      db.enregistrerEchecNotificationRecheck('reddit:a')
      db.marquerRecheckFait('reddit:a')
      // Un nouvel appel repart de 1, pas de 2 : la ligne precedente a bien ete purgee.
      expect(db.enregistrerEchecNotificationRecheck('reddit:a')).toBe(1)
    })
  })

  describe('sources vides', () => {
    it('compte les incidents par source depuis une date', () => {
      db.enregistrerSourceVide('bluesky')
      db.enregistrerSourceVide('bluesky')
      db.enregistrerSourceVide('mastodon')
      const compte = db.compterSourcesVidesDepuis(new Date(Date.now() - 3600 * 1000))
      expect(compte).toEqual({ bluesky: 2, mastodon: 1 })
    })

    it('ignore les incidents anterieurs a la date fournie', () => {
      db.enregistrerSourceVide('bluesky')
      const compte = db.compterSourcesVidesDepuis(new Date(Date.now() + 3600 * 1000))
      expect(compte).toEqual({})
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

  describe('statistiquesDb (commande sante)', () => {
    /**
     * Cette fonction ouvre le FICHIER en lecture seule : elle ne peut donc pas etre
     * testee sur une base ':memory:' comme le reste de ce fichier.
     */
    function surFichier(remplir: (db: RadarDb) => void, verifier: (chemin: string) => void): void {
      const dir = mkdtempSync(path.join(tmpdir(), 'radar-sante-'))
      const chemin = path.join(dir, 'radar.db')
      try {
        remplir(ouvrirDb(chemin))
        verifier(chemin)
      } finally {
        // Verrou Windows de better-sqlite3 : nettoyage best-effort (cf. test de migration).
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    }

    it('compte les posts vus et la date du dernier ajout', () => {
      const vieux = new Date(Date.now() - 3 * 24 * 3600 * 1000)
      surFichier(
        (db) => {
          db.marquerVu({ id: 'hn:1', auteur: 'bob', url: 'u1', score: 80, vuLe: vieux })
          db.marquerVu({ id: 'hn:2', auteur: 'ana', url: 'u2', score: 90 })
        },
        (chemin) => {
          const s = statistiquesDb(chemin)
          expect(s.posts).toBe(2)
          expect(s.dernierAjout!.getTime()).toBeGreaterThan(vieux.getTime())
        },
      )
    })

    it('separe les echecs en attente de retry des abandons definitifs', () => {
      surFichier(
        (db) => {
          db.enregistrerEchec({ id: 'hn:retry', auteur: 'bob', url: 'u1' })
          for (let i = 0; i < MAX_ECHECS_TECHNIQUES; i++) {
            db.enregistrerEchec({ id: 'hn:abandon', auteur: 'ana', url: 'u2' })
          }
        },
        (chemin) => {
          const s = statistiquesDb(chemin)
          expect(s.enAttenteRetry).toBe(1)
          expect(s.abandons).toBe(1)
          // vu_le est reecrit a chaque echec : cet abandon vient donc d'avoir lieu.
          expect(s.abandonsRecents).toBe(1)
        },
      )
    })

    it('ne compte pas comme recent un abandon de plus de 7 jours', () => {
      surFichier(
        (db) => {
          for (let i = 0; i < MAX_ECHECS_TECHNIQUES; i++) {
            db.enregistrerEchec({ id: 'hn:vieux', auteur: 'ana', url: 'u2' })
          }
        },
        (chemin) => {
          // Vieillit la ligne comme l'aurait fait le temps qui passe (enregistrerEchec
          // reecrit toujours vu_le a maintenant).
          const brut = new Database(chemin)
          brut.prepare('UPDATE posts_vus SET vu_le = ?').run(Date.now() - 30 * 24 * 3600 * 1000)
          brut.close()

          const s = statistiquesDb(chemin)
          expect(s.abandons).toBe(1)
          expect(s.abandonsRecents).toBe(0)
        },
      )
    })

    it('leve sur une base absente (jamais de creation implicite par une verification)', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'radar-sante-'))
      try {
        expect(() => statistiquesDb(path.join(dir, 'inexistante.db'))).toThrow()
        // Et surtout : le fichier n'a pas ete cree par la tentative.
        expect(existsSync(path.join(dir, 'inexistante.db'))).toBe(false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    })

    it('tolere une base anterieure a la colonne echecs', () => {
      const dir = mkdtempSync(path.join(tmpdir(), 'radar-sante-'))
      const fichier = path.join(dir, 'radar.db')
      try {
        const ancienne = new Database(fichier)
        ancienne.exec(`
          CREATE TABLE posts_vus (
            id TEXT PRIMARY KEY, auteur TEXT NOT NULL, url TEXT NOT NULL,
            score INTEGER NOT NULL, vu_le INTEGER NOT NULL,
            recheck_le INTEGER, recheck_fait INTEGER NOT NULL DEFAULT 0
          );
        `)
        ancienne
          .prepare('INSERT INTO posts_vus (id, auteur, url, score, vu_le, recheck_fait) VALUES (?,?,?,?,?,0)')
          .run('hn:ancien', 'bob', 'u', 80, Date.now())
        ancienne.close()

        const s = statistiquesDb(fichier)
        expect(s.posts).toBe(1)
        expect(s.enAttenteRetry).toBe(0)
        expect(s.abandons).toBe(0)
      } finally {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    })
  })
})
