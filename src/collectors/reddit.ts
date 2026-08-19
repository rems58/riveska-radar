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

/** Facultatifs (voir README > "Ou obtenir chaque identifiant") : Reddit a ferme la creation
 *  d'applications en libre-service (Responsible Builder Policy), la source se desactive
 *  proprement sans ces trois valeurs plutot que d'echouer a chaque run. */
export interface OptionsReddit {
  clientId?: string
  clientSecret?: string
  userAgent?: string
}

interface ReponseChildren {
  data?: { children?: unknown }
}

/** Identifiants confirmes presents (post-garde dans collecterReddit). */
interface IdentifiantsReddit {
  clientId: string
  clientSecret: string
  userAgent: string
}

/**
 * Recupere un token OAuth client_credentials.
 * S'appuie sur recupererJson : une panne (reseau, timeout, statut) renvoie null
 * et est deja journalisee, jamais levee.
 */
async function obtenirToken(o: IdentifiantsReddit): Promise<string | null> {
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
 * Sans les trois identifiants, la source se desactive proprement (log explicite,
 * tableau vide) : Reddit a ferme la creation d'applications en libre-service
 * (Responsible Builder Policy, verifie le 2026-08-19 - /prefs/apps refuse la
 * creation, /new.json et /search.json renvoient 403 meme avec un user-agent de
 * navigateur ; seul access_token repond encore mais exige des cles desormais
 * inobtenables sans approbation ecrite explicite pour un usage commercial).
 * Toute panne unitaire est avalee : un subreddit indisponible ne doit pas casser la collecte.
 */
export async function collecterReddit(o: OptionsReddit = {}): Promise<RawPost[]> {
  if (!o.clientId || !o.clientSecret || !o.userAgent) {
    console.warn(
      '[radar] reddit : REDDIT_CLIENT_ID/REDDIT_CLIENT_SECRET/REDDIT_USER_AGENT absents - source ' +
        'desactivee (API fermee en libre-service depuis la Responsible Builder Policy de Reddit, ' +
        'approbation ecrite necessaire pour un usage commercial - voir README).',
    )
    return []
  }
  const identifiants: IdentifiantsReddit = { clientId: o.clientId, clientSecret: o.clientSecret, userAgent: o.userAgent }

  const token = await obtenirToken(identifiants)
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
        init: { headers: { Authorization: `Bearer ${token}`, 'User-Agent': identifiants.userAgent } },
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
