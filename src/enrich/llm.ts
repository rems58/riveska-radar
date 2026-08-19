import type { z } from 'zod'
import { recupererJson } from '../collectors/http.ts'

export interface OptionsLlm<T> {
  cle: string
  modele: string
  systeme: string
  utilisateur: string
  schema: z.ZodType<T>
  /** Delai avant abandon, en ms. 60s par defaut ; parametrable pour les tests. */
  timeoutMs?: number
}

const TIMEOUT_DEFAUT_MS = 60_000
const URL_OPENROUTER = 'https://openrouter.ai/api/v1/chat/completions'

interface ReponseOpenRouter {
  choices?: Array<{ message?: { content?: string } }>
}

/** Les modeles encadrent souvent leur JSON de balises markdown : on les retire. */
function extraireJson(brut: string): string {
  const fence = brut.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence?.[1]) return fence[1].trim()
  return brut.trim()
}

/**
 * Appelle OpenRouter et valide la reponse contre un schema zod.
 * Renvoie null en cas d'echec reseau, de JSON invalide ou de schema non respecte :
 * un prospect manque vaut mieux qu'un plantage du radar.
 *
 * S'appuie sur recupererJson (couche http commune) pour le timeout, la limite de
 * taille et la journalisation reseau/HTTP ; ne rajoute que la logique specifique au
 * LLM (extraction du contenu, JSON encadre de markdown, validation zod).
 */
export async function appelerLlmJson<T>(o: OptionsLlm<T>): Promise<T | null> {
  const reponse = await recupererJson<ReponseOpenRouter>({
    source: 'llm',
    url: URL_OPENROUTER,
    timeoutMs: o.timeoutMs ?? TIMEOUT_DEFAUT_MS,
    init: {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${o.cle}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: o.modele,
        temperature: 0.2,
        messages: [
          { role: 'system', content: o.systeme },
          { role: 'user', content: o.utilisateur },
        ],
      }),
    },
  })

  if (reponse === null) return null

  const contenu = reponse.choices?.[0]?.message?.content
  if (typeof contenu !== 'string') {
    console.warn('[radar] llm : reponse OpenRouter sans contenu exploitable (choices[0].message.content absent)')
    return null
  }

  let parse: unknown
  try {
    parse = JSON.parse(extraireJson(contenu))
  } catch (err) {
    const raison = err instanceof Error ? err.message : String(err)
    console.warn(`[radar] llm : contenu du modele non-JSON (${raison})`)
    return null
  }

  const resultat = o.schema.safeParse(parse)
  if (!resultat.success) {
    const raison = resultat.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    console.warn(`[radar] llm : reponse hors schema attendu (${raison})`)
    return null
  }

  return resultat.data
}
