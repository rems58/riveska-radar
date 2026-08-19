import type { EnrichedPost } from '../types.ts'

const TIMEOUT_MS = 15_000
/** Limite dure de l'API Telegram : au-dela, sendMessage est rejete et la notif est perdue. */
const LIMITE_TEXTE = 4096

export interface OptionsTelegram {
  token: string
  chatId: string
}

/**
 * Message court : le detail complet est dans le Sheet.
 * ligne === null signifie que l'ecriture dans le Sheet a echoue (pas juste "pas de
 * numero precis") : il ne faut jamais affirmer un succes qui n'a pas eu lieu, sous
 * peine d'alerter l'humain sur un prospect qui n'existe nulle part. Avec le pipeline
 * radar.ts actuel, ce cas ne notifie plus du tout (echec technique => pas d'appel a
 * notifier), mais cette fonction reste honnete par elle-meme pour tout appelant.
 */
export function formaterProspect(p: EnrichedPost, ligne: number | null): string {
  const ref =
    ligne !== null
      ? `\nBrouillon pret -> ligne ${ligne}`
      : "\nEchec d'ecriture dans le Sheet - le prospect sera retente au prochain run"
  return (
    `Nouveau prospect - score ${p.score}\n` +
    `${p.source} - ${p.langue.toUpperCase()}\n` +
    `${p.probleme}\n` +
    `${p.url}` +
    ref
  )
}

/**
 * Masque le token avant tout log. Le token est dans l'URL (/bot<TOKEN>/sendMessage),
 * pas dans un en-tete : un log naif de l'URL le ferait fuiter en clair.
 */
function masquerToken(url: string): string {
  return url.replace(/\/bot[^/]+\//, '/bot***/')
}

/**
 * Poste une notification sur l'API Telegram. Ne leve jamais : une panne
 * (reseau, timeout, statut HTTP) est journalisee (token masque) puis renvoie false.
 */
export async function envoyerTelegram(texte: string, o: OptionsTelegram): Promise<boolean> {
  const url = `https://api.telegram.org/bot${o.token}/sendMessage`
  const texteTronque = texte.length > LIMITE_TEXTE ? texte.slice(0, LIMITE_TEXTE) : texte

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: o.chatId,
        text: texteTronque,
        disable_web_page_preview: true,
      }),
      signal: controller.signal,
    })

    if (!r.ok) {
      console.warn(`[radar] telegram : reponse HTTP ${r.status} pour ${masquerToken(url)}`)
      return false
    }
    return true
  } catch (err) {
    const raison = err instanceof Error ? err.message : String(err)
    console.warn(`[radar] telegram : echec de requete vers ${masquerToken(url)} (${raison})`)
    return false
  } finally {
    // Sans ce nettoyage le timer peut maintenir le process eveille meme apres reponse.
    clearTimeout(timer)
  }
}
