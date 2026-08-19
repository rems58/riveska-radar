import type { RadarDb } from '../db.ts'
import { MAX_ECHECS_TECHNIQUES } from '../db.ts'
import { recupererTexte } from '../collectors/http.ts'
import { extraireBlocsItem, extraireBalise, extraireLien } from '../collectors/rss.ts'
import { normaliser } from '../filter/keywords.ts'

/**
 * Flux Apple + Google surveilles pour detecter une nouvelle exigence de publication.
 * developer.android.com/feeds/androiddevelopers.xml (l'URL d'origine) renvoie 404
 * depuis - verifie en appel reel le 2026-08-19. Remplace par le flux Atom du blog
 * Android Developers (meme contenu editorial, format Atom : confirme <entry> non vide,
 * 25 items lors de la verification), qui exerce le support Atom ajoute a extraireLien.
 */
export const FLUX_PLATEFORMES: string[] = [
  'https://developer.apple.com/news/releases/rss/releases.rss',
  'https://developer.apple.com/news/rss/news.rss',
  'https://android-developers.googleblog.com/feeds/posts/default',
]

/**
 * Mots de rupture : une annonce qui en contient change les regles du jeu pour
 * des centaines de devs en quelques heures (ex: nouvelle version d'API obligatoire).
 * Compares sur le titre normalise (minuscules, sans accents) via un simple "contient",
 * les phrases etant a plusieurs mots.
 */
const MOTS_RUPTURE: string[] = [
  'requirement', 'required', 'must target', 'deadline', 'deprecat',
  'policy update', 'new rules', 'will no longer', 'breaking change', 'target api',
]

export interface DepsTriggers {
  db: RadarDb
  notifier: (texte: string) => Promise<boolean>
}

export interface ResultatTriggers {
  nouvelles: number
  notificationsEchouees: number
}

/**
 * Surveille les flux Apple/Google : quand une plateforme impose une nouvelle exigence,
 * des centaines de devs se retrouvent bloques dans les 72h. Etre prevenu avant la vague
 * permet de preparer les reponses a l'avance.
 *
 * Reutilise recupererTexte (timeout/taille/logs) et l'extraction RSS de collectors/rss.ts :
 * aucune logique de parsing XML dupliquee ici.
 */
export async function executerTriggers(d: DepsTriggers): Promise<ResultatTriggers> {
  let nouvelles = 0
  let notificationsEchouees = 0

  for (const flux of FLUX_PLATEFORMES) {
    const xml = await recupererTexte({ source: 'triggers', url: flux })
    if (xml === null) continue

    for (const bloc of extraireBlocsItem(xml)) {
      const titre = extraireBalise(bloc, 'title')
      const lien = extraireLien(bloc)
      if (!titre || !lien) continue

      const id = `trigger:${lien}`
      if (d.db.dejaVu(id)) continue

      const texteNormalise = normaliser(titre)
      const rupture = MOTS_RUPTURE.some((mot) => texteNormalise.includes(normaliser(mot)))
      if (!rupture) continue

      // Contrairement a radar.ts, il n'y a pas de Sheet en secours ici : Telegram EST
      // le livrable. Marquer "vu" avant de savoir si la notif a reussi perdrait l'alerte
      // pour de bon (le flux RSS ne represente jamais le meme lien). On ne marque donc
      // vu qu'apres un envoi reussi ; un echec est compte comme un echec technique
      // ordinaire (meme compteur/plafond que radar.ts) pour permettre une nouvelle
      // tentative au run suivant, tout en bornant les essais si Telegram reste en panne.
      const notifie = await d.notifier(`Annonce plateforme : ${titre}\n${lien}`)
      if (!notifie) {
        notificationsEchouees++
        const echecs = d.db.enregistrerEchec({ id, auteur: 'plateforme', url: lien })
        if (echecs >= MAX_ECHECS_TECHNIQUES) {
          console.warn(
            `[radar] triggers : annonce ${lien} abandonnee apres ${echecs} echecs de notification`,
          )
        } else {
          console.warn(
            `[radar] triggers : notification Telegram echouee pour l'annonce ${lien} ` +
              `(tentative ${echecs}/${MAX_ECHECS_TECHNIQUES}, sera retentee au prochain run)`,
          )
        }
        continue
      }

      d.db.marquerVu({ id, auteur: 'plateforme', url: lien, score: 100 })
      nouvelles++
    }
  }

  console.log(
    `[radar] triggers : run termine, ${nouvelles} nouvelles annonces, ` +
      `${notificationsEchouees} notifications echouees`,
  )
  return { nouvelles, notificationsEchouees }
}
