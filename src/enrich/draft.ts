import { z } from 'zod'
import type { ScoredPost, EnrichedPost } from '../types.ts'
import { appelerLlmJson, DEBUT_CONTENU_TIERS, FIN_CONTENU_TIERS, CONSIGNE_CONTENU_TIERS } from './llm.ts'

const schema = z.object({
  // Le post est tronque a 2000 caracteres avant envoi ; une traduction fidele
  // ne devrait jamais depasser tres largement cette taille.
  traductionFr: z.string().max(3000),
  // Le prompt vise 120 mots (~1200 caracteres avec marge). Une reponse plus
  // longue est rejetee : mieux vaut un prospect ignore qu'une cellule Sheet
  // qui fait echouer l'ecriture de toute la ligne (limite Sheets = 50000).
  brouillon: z.string().min(1).max(1200),
})

const SYSTEME = `Tu prepares un brouillon de reponse publique pour Remy, qui edite Riveska
(publication d'applications mobiles sur l'App Store et Google Play pour le compte de ses clients).

Regles du brouillon :
- Ecris dans la langue du post d'origine.
- Commence par repondre concretement au probleme, avec une piste utile et precise. C'est le coeur.
- Ne mentionne Riveska qu'a la fin, en une phrase, sans lien commercial agressif.
- Ton : un developpeur qui aide un autre developpeur. Jamais commercial, jamais generique.
- Pas d'emoji, pas de formule creuse, pas de "j'espere que ca aide".
- 120 mots maximum.
- Ce brouillon sera relu et reecrit par un humain avant envoi : vise le fond, pas la forme.

Champ traductionFr : traduction francaise fidele du post d'origine.
Si le post est deja en francais, renvoie une chaine vide.

Reponds UNIQUEMENT par un objet JSON :
{"traductionFr": "<traduction ou chaine vide>", "brouillon": "<reponse>"}

${CONSIGNE_CONTENU_TIERS}`

const CONTENU_MAX = 2000
// Chaque caractere envoye au LLM est facture ; le titre n'apporte rien au-dela.
const TITRE_MAX = 300

export interface OptionsDraft {
  cle: string
  modele: string
}

/**
 * Traduit un post note et prepare un brouillon de reponse contextualise.
 * Renvoie null si le LLM echoue : le post reste note mais non enrichi, il est ignore
 * plutot que de faire planter le radar.
 */
export async function enrichirPost(post: ScoredPost, o: OptionsDraft): Promise<EnrichedPost | null> {
  const utilisateur = `Langue detectee: ${post.langue}
Probleme: ${post.probleme}
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

  return {
    ...post,
    traductionFr: resultat.traductionFr,
    brouillon: resultat.brouillon,
  }
}
