import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'

/**
 * Verrou de process base fichier : evite que deux executions de la meme commande
 * (radar toutes les 15 minutes, notamment) tournent en meme temps. Sans lui, deux
 * process voient les memes posts comme "non vus" (marquerVu n'intervient qu'apres
 * scoring + enrichissement + ecriture Sheet) : double facturation LLM et ligne
 * dupliquee dans le Sheet.
 *
 * Le fichier contient le PID et l'horodatage de pose. Un verrou est perime (donc
 * ignorable par un nouvel appelant) si :
 *  - son age depasse dureeMaxMs (garde-fou si le PID a ete recycle par l'OS pour
 *    un tout autre process apres un crash du run precedent), ou
 *  - le process qui l'a pose n'existe plus (crash, machine redemarree) - c'est le
 *    cas normal qui evite qu'un verrou jamais libere bloque le radar pour de bon.
 */

interface ContenuVerrou {
  pid: number
  horodatage: number
}

function lire(cheminVerrou: string): ContenuVerrou | null {
  try {
    const brut: unknown = JSON.parse(readFileSync(cheminVerrou, 'utf8'))
    if (
      typeof brut === 'object' &&
      brut !== null &&
      typeof (brut as ContenuVerrou).pid === 'number' &&
      typeof (brut as ContenuVerrou).horodatage === 'number'
    ) {
      return brut as ContenuVerrou
    }
    return null
  } catch {
    // Fichier illisible ou JSON corrompu : traite comme un verrou perime, jamais
    // comme un blocage permanent.
    return null
  }
}

/**
 * process.kill(pid, 0) n'envoie aucun signal : il verifie juste que le process
 * existe. Fonctionne aussi sous Windows (Node l'implemente via OpenProcess).
 */
function processVivant(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Un verrou est actif si son fichier existe, decrit un process encore vivant, et n'a pas depasse dureeMaxMs. */
export function verrouActif(cheminVerrou: string, dureeMaxMs: number): boolean {
  if (!existsSync(cheminVerrou)) return false
  const contenu = lire(cheminVerrou)
  if (!contenu) return false
  if (Date.now() - contenu.horodatage > dureeMaxMs) return false
  return processVivant(contenu.pid)
}

/**
 * Cree le fichier de verrou en mode exclusif ('wx') : si le fichier existe deja,
 * l'ecriture echoue avec EEXIST au lieu de l'ecraser. C'est l'OS qui arbitre, donc
 * un seul process peut gagner meme si plusieurs arrivent au meme instant.
 */
function tenterCreation(cheminVerrou: string): boolean {
  try {
    writeFileSync(
      cheminVerrou,
      JSON.stringify({ pid: process.pid, horodatage: Date.now() } satisfies ContenuVerrou),
      { flag: 'wx' },
    )
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') return false
    throw err
  }
}

/**
 * Tente de poser le verrou. Renvoie false (sans rien ecrire) si un run est deja en
 * cours. A appeler juste avant de lancer un job, puis toujours liberer avec
 * libererVerrou en fin d'execution (y compris en cas d'echec - finally cote appelant).
 *
 * L'acquisition passe par une creation exclusive et NON par "verrouActif() puis
 * ecriture" : ce dernier enchainement laisse une fenetre entre le test et l'ecriture
 * pendant laquelle deux process peuvent tous les deux se croire seuls. Mesure faite
 * avec deux process lances simultanement : les deux acquerraient le verrou 4 fois
 * sur 5, ce qui annule completement la protection recherchee.
 */
export function acquerirVerrou(cheminVerrou: string, dureeMaxMs: number): boolean {
  if (tenterCreation(cheminVerrou)) return true

  // Le fichier existe : soit un run est vraiment en cours, soit c'est un residu
  // (crash, machine redemarree, JSON corrompu).
  if (verrouActif(cheminVerrou, dureeMaxMs)) return false

  // Verrou perime : on le retire et on retente une seule fois. Si un autre process
  // fait le meme nettoyage au meme moment, la creation exclusive departage.
  libererVerrou(cheminVerrou)
  return tenterCreation(cheminVerrou)
}

/** Ne leve jamais : liberer un verrou deja absent (double appel, nettoyage manuel) est sans consequence. */
export function libererVerrou(cheminVerrou: string): void {
  try {
    unlinkSync(cheminVerrou)
  } catch {
    // Deja absent : rien a faire.
  }
}
