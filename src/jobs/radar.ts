import type { RawPost, ScoredPost, EnrichedPost } from '../types.ts'
import type { RadarDb } from '../db.ts'
import { prefiltrer } from '../filter/prefilter.ts'

const DELAI_RECHECK_MS = 48 * 3600 * 1000

export interface DepsRadar {
  db: RadarDb
  collecter: () => Promise<RawPost[]>
  noter: (p: RawPost, apparitions: number) => Promise<ScoredPost | null>
  enrichir: (p: ScoredPost) => Promise<EnrichedPost | null>
  ecrireSheet: (posts: EnrichedPost[]) => Promise<number | null>
  notifier: (p: EnrichedPost, ligne: number | null) => Promise<boolean>
  seuil: number
  ageMaxJours: number
  retentionJours: number
}

export interface ResultatRadar {
  collectes: number
  candidats: number
  retenus: number
  purges: number
}

/**
 * Pipeline principal : collecte -> dedup -> filtre gratuit -> scoring LLM -> enrichissement
 * -> Sheet -> Telegram. N'envoie jamais rien a un tiers : le brouillon reste dans le Sheet.
 *
 * Chaque candidat est traite dans son propre try/catch : une exception (LLM en panne,
 * Sheets injoignable, etc.) sur un post ne doit jamais faire perdre les candidats
 * suivants du run. C'est le seul job qui tourne 24/7 sans supervision humaine.
 */
export async function executerRadar(d: DepsRadar): Promise<ResultatRadar> {
  const purges = d.db.purger(d.retentionJours)

  const bruts = await d.collecter()
  const inedits = bruts.filter((p) => !d.db.dejaVu(p.id))
  const candidats = prefiltrer(inedits, d.ageMaxJours)

  let retenus = 0

  for (const c of candidats) {
    try {
      const apparitions = d.db.compterApparitions(c.auteur)
      const note = await d.noter(c, apparitions)

      if (!note || note.score < d.seuil) {
        // Memorise quand meme : evite de repayer un scoring sur le meme post au prochain passage.
        d.db.marquerVu({ id: c.id, auteur: c.auteur, url: c.url, score: note?.score ?? 0 })
        continue
      }

      const enrichi = await d.enrichir(note)
      if (!enrichi) {
        d.db.marquerVu({ id: c.id, auteur: c.auteur, url: c.url, score: note.score })
        continue
      }

      const ligne = await d.ecrireSheet([enrichi])
      await d.notifier(enrichi, ligne)

      d.db.marquerVu({
        id: enrichi.id, auteur: enrichi.auteur, url: enrichi.url, score: enrichi.score,
        recheckLe: new Date(Date.now() + DELAI_RECHECK_MS),
      })
      retenus++
    } catch (err) {
      const raison = err instanceof Error ? err.message : String(err)
      console.warn(`[radar] pipeline : post ${c.id} abandonne (${raison})`)
    }
  }

  const resultat: ResultatRadar = { collectes: bruts.length, candidats: candidats.length, retenus, purges }
  // Seule trace visible dans le Planificateur de taches Windows : un run silencieux
  // qui echoue partout resterait indetectable sans ce log.
  console.log(
    `[radar] run termine : ${resultat.collectes} collectes, ${resultat.candidats} candidats, ` +
      `${resultat.retenus} retenus, ${resultat.purges} purges`,
  )
  return resultat
}
