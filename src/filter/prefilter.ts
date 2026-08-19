import type { RawPost } from '../types.ts'
import { SIGNAUX_DOULEUR, SIGNAUX_VIBECODE, ANTI_SIGNAUX, normaliser } from './keywords.ts'

const SIGNAUX = [...SIGNAUX_DOULEUR, ...SIGNAUX_VIBECODE]

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
    if (ANTI_SIGNAUX.some((a) => texte.includes(a))) return false
    return SIGNAUX.some((s) => texte.includes(s))
  })
}
