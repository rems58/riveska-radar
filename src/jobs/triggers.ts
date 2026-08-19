import type { RadarDb } from '../db.ts'
import { recupererTexte } from '../collectors/http.ts'
import { extraireBlocsItem, extraireBalise } from '../collectors/rss.ts'
import { normaliser } from '../filter/keywords.ts'

/** Flux Apple + Google surveilles pour detecter une nouvelle exigence de publication. */
export const FLUX_PLATEFORMES: string[] = [
  'https://developer.apple.com/news/releases/rss/releases.rss',
  'https://developer.apple.com/news/rss/news.rss',
  'https://developer.android.com/feeds/androiddevelopers.xml',
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
      const lien = extraireBalise(bloc, 'link')
      if (!titre || !lien) continue

      const id = `trigger:${lien}`
      if (d.db.dejaVu(id)) continue

      const texteNormalise = normaliser(titre)
      const rupture = MOTS_RUPTURE.some((mot) => texteNormalise.includes(normaliser(mot)))
      if (!rupture) continue

      d.db.marquerVu({ id, auteur: 'plateforme', url: lien, score: 100 })
      const notifie = await d.notifier(`Annonce plateforme : ${titre}\n${lien}`)
      if (!notifie) {
        // Ici, contrairement a radar.ts, il n'y a pas de Sheet en secours : l'annonce
        // n'est notifiee que par Telegram. On la compte quand meme comme "vue" (pas de
        // nouvelle tentative), le RSS ne la renverra plus - seul le log garde la trace.
        notificationsEchouees++
        console.warn(`[radar] triggers : notification Telegram echouee pour l'annonce ${lien}`)
      }
      nouvelles++
    }
  }

  console.log(
    `[radar] triggers : run termine, ${nouvelles} nouvelles annonces, ` +
      `${notificationsEchouees} notifications echouees`,
  )
  return { nouvelles, notificationsEchouees }
}
