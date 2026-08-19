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

  // Verrou perime : on le retire et on retente une seule fois. Suppression SANS
  // verification de pid (contrairement a libererVerrou) : on vient justement de
  // constater via verrouActif() que ce verrou appartient a un process mort ou trop
  // vieux, donc PAS le notre par definition - la verification d'appartenance de
  // libererVerrou (Fix 6) bloquerait ce nettoyage legitime a tort. Si un autre
  // process fait le meme nettoyage au meme moment, la creation exclusive departage.
  try {
    unlinkSync(cheminVerrou)
  } catch {
    // Deja absent (l'autre process a gagne la course du nettoyage) : tenterCreation va trancher.
  }
  return tenterCreation(cheminVerrou)
}

/**
 * Reecrit l'horodatage du verrou (meme pid) pendant qu'un run est en cours, pour
 * qu'il ne paraisse jamais perime tant que le process qui le detient tourne encore.
 * Sans cela, un run legitimement plus long que dureeMaxMs (mesure : OpenRouter lent
 * -> 2 appels x 60s de timeout x 20 candidats = 40 min, largement au-dela des 20 min
 * de DUREE_MAX_VERROU_MS) se ferait voler son verrou par un nouveau run qui le juge
 * perime, alors qu'il tourne toujours - exactement le chevauchement que le verrou
 * doit empecher. A appeler periodiquement (setInterval) depuis l'appelant, avec un
 * intervalle nettement plus court que dureeMaxMs.
 */
export function rafraichirVerrou(cheminVerrou: string): void {
  try {
    writeFileSync(cheminVerrou, JSON.stringify({ pid: process.pid, horodatage: Date.now() } satisfies ContenuVerrou))
  } catch (err) {
    // Rafraichissement rate (ex: dossier temporairement inaccessible) : pas fatal,
    // le prochain tick reessaiera. Ne jamais faire planter le run pour ca.
    console.warn(`[radar] verrou : echec de rafraichissement de ${cheminVerrou} - ${err instanceof Error ? err.message : String(err)}`)
  }
}

/**
 * Ne leve jamais : liberer un verrou deja absent (double appel, nettoyage manuel)
 * est sans consequence.
 *
 * Verifie d'ABORD que le fichier nous appartient encore (meme pid) avant de le
 * supprimer. Sans cette verification : A acquiert, A tourne plus de dureeMaxMs (mais
 * tourne toujours), B le juge perime et l'acquiert a son tour (A et B tournent en
 * parallele - deja un probleme), PUIS A termine et supprime aveuglement le fichier -
 * qui est maintenant celui de B. Un troisieme process C peut alors l'acquerir alors
 * que B tourne encore. La verification de pid rend cette suppression sans effet
 * (elle refuse de supprimer un verrou qui ne nous appartient plus) : elle ne resout
 * pas a elle seule le premier chevauchement A/B (c'est rafraichirVerrou qui l'evite
 * en empechant le verrou de A de paraitre perime), mais elle empeche le deuxieme
 * chevauchement B/C, strictement pire puisqu'il se reproduirait a chaque cycle.
 */
export function libererVerrou(cheminVerrou: string): void {
  const contenu = lire(cheminVerrou)
  if (contenu && contenu.pid !== process.pid) {
    console.warn(
      `[radar] verrou : ${cheminVerrou} appartient desormais au pid ${contenu.pid} (pas le notre, ${process.pid}) ` +
        `- probablement repris apres avoir ete juge perime a tort. Je ne le supprime pas.`,
    )
    return
  }
  try {
    unlinkSync(cheminVerrou)
  } catch {
    // Deja absent : rien a faire.
  }
}
