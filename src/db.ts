import Database from 'better-sqlite3'

export interface EntreeVue {
  id: string
  auteur: string
  url: string
  score: number
  /** Par defaut : maintenant. Parametrable pour les tests. */
  vuLe?: Date
  /** Si renseigne, le post sera propose au job recheck a partir de cette date. */
  recheckLe?: Date
}

export interface LigneRecheck {
  id: string
  url: string
  auteur: string
}

export interface RadarDb {
  dejaVu(id: string): boolean
  marquerVu(entree: EntreeVue): void
  compterApparitions(auteur: string): number
  aRecheck(): LigneRecheck[]
  marquerRecheckFait(id: string): void
  purger(retentionJours: number): number
  compterDepuis(date: Date): number
}

/**
 * Ouvre (et cree si besoin) la base locale du radar.
 * Ne stocke que des donnees publiques : pseudo, URL, score. Jamais d'email ni de nom civil.
 */
export function ouvrirDb(chemin: string): RadarDb {
  const db = new Database(chemin)
  db.pragma('journal_mode = WAL')
  db.exec(`
    CREATE TABLE IF NOT EXISTS posts_vus (
      id TEXT PRIMARY KEY,
      auteur TEXT NOT NULL,
      url TEXT NOT NULL,
      score INTEGER NOT NULL,
      vu_le INTEGER NOT NULL,
      recheck_le INTEGER,
      recheck_fait INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_posts_auteur ON posts_vus(auteur);
    CREATE INDEX IF NOT EXISTS idx_posts_recheck ON posts_vus(recheck_le, recheck_fait);
  `)

  return {
    dejaVu(id) {
      const r = db.prepare('SELECT 1 FROM posts_vus WHERE id = ?').get(id)
      return r !== undefined
    },

    marquerVu(e) {
      db.prepare(
        `INSERT OR REPLACE INTO posts_vus (id, auteur, url, score, vu_le, recheck_le, recheck_fait)
         VALUES (?, ?, ?, ?, ?, ?, 0)`,
      ).run(
        e.id,
        e.auteur,
        e.url,
        e.score,
        (e.vuLe ?? new Date()).getTime(),
        e.recheckLe ? e.recheckLe.getTime() : null,
      )
    },

    compterApparitions(auteur) {
      const r = db.prepare('SELECT COUNT(*) AS n FROM posts_vus WHERE auteur = ?').get(auteur) as {
        n: number
      }
      return r.n
    },

    aRecheck() {
      return db
        .prepare(
          `SELECT id, url, auteur FROM posts_vus
           WHERE recheck_le IS NOT NULL AND recheck_le <= ? AND recheck_fait = 0`,
        )
        .all(Date.now()) as LigneRecheck[]
    },

    marquerRecheckFait(id) {
      db.prepare('UPDATE posts_vus SET recheck_fait = 1 WHERE id = ?').run(id)
    },

    purger(retentionJours) {
      const limite = Date.now() - retentionJours * 24 * 3600 * 1000
      const r = db.prepare('DELETE FROM posts_vus WHERE vu_le < ?').run(limite)
      return r.changes
    },

    compterDepuis(date) {
      const r = db
        .prepare('SELECT COUNT(*) AS n FROM posts_vus WHERE vu_le >= ?')
        .get(date.getTime()) as { n: number }
      return r.n
    },
  }
}
