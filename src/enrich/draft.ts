import { z } from 'zod'
import type { ScoredPost, EnrichedPost } from '../types.ts'
import { appelerLlmJson } from './llm.ts'

const schema = z.object({
  traductionFr: z.string(),
  brouillon: z.string().min(1),
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
{"traductionFr": "<traduction ou chaine vide>", "brouillon": "<reponse>"}`

const CONTENU_MAX = 2000

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
Titre: ${post.titre}
Contenu: ${post.contenu.slice(0, CONTENU_MAX)}`

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
