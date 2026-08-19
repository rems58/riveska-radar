import type { RawPost } from '../types.ts'
import { REGEX_SIGNAUX, REGEX_ANTI_SIGNAUX, normaliser } from './keywords.ts'

/**
 * Filtre gratuit applique avant tout appel LLM.
 * Objectif : ramener plusieurs centaines de posts/jour a quelques dizaines de candidats,
 * pour ne depenser des tokens que sur ce qui a une chance d'etre un prospect.
 */
export function prefiltrer(posts: RawPost[], ageMaxJours: number): RawPost[] {
  const limite = Date.now() - ageMaxJours * 24 * 3600 * 1000
  return posts.filter((p) => {
    if (p.publieLe.getTime() < limite) return false
    const texte = normaliser(`${p.titre} ${p.contenu}`)
    // La majorite des posts n'a aucun signal : on le cherche d'abord pour eviter
    // de scanner les anti-signaux sur des posts qui seront de toute facon rejetes.
    const aUnSignal = REGEX_SIGNAUX.some((r) => r.test(texte))
    if (!aUnSignal) return false
    return !REGEX_ANTI_SIGNAUX.some((r) => r.test(texte))
  })
}
