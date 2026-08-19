import { executerPipeline } from './pipeline.ts'
import type { DepsPipeline, ResultatPipeline } from './pipeline.ts'

/**
 * jobs/reddit.ts : Reddit via search.rss (collectors/reddit-rss.ts), en SEQUENTIEL
 * STRICT a 1 requete/minute - contrainte mesuree, voir reddit-rss.ts. C'est pourquoi
 * cette source n'est PAS collectee par radar.ts (qui lance ses sources en parallele
 * toutes les 15 minutes) : l'y greffer casserait soit la cadence de radar, soit la
 * politesse envers Reddit. Une commande separee, planifiee une fois par heure, resout
 * les deux (12 requetes x 1/min = 12 min par run, tient largement dans l'heure).
 *
 * Reutilise exactement le meme pipeline aval que radar.ts (jobs/pipeline.ts) : meme
 * base pour la deduplication, memes compteurs d'echecs/abandons, meme verrou de
 * process (cable dans src/index.ts comme pour les trois autres commandes).
 */
export type DepsReddit = DepsPipeline
export type ResultatReddit = ResultatPipeline

export async function executerReddit(d: DepsReddit): Promise<ResultatReddit> {
  return executerPipeline('reddit', d)
}
