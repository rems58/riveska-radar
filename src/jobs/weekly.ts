import type { RadarDb } from '../db.ts'
import { normaliser } from '../filter/keywords.ts'

export interface Stats {
  detectes: number
  repondus: number
  ignores: number
  nouveaux: number
}

export function formaterStats(s: Stats): string {
  const taux = s.detectes > 0 ? Math.round((s.repondus / s.detectes) * 100) : 0
  return (
    `Bilan de la semaine\n` +
    `Detectes : ${s.detectes}\n` +
    `Repondus : ${s.repondus} (${taux}%)\n` +
    `Non traites : ${s.nouveaux}\n` +
    `Ignores : ${s.ignores}`
  )
}

const SEPT_JOURS_MS = 7 * 24 * 3600 * 1000

export interface DepsWeekly {
  db: RadarDb
  lireStatuts: () => Promise<string[]>
  notifier: (texte: string) => Promise<boolean>
}

/**
 * Le statut est saisi a la main dans le Sheet, souvent sur mobile : la comparaison
 * doit tolerer la casse et les espaces de bord ("Repondu ", " IGNORE").
 */
function normaliserStatut(valeur: string): string {
  return normaliser(valeur).trim()
}

/** Bilan hebdomadaire : combien de prospects detectes, repondus, ignores, en attente. */
export async function executerWeekly(d: DepsWeekly): Promise<Stats> {
  const detectes = d.db.compterDepuis(new Date(Date.now() - SEPT_JOURS_MS))
  const statuts = await d.lireStatuts()

  let repondus = 0
  let ignores = 0
  let nouveaux = 0

  for (const s of statuts) {
    const v = normaliserStatut(s)
    if (v === 'repondu') repondus++
    else if (v === 'ignore') ignores++
    else if (v === 'nouveau') nouveaux++
  }

  const stats: Stats = { detectes, repondus, ignores, nouveaux }
  await d.notifier(formaterStats(stats))
  return stats
}
