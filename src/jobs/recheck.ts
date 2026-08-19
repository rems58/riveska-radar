import type { RadarDb } from '../db.ts'

export interface DepsRecheck {
  db: RadarDb
  compterReponses: (url: string) => Promise<number>
  notifier: (texte: string) => Promise<boolean>
}

export interface ResultatRecheck {
  verifies: number
  sansReponse: number
}

/**
 * Suivi 48h : zero reponse apres 48h = le prospect est toujours bloque et personne
 * ne l'a aide. C'est le meilleur moment pour repondre. On previent l'humain,
 * on n'envoie rien a sa place.
 */
export async function executerRecheck(d: DepsRecheck): Promise<ResultatRecheck> {
  let verifies = 0
  let sansReponse = 0

  for (const ligne of d.db.aRecheck()) {
    let reponses: number
    try {
      reponses = await d.compterReponses(ligne.url)
    } catch (err) {
      // Post inaccessible (supprime, prive) : on ne peut pas conclure, donc on ne
      // notifie pas et on ne reboucle pas dessus - il n'y a rien de plus a apprendre.
      const raison = err instanceof Error ? err.message : String(err)
      console.warn(`[radar] recheck : post ${ligne.id} inaccessible (${raison})`)
      reponses = -1
    }

    verifies++

    if (reponses === 0) {
      sansReponse++
      await d.notifier(
        `Toujours sans reponse apres 48h - ${ligne.auteur}\n${ligne.url}`,
      )
    }

    d.db.marquerRecheckFait(ligne.id)
  }

  return { verifies, sansReponse }
}
