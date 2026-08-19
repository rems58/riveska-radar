import { describe, it, expect, vi, afterEach } from 'vitest'
import { z } from 'zod'
import { appelerLlmJson } from '../../src/enrich/llm.ts'

afterEach(() => vi.restoreAllMocks())

const schema = z.object({ score: z.number() })

function reponseOpenRouter(contenu: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content: contenu } }] }), { status: 200 })
}

describe('appelerLlmJson', () => {
  it('parse un JSON valide', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reponseOpenRouter('{"score": 82}')))
    const r = await appelerLlmJson({ cle: 'k', modele: 'm', systeme: 's', utilisateur: 'u', schema })
    expect(r).toEqual({ score: 82 })
  })

  it('parse un JSON entoure de balises markdown', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reponseOpenRouter('```json\n{"score": 70}\n```')))
    const r = await appelerLlmJson({ cle: 'k', modele: 'm', systeme: 's', utilisateur: 'u', schema })
    expect(r).toEqual({ score: 70 })
  })

  it('renvoie null si le JSON ne respecte pas le schema', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reponseOpenRouter('{"score": "haut"}')))
    const r = await appelerLlmJson({ cle: 'k', modele: 'm', systeme: 's', utilisateur: 'u', schema })
    expect(r).toBeNull()
  })

  it('renvoie null si l API echoue', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('err', { status: 500 })))
    const r = await appelerLlmJson({ cle: 'k', modele: 'm', systeme: 's', utilisateur: 'u', schema })
    expect(r).toBeNull()
  })

  it('rend la main via le timeout quand fetch ne repond jamais', async () => {
    const fetchMock = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'))
          })
        }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const debut = Date.now()
    const r = await appelerLlmJson({ cle: 'k', modele: 'm', systeme: 's', utilisateur: 'u', schema, timeoutMs: 30 })
    const duree = Date.now() - debut

    expect(r).toBeNull()
    expect(duree).toBeLessThan(2000)
  })

  it('renvoie null si le contenu du modele n est pas du JSON', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reponseOpenRouter('ceci n est pas du json')))
    const r = await appelerLlmJson({ cle: 'k', modele: 'm', systeme: 's', utilisateur: 'u', schema })
    expect(r).toBeNull()
  })

  it('renvoie null si la reponse OpenRouter n a pas de choices', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({}), { status: 200 })))
    const r = await appelerLlmJson({ cle: 'k', modele: 'm', systeme: 's', utilisateur: 'u', schema })
    expect(r).toBeNull()
  })

  it('ne journalise jamais la cle API', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('err', { status: 500 })))
    await appelerLlmJson({ cle: 'secret-tres-prive', modele: 'm', systeme: 's', utilisateur: 'u', schema })
    for (const call of warnSpy.mock.calls) {
      expect(String(call[0])).not.toContain('secret-tres-prive')
    }
  })

  it('parse un JSON precede de texte explicatif, sans balises markdown', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      reponseOpenRouter('Voici le JSON : {"score": 70, "langue": "en", "probleme": "x"}'),
    ))
    const r = await appelerLlmJson({ cle: 'k', modele: 'm', systeme: 's', utilisateur: 'u', schema })
    expect(r).toEqual({ score: 70 })
  })

  it('retient le bloc fence qui parse effectivement quand plusieurs sont presents', async () => {
    const contenu = '```json\n{ceci n est pas du json}\n```\ntexte intercalaire\n```json\n{"score": 65}\n```'
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reponseOpenRouter(contenu)))
    const r = await appelerLlmJson({ cle: 'k', modele: 'm', systeme: 's', utilisateur: 'u', schema })
    expect(r).toEqual({ score: 65 })
  })

  it('renvoie null et journalise si aucun JSON exploitable n est trouve', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(reponseOpenRouter('Je ne sais pas du tout quoi repondre ici.')))
    const r = await appelerLlmJson({ cle: 'k', modele: 'm', systeme: 's', utilisateur: 'u', schema })
    expect(r).toBeNull()
    expect(warnSpy).toHaveBeenCalled()
  })
})
