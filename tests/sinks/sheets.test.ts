import { describe, it, expect, vi } from 'vitest'
import { EN_TETES, versLigne, ajouterLignes, citerOnglet } from '../../src/sinks/sheets.ts'
import type { EnrichedPost } from '../../src/types.ts'

const post: EnrichedPost = {
  id: 'reddit:1', source: 'reddit', url: 'https://reddit.com/1', auteur: 'bob',
  titre: 'App rejected', contenu: 'guideline 4.2.6 and more text',
  publieLe: new Date('2026-08-01T10:00:00Z'),
  score: 88, langue: 'en', probleme: 'rejet 4.2.6',
  traductionFr: 'App rejetee', brouillon: 'Salut, ...',
}

describe('sheets', () => {
  it('definit les en-tetes attendus dans le bon ordre', () => {
    expect(EN_TETES).toEqual([
      'date_detect', 'source', 'lien', 'auteur', 'langue', 'extrait_orig',
      'traduction_fr', 'probleme', 'score', 'brouillon', 'statut', 'notes', 'reaction',
    ])
  })

  it('produit une ligne alignee sur les en-tetes', () => {
    const l = versLigne(post)
    expect(l).toHaveLength(EN_TETES.length)
  })

  it('initialise le statut a nouveau et laisse notes et reaction vides', () => {
    const l = versLigne(post)
    expect(l[EN_TETES.indexOf('statut')]).toBe('nouveau')
    expect(l[EN_TETES.indexOf('notes')]).toBe('')
    expect(l[EN_TETES.indexOf('reaction')]).toBe('')
  })

  it('place le lien et le score aux bons index', () => {
    const l = versLigne(post)
    expect(l[EN_TETES.indexOf('lien')]).toBe('https://reddit.com/1')
    expect(l[EN_TETES.indexOf('score')]).toBe('88')
  })

  it('tronque l extrait a 300 caracteres', () => {
    const long = { ...post, contenu: 'x'.repeat(500) }
    const l = versLigne(long)
    expect(l[EN_TETES.indexOf('extrait_orig')]!.length).toBeLessThanOrEqual(300)
  })

  it('tronque defensivement toute valeur a 40000 caracteres', () => {
    const enorme = { ...post, brouillon: 'y'.repeat(60_000) }
    const l = versLigne(enorme)
    for (const valeur of l) {
      expect(valeur.length).toBeLessThanOrEqual(40_000)
    }
  })

  it('citerOnglet quote un nom simple', () => {
    expect(citerOnglet('Prospects')).toBe("'Prospects'")
  })

  it('citerOnglet quote un nom avec espace (sinon plage A1 invalide -> 400 -> prospects perdus)', () => {
    expect(citerOnglet('Prospects Riveska')).toBe("'Prospects Riveska'")
  })

  it('citerOnglet echappe un guillemet simple interne en le doublant (regle Sheets)', () => {
    expect(citerOnglet("L'onglet")).toBe("'L''onglet'")
  })

  it('ajouterLignes([]) renvoie null sans appel reseau', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const r = await ajouterLignes([], {
      email: 'a@b.com', clePrivee: 'k', sheetId: 's', onglet: 'Prospects',
    })
    expect(r).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
