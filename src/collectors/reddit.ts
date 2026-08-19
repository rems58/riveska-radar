import type { RawPost } from '../types.ts'

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

interface RedditChild {
  data: {
    id: string
    author: string
    title: string
    selftext: string
    permalink: string
    created_utc: number
  }
}

/**
 * Recupere un token OAuth client_credentials.
 * Toute panne (reseau ou refus) doit renvoyer null, jamais lever.
 */
async function obtenirToken(o: OptionsReddit): Promise<string | null> {
  try {
    const creds = Buffer.from(`${o.clientId}:${o.clientSecret}`).toString('base64')
    const r = await fetch('https://www.reddit.com/api/v1/access_token', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${creds}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': o.userAgent,
      },
      body: 'grant_type=client_credentials',
    })
    if (!r.ok) return null
    const j = (await r.json()) as { access_token?: string }
    return j.access_token ?? null
  } catch {
    // Reseau injoignable ou reponse invalide : pas de token, on abandonne proprement.
    return null
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
      try {
        const r = await fetch(url, {
          headers: { Authorization: `Bearer ${token}`, 'User-Agent': o.userAgent },
        })
        if (!r.ok) continue
        const j = (await r.json()) as { data?: { children?: RedditChild[] } }
        for (const c of j.data?.children ?? []) {
          const id = `reddit:${c.data.id}`
          if (vus.has(id)) continue
          vus.add(id)
          posts.push({
            id,
            source: 'reddit',
            url: `https://reddit.com${c.data.permalink}`,
            auteur: c.data.author,
            titre: c.data.title,
            contenu: c.data.selftext ?? '',
            publieLe: new Date(c.data.created_utc * 1000),
          })
        }
      } catch {
        // Subreddit injoignable : on continue avec les suivants.
      }
    }
  }
  return posts
}
