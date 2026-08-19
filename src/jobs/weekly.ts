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
  /**
   * Renvoie les statuts des lignes du Sheet dont date_detect est posterieure a
   * "depuis" (borne fournie par executerWeekly, filtrage a la charge de l'appelant
   * reel - Task 18 - qui lit la colonne date_detect, premiere colonne, ISO 8601).
   * Le filtrage cote appelant est essentiel : detectes et repondus/ignores/nouveaux
   * doivent porter sur EXACTEMENT la meme population, sinon le taux de reponse
   * compare deux ensembles differents et devient faux (cf. db.compterDepuis, qui
   * compte aussi les rejets/echecs/entrees trigger: jamais ecrits au Sheet - a ne
   * plus utiliser ici pour cette raison).
   */
  lireStatuts: (depuis: Date) => Promise<string[]>
  notifier: (texte: string) => Promise<boolean>
}

/**
 * Le statut est saisi a la main dans le Sheet, souvent sur mobile : la comparaison
 * doit tolerer la casse et les espaces de bord ("Repondu ", " IGNORE").
 */
function normaliserStatut(valeur: string): string {
  return normaliser(valeur).trim()
}

/**
 * Bilan hebdomadaire : combien de prospects detectes, repondus, ignores, en attente.
 * detectes = nombre de statuts recus pour la fenetre, PAS un comptage independant :
 * c'est ce qui garantit que le taux repondus/detectes compare la meme population.
 */
export async function executerWeekly(d: DepsWeekly): Promise<Stats> {
  const statuts = await d.lireStatuts(new Date(Date.now() - SEPT_JOURS_MS))

  let repondus = 0
  let ignores = 0
  let nouveaux = 0

  for (const s of statuts) {
    const v = normaliserStatut(s)
    if (v === 'repondu') repondus++
    else if (v === 'ignore') ignores++
    else if (v === 'nouveau') nouveaux++
  }

  const stats: Stats = { detectes: statuts.length, repondus, ignores, nouveaux }
  const notifie = await d.notifier(formaterStats(stats))
  if (!notifie) {
    // Pas de mecanisme de retry ici (contrairement a recheck.ts/triggers.ts) : le
    // bilan est deja calcule, rien a rejouer avant le prochain lundi. Le minimum est
    // de laisser une trace exploitable - avant ce fix, un Telegram rate ici passait
    // totalement inapercu, silencieusement, pendant 7 jours.
    console.warn('[radar] weekly : notification Telegram du bilan hebdomadaire echouee')
  }
  return stats
}
