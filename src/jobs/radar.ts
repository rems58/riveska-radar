import { executerPipeline } from './pipeline.ts'
import type { DepsPipeline, ResultatPipeline } from './pipeline.ts'

/**
 * radar.ts est le job "sources paralleles" (Reddit OAuth si actif, Hacker News,
 * Stack Overflow, Bluesky, Mastodon - via collectors/index.ts), lance toutes les
 * 15 minutes. Le pipeline aval (dedup -> prefiltre -> scoring -> enrichissement ->
 * Sheet -> Telegram) est partage avec jobs/reddit.ts (Reddit RSS, sequentiel strict,
 * horaire) via jobs/pipeline.ts - voir ce fichier pour le detail et le pourquoi du
 * partage. DepsRadar/ResultatRadar restent des alias distincts (plutot que d'utiliser
 * DepsPipeline/ResultatPipeline partout) pour ne pas casser les imports existants.
 */
export type DepsRadar = DepsPipeline
export type ResultatRadar = ResultatPipeline

export async function executerRadar(d: DepsRadar): Promise<ResultatRadar> {
  return executerPipeline('radar', d)
}
