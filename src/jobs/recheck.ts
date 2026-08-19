import type { RadarDb } from '../db.ts'
import { MAX_ECHECS_TECHNIQUES } from '../db.ts'

export interface DepsRecheck {
  db: RadarDb
  compterReponses: (url: string) => Promise<number>
  notifier: (texte: string) => Promise<boolean>
}

export interface ResultatRecheck {
  verifies: number
  sansReponse: number
  notificationsEchouees: number
}

/**
 * Suivi 48h : zero reponse apres 48h = le prospect est toujours bloque et personne
 * ne l'a aide. C'est le meilleur moment pour repondre. On previent l'humain,
 * on n'envoie rien a sa place.
 *
 * Un Telegram rate sur "sans reponse" ne doit jamais etre traite comme fait : sans
 * ca, l'alerte est perdue pour de bon (meme traitement que triggers.ts/radar.ts).
 * marquerRecheckFait n'est donc appele qu'apres un envoi reussi, ou apres
 * MAX_ECHECS_TECHNIQUES tentatives infructueuses (pour ne pas reessayer indefiniment
 * si Telegram reste en panne durablement).
 */
export async function executerRecheck(d: DepsRecheck): Promise<ResultatRecheck> {
  let verifies = 0
  let sansReponse = 0
  let notificationsEchouees = 0

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

    if (reponses !== 0) {
      d.db.marquerRecheckFait(ligne.id)
      continue
    }

    sansReponse++
    const notifie = await d.notifier(`Toujours sans reponse apres 48h - ${ligne.auteur}\n${ligne.url}`)
    if (notifie) {
      d.db.marquerRecheckFait(ligne.id)
      continue
    }

    notificationsEchouees++
    // Compteur DEDIE (pas enregistrerEchec/echecs) : ligne.id est un id de post reel
    // deja retenu par le pipeline principal, et enregistrerEchec ferait passer ce
    // meme post pour "non vu" (dejaVu) apres un simple Telegram rate ici.
    const echecs = d.db.enregistrerEchecNotificationRecheck(ligne.id)
    if (echecs >= MAX_ECHECS_TECHNIQUES) {
      console.warn(
        `[radar] recheck : notification "sans reponse" abandonnee pour ${ligne.id} apres ${echecs} echecs`,
      )
      d.db.marquerRecheckFait(ligne.id)
    } else {
      console.warn(
        `[radar] recheck : notification Telegram echouee pour ${ligne.id} ` +
          `(tentative ${echecs}/${MAX_ECHECS_TECHNIQUES}, sera retentee au prochain run)`,
      )
      // recheck_fait reste a 0 : aRecheck() la represente au prochain run.
    }
  }

  return { verifies, sansReponse, notificationsEchouees }
}
