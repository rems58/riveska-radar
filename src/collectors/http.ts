/**
 * Couche commune aux 6 collecteurs : le seul endroit qui parle a fetch().
 * Garantit trois choses qu'aucun appel individuel ne doit re-implementer :
 *  - un timeout (un socket qui pend ne doit jamais bloquer la collecte),
 *  - une taille de reponse bornee (un flux compromis/rediriger ne doit pas
 *    saturer la memoire ni etre passe en entier dans des regex),
 *  - une journalisation exploitable (source + url + raison) sur tout echec,
 *    seul moyen de diagnostiquer une source morte sans surveillance humaine.
 * Contrat : ne leve jamais. Toute panne renvoie null.
 */

const TIMEOUT_DEFAUT_MS = 15_000
const TAILLE_MAX_OCTETS = 5 * 1024 * 1024

export interface OptionsRequete {
  /** Nom de la source, pour les logs (ex: 'reddit', 'reddit-token'). */
  source: string
  url: string
  init?: RequestInit
  /** Delai avant abandon, en ms. 15s par defaut ; parametrable pour les tests. */
  timeoutMs?: number
}

export interface ReponseTexte {
  texte: string | null
  /** Code HTTP recu, ou null si la requete n'a jamais abouti (timeout, DNS, reseau...). */
  statut: number | null
}

/**
 * Version bas niveau de recupererTexte qui expose aussi le code HTTP recu, pour les
 * appelants qui doivent reagir differemment selon le statut (ex: reddit-rss.ts, qui
 * retente une fois specifiquement sur 429 - un rate-limit n'appelle pas la meme
 * reponse qu'un 404 ou une panne reseau). Ne leve jamais, memes garanties que
 * recupererTexte (timeout, taille bornee, journalisation).
 */
async function recupererTexteAvecStatutInterne(o: OptionsRequete): Promise<ReponseTexte> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? TIMEOUT_DEFAUT_MS)
  try {
    const r = await fetch(o.url, { ...o.init, signal: controller.signal })

    if (!r.ok) {
      console.warn(`[radar] ${o.source} : reponse HTTP ${r.status} pour ${o.url}`)
      return { texte: null, statut: r.status }
    }

    const longueurAnnoncee = r.headers.get('content-length')
    if (longueurAnnoncee && Number(longueurAnnoncee) > TAILLE_MAX_OCTETS) {
      console.warn(
        `[radar] ${o.source} : reponse trop volumineuse (${longueurAnnoncee} octets annonces) pour ${o.url}`,
      )
      return { texte: null, statut: r.status }
    }

    const texte = await r.text()
    const octetsLus = Buffer.byteLength(texte, 'utf8')
    if (octetsLus > TAILLE_MAX_OCTETS) {
      console.warn(`[radar] ${o.source} : reponse trop volumineuse (${octetsLus} octets lus) pour ${o.url}`)
      return { texte: null, statut: r.status }
    }

    return { texte, statut: r.status }
  } catch (err) {
    const raison = err instanceof Error ? err.message : String(err)
    console.warn(`[radar] ${o.source} : echec de requete vers ${o.url} (${raison})`)
    return { texte: null, statut: null }
  } finally {
    // Sans ce nettoyage le timer peut maintenir le process eveille meme apres reponse.
    clearTimeout(timer)
  }
}

/**
 * Recupere le corps texte d'une URL, avec timeout et limite de taille.
 * Ne leve jamais : une panne (reseau, timeout, taille, statut HTTP) est journalisee
 * puis renvoie null. C'est la fonction de bas niveau ; recupererJson s'appuie dessus.
 */
export async function recupererTexte(o: OptionsRequete): Promise<string | null> {
  return (await recupererTexteAvecStatutInterne(o)).texte
}

/**
 * Comme recupererTexte, mais renvoie aussi le code HTTP recu (voir ReponseTexte).
 * Reservee aux appelants qui ont besoin de distinguer les codes d'echec (ex: 429
 * "reessayer plus tard" vs 404 "n'existera jamais") - la plupart des collecteurs
 * n'en ont pas besoin et utilisent recupererTexte/recupererJson.
 */
export async function recupererTexteAvecStatut(o: OptionsRequete): Promise<ReponseTexte> {
  return recupererTexteAvecStatutInterne(o)
}

/** Comme recupererTexte, mais parse le resultat en JSON. Ne leve jamais. */
export async function recupererJson<T>(o: OptionsRequete): Promise<T | null> {
  const texte = await recupererTexte(o)
  if (texte === null) return null
  try {
    return JSON.parse(texte) as T
  } catch (err) {
    const raison = err instanceof Error ? err.message : String(err)
    console.warn(`[radar] ${o.source} : reponse JSON invalide pour ${o.url} (${raison})`)
    return null
  }
}

/**
 * Decode les entites HTML minimales presentes dans les reponses d'API (titres SO, flux RSS).
 * &amp; doit etre decode EN DERNIER : sinon un texte double-echappe ("&amp;lt;code&amp;gt;",
 * qui doit rester litteral) se ferait re-interpreter en une vraie balise ("<code>").
 */
export function decoderEntitesHtml(texte: string): string {
  return texte
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * Normalise un champ auteur potentiellement absent/null/non-string, renvoye par
 * toutes les API (Reddit renvoie `null` pour les comptes suspendus, par exemple).
 */
export function versAuteur(valeur: unknown): string {
  return typeof valeur === 'string' && valeur.length > 0 ? valeur : 'inconnu'
}

/**
 * Reduit un fragment HTML (statut Mastodon, corps de question StackOverflow) en
 * texte brut lisible. Volontairement simple (regex, pas de parseur DOM) : suffisant
 * pour nourrir le prefiltre mots-cles et le LLM, qui n'ont besoin ni de mise en
 * forme ni de structure. Partagee entre plusieurs collecteurs pour eviter de
 * dupliquer cette logique (et sa correction) a chaque source qui renvoie du HTML.
 */
export function retirerHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/p>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Renvoie la date si elle est valide, sinon null. Empeche une Invalid Date de
 * s'infiltrer silencieusement dans le pipeline (filtre, Sheet).
 */
export function dateValideOuNull(date: Date): Date | null {
  return Number.isNaN(date.getTime()) ? null : date
}
