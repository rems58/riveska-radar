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

export interface EntreeEchec {
  id: string
  auteur: string
  url: string
}

export interface RadarDb {
  dejaVu(id: string): boolean
  marquerVu(entree: EntreeVue): void
  /**
   * Compte les apparitions PRECEDENTES d'un auteur (utilise pour doubler le score
   * d'un prospect deja detecte). excludeId doit toujours etre l'id du post en cours
   * de traitement : un echec technique (enregistrerEchec) cree une ligne pour ce
   * meme post AVANT que son propre scoring soit retente, donc sans exclusion un
   * post se compterait lui-meme comme "une apparition precedente" au run suivant.
   */
  compterApparitions(auteur: string, excludeId?: string): number
  aRecheck(): LigneRecheck[]
  marquerRecheckFait(id: string): void
  purger(retentionJours: number): number
  compterDepuis(date: Date): number
  /**
   * Enregistre un echec technique (LLM/Sheets injoignable, etc. - pas un rejet
   * legitime) sur ce post et renvoie le nombre total d'echecs cumules.
   * Le post reste "non vu" (dejaVu renvoie false) tant que ce compteur est
   * sous MAX_ECHECS_TECHNIQUES, pour permettre une nouvelle tentative au run
   * suivant. Au-dela, il bascule "vu" pour eviter de le re-scorer indefiniment
   * (chaque tentative de scoring est payante).
   */
  enregistrerEchec(entree: EntreeEchec): number
  /**
   * Trace qu'une source de collecte a renvoye 0 post alors que d'autres en ont
   * renvoye (voir collectors/index.ts). Permet au bilan hebdomadaire de signaler
   * une source restee muette plusieurs jours de suite, pas seulement le run courant.
   */
  enregistrerSourceVide(nom: string): void
  /** Nombre d'incidents "source vide" par source depuis une date (pour le bilan hebdo). */
  compterSourcesVidesDepuis(depuis: Date): Record<string, number>
}

/** Nombre d'echecs techniques toleres avant d'abandonner definitivement un post. */
export const MAX_ECHECS_TECHNIQUES = 3

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
      recheck_fait INTEGER NOT NULL DEFAULT 0,
      echecs INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_posts_auteur ON posts_vus(auteur);
    CREATE INDEX IF NOT EXISTS idx_posts_recheck ON posts_vus(recheck_le, recheck_fait);
    CREATE INDEX IF NOT EXISTS idx_posts_vu_le ON posts_vus(vu_le);
    CREATE TABLE IF NOT EXISTS sources_vides (
      nom TEXT NOT NULL,
      horodatage INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sources_vides_horodatage ON sources_vides(horodatage);
  `)

  // Migration non destructive : une base ouverte avant l'ajout du compteur d'echecs
  // n'a pas cette colonne (CREATE TABLE IF NOT EXISTS ne la lui ajoute pas retroactivement).
  // SQLite backfille la valeur DEFAULT sur les lignes existantes, qui deviennent donc
  // echecs=0, c'est-a-dire "resolu" - coherent avec leur etat reel avant la migration.
  const colonnes = db.prepare('PRAGMA table_info(posts_vus)').all() as { name: string }[]
  if (!colonnes.some((c) => c.name === 'echecs')) {
    db.exec('ALTER TABLE posts_vus ADD COLUMN echecs INTEGER NOT NULL DEFAULT 0')
  }

  return {
    dejaVu(id) {
      // echecs = 0 : jamais tente, ou definitivement resolu (marquerVu remet toujours a 0).
      // echecs 1-2 : echec technique, en attente de nouvelle tentative -> PAS "vu".
      // echecs >= MAX_ECHECS_TECHNIQUES : abandonne -> "vu" pour ne plus jamais le re-scorer.
      const r = db.prepare('SELECT echecs FROM posts_vus WHERE id = ?').get(id) as
        | { echecs: number }
        | undefined
      if (!r) return false
      return r.echecs === 0 || r.echecs >= MAX_ECHECS_TECHNIQUES
    },

    marquerVu(e) {
      // Si recheckLe n'est pas fourni, on doit preserver l'etat de re-check existant
      // (recheck_le et recheck_fait) plutot que de l'ecraser silencieusement : sinon,
      // remarquer un post deja re-verifie annulerait son re-check.
      const recheckFourni = e.recheckLe !== undefined
      db.prepare(
        `INSERT INTO posts_vus (id, auteur, url, score, vu_le, recheck_le, recheck_fait, echecs)
         VALUES (@id, @auteur, @url, @score, @vuLe, @recheckLe, 0, 0)
         ON CONFLICT(id) DO UPDATE SET
           auteur = excluded.auteur,
           url = excluded.url,
           score = excluded.score,
           vu_le = excluded.vu_le,
           recheck_le = CASE WHEN @recheckFourni = 1 THEN excluded.recheck_le ELSE posts_vus.recheck_le END,
           recheck_fait = CASE WHEN @recheckFourni = 1 THEN 0 ELSE posts_vus.recheck_fait END,
           -- marquerVu signale toujours une resolution definitive (succes ou rejet
           -- legitime) : le compteur d'echecs technique n'a plus lieu d'etre.
           echecs = 0`,
      ).run({
        id: e.id,
        auteur: e.auteur,
        url: e.url,
        score: e.score,
        vuLe: (e.vuLe ?? new Date()).getTime(),
        recheckLe: e.recheckLe ? e.recheckLe.getTime() : null,
        recheckFourni: recheckFourni ? 1 : 0,
      })
    },

    compterApparitions(auteur, excludeId) {
      // id != '' est un sentinel inoffensif quand excludeId est absent : aucun id
      // reel n'est jamais une chaine vide, donc rien n'est exclu dans ce cas.
      const r = db
        .prepare('SELECT COUNT(*) AS n FROM posts_vus WHERE auteur = ? AND id != ?')
        .get(auteur, excludeId ?? '') as { n: number }
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
      // Note RGPD : ceci efface aussi les entrees "trigger:..." (annonces Apple/Google,
      // cf jobs/triggers.ts), qui partagent cette meme table. Effet de bord assume et
      // benin : un flux RSS ne fait jamais reapparaitre un item de plus de 90 jours sous
      // le meme lien, donc le pire cas est une re-notification (rarissime), jamais une
      // perte de donnee sensible.
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

    enregistrerEchec(e) {
      db.prepare(
        `INSERT INTO posts_vus (id, auteur, url, score, vu_le, recheck_le, recheck_fait, echecs)
         VALUES (@id, @auteur, @url, 0, @vuLe, NULL, 0, 1)
         ON CONFLICT(id) DO UPDATE SET
           auteur = excluded.auteur,
           url = excluded.url,
           vu_le = excluded.vu_le,
           echecs = posts_vus.echecs + 1`,
      ).run({ id: e.id, auteur: e.auteur, url: e.url, vuLe: Date.now() })

      const r = db.prepare('SELECT echecs FROM posts_vus WHERE id = ?').get(e.id) as { echecs: number }
      return r.echecs
    },

    enregistrerSourceVide(nom) {
      db.prepare('INSERT INTO sources_vides (nom, horodatage) VALUES (?, ?)').run(nom, Date.now())
    },

    compterSourcesVidesDepuis(depuis) {
      const lignes = db
        .prepare('SELECT nom, COUNT(*) AS n FROM sources_vides WHERE horodatage >= ? GROUP BY nom')
        .all(depuis.getTime()) as { nom: string; n: number }[]
      const resultat: Record<string, number> = {}
      for (const l of lignes) resultat[l.nom] = l.n
      return resultat
    },
  }
}
