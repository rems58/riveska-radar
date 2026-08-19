import type { RawPost } from '../types.ts'
import { recupererJson, versAuteur, dateValideOuNull } from './http.ts'

/** Requetes lancees sur l'endpoint searchPosts de Bluesky. */
const REQUETES = [
  'app store rejected',
  'app rejected apple',
  'publish app store help',
]

/**
 * BLUESKY_ID / BLUESKY_APP_PASSWORD, facultatifs (voir README > "Ou obtenir chaque
 * identifiant"). appPassword est un mot de passe d'application (genere depuis les
 * reglages Bluesky), jamais le mot de passe du compte.
 */
export interface OptionsBluesky {
  id?: string
  appPassword?: string
}

interface ReponseSession {
  accessJwt?: unknown
}

/**
 * Ouvre une session authentifiee via un mot de passe d'application. Necessaire
 * depuis que la recherche non authentifiee est fermee (public.api.bsky.app renvoie
 * 403 sur searchPosts, verifie en appel reel le 2026-08-19) - bsky.social reste
 * accessible mais exige un token de session pour cet endpoint.
 * Renvoie null (et journalise) en cas d'identifiants invalides ou de panne : ne leve jamais.
 */
async function ouvrirSession(id: string, appPassword: string): Promise<string | null> {
  const j = await recupererJson<ReponseSession>({
    source: 'bluesky-session',
    url: 'https://bsky.social/xrpc/com.atproto.server.createSession',
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identifier: id, password: appPassword }),
    },
  })
  return typeof j?.accessJwt === 'string' ? j.accessJwt : null
}

/** Extrait le rkey (dernier segment) d'un URI AT Protocol. Vide/absent => null. */
function extraireRkey(uri: string): string | null {
  const segments = uri.split('/')
  const dernier = segments[segments.length - 1]
  return dernier && dernier.length > 0 ? dernier : null
}

/** Extrait le DID (identifiant de repository) d'un URI AT Protocol du type at://<did>/... */
function extraireDid(uri: string): string | null {
  const m = /^at:\/\/([^/]+)\//.exec(uri)
  return m?.[1] ?? null
}

/**
 * Construit un RawPost a partir d'un post brut renvoye par searchPosts.
 * Le handle est prefere pour l'URL de profil ; a defaut (compte supprime/modere,
 * author: null) on retombe sur le DID toujours present dans l'URI, pour ne jamais
 * produire un lien casse. L'auteur affiche reste "inconnu" si le handle manque.
 * Renvoie null (et journalise) si le post n'a ni rkey exploitable ni aucun
 * identifiant (uri malformee), ou si la date est invalide.
 */
function posteDepuisPost(brut: unknown): RawPost | null {
  if (typeof brut !== 'object' || brut === null) return null
  const p = brut as Record<string, unknown>

  if (typeof p.uri !== 'string') return null
  const rkey = extraireRkey(p.uri)
  if (!rkey) {
    console.warn(`[radar] bluesky : uri sans rkey exploitable (${p.uri})`)
    return null
  }

  const author = typeof p.author === 'object' && p.author !== null ? (p.author as Record<string, unknown>) : undefined
  const handle = typeof author?.handle === 'string' && author.handle.length > 0 ? author.handle : null
  const did = extraireDid(p.uri)
  const identifiant = handle ?? did
  if (!identifiant) {
    console.warn(`[radar] bluesky : post ${rkey} ignore (aucun identifiant d auteur exploitable)`)
    return null
  }

  const record = typeof p.record === 'object' && p.record !== null ? (p.record as Record<string, unknown>) : undefined
  const texte = typeof record?.text === 'string' ? record.text : ''

  const publieLe = dateValideOuNull(new Date(typeof record?.createdAt === 'string' ? record.createdAt : NaN))
  if (!publieLe) {
    console.warn(`[radar] bluesky : post ${rkey} ignore (date invalide ou absente)`)
    return null
  }

  return {
    id: `bluesky:${rkey}`,
    source: 'bluesky',
    url: `https://bsky.app/profile/${identifiant}/post/${rkey}`,
    auteur: versAuteur(handle),
    titre: texte.slice(0, 120),
    contenu: texte,
    publieLe,
  }
}

/**
 * Interroge app.bsky.feed.searchPosts via une session authentifiee. Sans
 * BLUESKY_ID/BLUESKY_APP_PASSWORD, la source se desactive proprement (log
 * explicite, tableau vide) plutot que d'echouer a chaque run.
 * Toute panne unitaire est avalee : une requete en echec ne casse pas la collecte,
 * et un post individuel malforme (auteur null, uri sans rkey) n'entraine jamais
 * la perte des autres posts de la meme reponse.
 */
export async function collecterBluesky(o: OptionsBluesky = {}): Promise<RawPost[]> {
  if (!o.id || !o.appPassword) {
    console.warn(
      '[radar] bluesky : BLUESKY_ID/BLUESKY_APP_PASSWORD absents - source desactivee ' +
        '(recherche Bluesky non authentifiee fermee depuis 2026, voir README).',
    )
    return []
  }

  const accessJwt = await ouvrirSession(o.id, o.appPassword)
  if (!accessJwt) {
    console.warn('[radar] bluesky : authentification echouee (identifiants invalides ou service indisponible)')
    return []
  }

  const vus = new Set<string>()
  const posts: RawPost[] = []

  for (const q of REQUETES) {
    const url = `https://bsky.social/xrpc/app.bsky.feed.searchPosts?q=${encodeURIComponent(q)}&limit=25`
    const j = await recupererJson<{ posts?: unknown }>({
      source: 'bluesky',
      url,
      init: { headers: { Authorization: `Bearer ${accessJwt}` } },
    })
    if (!Array.isArray(j?.posts)) continue

    for (const brut of j.posts) {
      const post = posteDepuisPost(brut)
      if (!post) continue
      if (vus.has(post.id)) continue
      vus.add(post.id)
      posts.push(post)
    }
  }
  return posts
}
