import type { RawPost } from '../types.ts'
import { recupererJson, versAuteur, dateValideOuNull } from './http.ts'

/** Subreddits ou se trouvent les gens bloques sur une publication d'app. */
export const SUBREDDITS = [
  'reactnative', 'expo', 'iOSProgramming', 'androiddev', 'FlutterDev',
  'iosdev', 'AppDevelopers', 'nocode', 'SideProject', 'indiehackers',
]

/** Requetes lancees sur chaque subreddit. Reddit gere le OR nativement. */
const REQUETES = [
  'rejected OR rejection',
  'publish OR publishing',
  'testers OR "closed testing"',
  '"app store" help',
]

export interface OptionsReddit {
  clientId: string
  clientSecret: string
  userAgent: string
}

interface ReponseChildren {
  data?: { children?: unknown }
}

/**
 * Recupere un token OAuth client_credentials.
 * S'appuie sur recupererJson : une panne (reseau, timeout, statut) renvoie null
 * et est deja journalisee, jamais levee.
 */
async function obtenirToken(o: OptionsReddit): Promise<string | null> {
  const creds = Buffer.from(`${o.clientId}:${o.clientSecret}`).toString('base64')
  const j = await recupererJson<{ access_token?: unknown }>({
    source: 'reddit-token',
    url: 'https://www.reddit.com/api/v1/access_token',
    init: {
      method: 'POST',
      headers: {
        Authorization: `Basic ${creds}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': o.userAgent,
      },
      body: 'grant_type=client_credentials',
    },
  })
  return typeof j?.access_token === 'string' ? j.access_token : null
}

/**
 * Construit un RawPost a partir d'un "child" brut renvoye par l'API Reddit.
 * Renvoie null (et journalise) si un champ indispensable manque ou est invalide,
 * plutot que de laisser un auteur null ou une Invalid Date s'infiltrer.
 */
function posteDepuisChild(brut: unknown): RawPost | null {
  if (typeof brut !== 'object' || brut === null) return null
  const data = (brut as { data?: unknown }).data
  if (typeof data !== 'object' || data === null) return null
  const d = data as Record<string, unknown>

  if (typeof d.id !== 'string' || typeof d.permalink !== 'string') return null

  const publieLe = dateValideOuNull(new Date(Number(d.created_utc) * 1000))
  if (!publieLe) {
    console.warn(`[radar] reddit : post ${d.id} ignore (date invalide ou absente)`)
    return null
  }

  return {
    id: `reddit:${d.id}`,
    source: 'reddit',
    url: `https://reddit.com${d.permalink}`,
    auteur: versAuteur(d.author),
    titre: typeof d.title === 'string' ? d.title : '',
    contenu: typeof d.selftext === 'string' ? d.selftext : '',
    publieLe,
  }
}

/**
 * Interroge l'API officielle Reddit (OAuth client_credentials).
 * Toute panne unitaire est avalee : un subreddit indisponible ne doit pas casser la collecte.
 */
export async function collecterReddit(o: OptionsReddit): Promise<RawPost[]> {
  const token = await obtenirToken(o)
  if (!token) return []

  const vus = new Set<string>()
  const posts: RawPost[] = []

  for (const sub of SUBREDDITS) {
    for (const q of REQUETES) {
      const url =
        `https://oauth.reddit.com/r/${sub}/search` +
        `?q=${encodeURIComponent(q)}&restrict_sr=1&sort=new&limit=25&t=month`

      const j = await recupererJson<ReponseChildren>({
        source: `reddit:${sub}`,
        url,
        init: { headers: { Authorization: `Bearer ${token}`, 'User-Agent': o.userAgent } },
      })
      const children = j?.data?.children
      if (!Array.isArray(children)) continue

      for (const c of children) {
        const post = posteDepuisChild(c)
        if (!post) continue
        if (vus.has(post.id)) continue
        vus.add(post.id)
        posts.push(post)
      }
    }
  }
  return posts
}
