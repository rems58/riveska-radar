import { z } from 'zod'
import type { RawPost, ScoredPost } from '../types.ts'
import { appelerLlmJson, DEBUT_CONTENU_TIERS, FIN_CONTENU_TIERS, CONSIGNE_CONTENU_TIERS } from './llm.ts'

/**
 * Plafond applique par TRONCATURE et non par rejet. Mesure en run reel : le modele
 * depasse regulierement la limite de quelques caracteres ("Too big: expected string
 * to have <=200 characters"). Rejeter faisait passer le post pour une panne technique,
 * donc reessayer 3 fois un echec deterministe (6 appels LLM factures) avant de perdre
 * definitivement le prospect. La borne existe pour proteger Google Sheets, pas pour
 * disqualifier un prospect dont le resume est trop bavard.
 */
const plafonner = (max: number, minimum = 0) =>
  z
    .string()
    .min(minimum)
    .transform((s) => (s.length > max ? s.slice(0, max - 1) + '…' : s))

const schema = z.object({
  score: z.number().min(0).max(100),
  langue: z.enum(['fr', 'en', 'es', 'it', 'de']),
  probleme: plafonner(200, 1),
})

const SYSTEME = `Tu qualifies des prospects pour Riveska, un service qui publie les applications
mobiles de ses clients sur l'App Store et Google Play a leur place (comptes developpeur du client,
gestion des rejets, panel de testeurs, maintien des certificats).

Note de 0 a 100 la probabilite que l'auteur du post soit un prospect :
- 90-100 : bloque maintenant sur une publication ou un rejet, cherche de l'aide
- 70-89  : galere avec les stores, exprime de la frustration
- 40-69  : sujet connexe mais pas de blocage clair
- 0-39   : hors sujet, ou c'est un professionnel qui propose ce service

Le champ langue doit valoir exactement l'un de : fr, en, es, it, de.
Si le post est redige dans une autre langue, renvoie un score de 0 : Riveska ne repond que
dans ces cinq langues, un prospect non joignable n'a pas de valeur.

Reponds UNIQUEMENT par un objet JSON :
{"score": <0-100>, "langue": "<fr|en|es|it|de>", "probleme": "<resume en une phrase, en francais>"}

${CONSIGNE_CONTENU_TIERS}`

const CONTENU_MAX = 2000
// Chaque caractere envoye au LLM est facture ; le titre n'apporte rien au-dela.
const TITRE_MAX = 300

export interface OptionsScore {
  cle: string
  modele: string
  /** Nombre de fois que cet auteur a deja ete detecte. */
  apparitionsPrecedentes?: number
}

/**
 * Note un post via le LLM.
 * Un auteur deja detecte auparavant n'a toujours pas resolu son probleme : son score double
 * (plafonne a 100), car c'est un prospect nettement plus chaud.
 */
export async function noterPost(post: RawPost, o: OptionsScore): Promise<ScoredPost | null> {
  const utilisateur = `Source: ${post.source}
${DEBUT_CONTENU_TIERS}
Titre: ${post.titre.slice(0, TITRE_MAX)}
Contenu: ${post.contenu.slice(0, CONTENU_MAX)}
${FIN_CONTENU_TIERS}`

  const resultat = await appelerLlmJson({
    cle: o.cle,
    modele: o.modele,
    systeme: SYSTEME,
    utilisateur,
    schema,
  })

  if (resultat === null) return null

  const apparitions = o.apparitionsPrecedentes ?? 0
  const score = apparitions > 0 ? Math.min(100, resultat.score * 2) : resultat.score

  return {
    ...post,
    score,
    langue: resultat.langue,
    probleme: resultat.probleme,
  }
}
