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

/**
 * Recupere le corps texte d'une URL, avec timeout et limite de taille.
 * Ne leve jamais : une panne (reseau, timeout, taille, statut HTTP) est journalisee
 * puis renvoie null. C'est la fonction de bas niveau ; recupererJson s'appuie dessus.
 */
export async function recupererTexte(o: OptionsRequete): Promise<string | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? TIMEOUT_DEFAUT_MS)
  try {
    const r = await fetch(o.url, { ...o.init, signal: controller.signal })

    if (!r.ok) {
      console.warn(`[radar] ${o.source} : reponse HTTP ${r.status} pour ${o.url}`)
      return null
    }

    const longueurAnnoncee = r.headers.get('content-length')
    if (longueurAnnoncee && Number(longueurAnnoncee) > TAILLE_MAX_OCTETS) {
      console.warn(
        `[radar] ${o.source} : reponse trop volumineuse (${longueurAnnoncee} octets annonces) pour ${o.url}`,
      )
      return null
    }

    const texte = await r.text()
    const octetsLus = Buffer.byteLength(texte, 'utf8')
    if (octetsLus > TAILLE_MAX_OCTETS) {
      console.warn(`[radar] ${o.source} : reponse trop volumineuse (${octetsLus} octets lus) pour ${o.url}`)
      return null
    }

    return texte
  } catch (err) {
    const raison = err instanceof Error ? err.message : String(err)
    console.warn(`[radar] ${o.source} : echec de requete vers ${o.url} (${raison})`)
    return null
  } finally {
    // Sans ce nettoyage le timer peut maintenir le process eveille meme apres reponse.
    clearTimeout(timer)
  }
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
 * Renvoie la date si elle est valide, sinon null. Empeche une Invalid Date de
 * s'infiltrer silencieusement dans le pipeline (filtre, Sheet).
 */
export function dateValideOuNull(date: Date): Date | null {
  return Number.isNaN(date.getTime()) ? null : date
}
