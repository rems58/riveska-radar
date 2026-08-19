import { describe, it, expect } from 'vitest'
import { prefiltrer } from '../src/filter/prefilter.ts'
import type { RawPost } from '../src/types.ts'

function post(over: Partial<RawPost>): RawPost {
  return {
    id: 'reddit:1',
    source: 'reddit',
    url: 'https://reddit.com/1',
    auteur: 'bob',
    titre: '',
    contenu: '',
    publieLe: new Date(),
    ...over,
  }
}

describe('prefiltrer', () => {
  it('garde un post contenant un signal de douleur en anglais', () => {
    const p = post({ titre: 'My app got rejected, guideline 4.2.6, what now?' })
    expect(prefiltrer([p], 30)).toHaveLength(1)
  })

  it('garde un post en francais', () => {
    const p = post({ titre: 'Mon app rejetee par Apple, je suis bloque' })
    expect(prefiltrer([p], 30)).toHaveLength(1)
  })

  it('garde un post en allemand', () => {
    const p = post({ titre: 'App abgelehnt, brauche Hilfe beim Veroeffentlichen' })
    expect(prefiltrer([p], 30)).toHaveLength(1)
  })

  it('garde un signal vibe-code', () => {
    const p = post({ titre: 'Built my app with bolt.new, how do I publish to the app store?' })
    expect(prefiltrer([p], 30)).toHaveLength(1)
  })

  it('jette un post sans aucun signal', () => {
    const p = post({ titre: 'Best state management library in 2026?' })
    expect(prefiltrer([p], 30)).toHaveLength(0)
  })

  it('jette un post portant un anti-signal meme s il a un signal', () => {
    const p = post({ titre: 'We are hiring: help clients publish apps, rejected apps fixed' })
    expect(prefiltrer([p], 30)).toHaveLength(0)
  })

  it('jette un post trop ancien', () => {
    const vieux = new Date(Date.now() - 60 * 24 * 3600 * 1000)
    const p = post({ titre: 'app rejected 4.2.6', publieLe: vieux })
    expect(prefiltrer([p], 30)).toHaveLength(0)
  })

  it('cherche aussi dans le contenu, pas seulement le titre', () => {
    const p = post({ titre: 'Question', contenu: 'I have no mac to build my ios app' })
    expect(prefiltrer([p], 30)).toHaveLength(1)
  })

  it('rejette un faux positif par sous-chaine (no machine learning)', () => {
    const p = post({ titre: 'I have no machine learning experience' })
    expect(prefiltrer([p], 30)).toHaveLength(0)
  })

  it('garde toujours le vrai signal no mac', () => {
    const p = post({ titre: 'I have no mac to build my ios app' })
    expect(prefiltrer([p], 30)).toHaveLength(1)
  })

  it('garde bolt.new avec le point litteral echappe', () => {
    const p = post({ titre: 'built with bolt.new' })
    expect(prefiltrer([p], 30)).toHaveLength(1)
  })

  it('ne laisse pas le point jouer les jokers (boltXnew)', () => {
    const p = post({ titre: 'boltXnew is great' })
    expect(prefiltrer([p], 30)).toHaveLength(0)
  })

  it('garde un mot-cle avec tirets en frontiere (d-u-n-s)', () => {
    const p = post({ titre: 'need a d-u-n-s number' })
    expect(prefiltrer([p], 30)).toHaveLength(1)
  })

  it('garde un signal en fin de phrase avec ponctuation', () => {
    const p = post({ titre: 'my app rejected.' })
    expect(prefiltrer([p], 30)).toHaveLength(1)
  })

  it('rejette un faux positif par sous-chaine sur un nombre plus long (guideline 4.35)', () => {
    const p = post({ titre: 'FYI guideline 4.35 was updated, nothing about my case here' })
    expect(prefiltrer([p], 30)).toHaveLength(0)
  })

  describe('prose naturelle (regression sur 2 prospects reels manques, Reddit, 2026-08-19)', () => {
    // Texte repris mot pour mot des posts reels qui ont motive l'ajout de nouveaux
    // signaux : SIGNAUX_DOULEUR n'attrapait que des phrases figees ("app rejected"),
    // pas la facon dont les gens racontent vraiment un rejet.
    it('garde un rejet raconte en prose ("got rejected due to")', () => {
      const p = post({
        titre: 'Play Store App Appeals- how long do they take?',
        contenu:
          'Submitted an app to play store. Initially got rejected due to privacy policy violation, ' +
          're-submitted after making corrections Now, reviewer rejected it but this time attaching ' +
          'screenshot of earlier version',
      })
      expect(prefiltrer([p], 30)).toHaveLength(1)
    })

    it('garde un rejet raconte en prose ("reason for rejection")', () => {
      const p = post({
        titre: 'Any one faced "design spam" rejection in app store.',
        contenu:
          'I have a gaming app submitted for review has a slot machine component in it, ' +
          'i am guessing this is reason for rejection. They have not mentioned exactly what is spam.',
      })
      expect(prefiltrer([p], 30)).toHaveLength(1)
    })

    it('les traductions FR/DE/ES/IT de "rejete a cause de"/"motif du rejet" fonctionnent aussi', () => {
      expect(prefiltrer([post({ titre: 'Mon app rejetee a cause de la politique de confidentialite' })], 30)).toHaveLength(1)
      expect(prefiltrer([post({ titre: 'App abgelehnt wegen Datenschutzrichtlinie' })], 30)).toHaveLength(1)
      expect(prefiltrer([post({ titre: 'Mi app rechazada debido a la politica de privacidad' })], 30)).toHaveLength(1)
      expect(prefiltrer([post({ titre: 'App rifiutata a causa della privacy policy' })], 30)).toHaveLength(1)
    })
  })
})
