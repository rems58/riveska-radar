import { describe, it, expect } from 'vitest'
import { extraireBalise, extraireBlocsItem, extraireLien } from '../../src/collectors/rss.ts'

describe('extraireBlocsItem', () => {
  it('extrait les blocs <item> (RSS)', () => {
    const xml = '<rss><channel><item><title>a</title></item><item><title>b</title></item></channel></rss>'
    expect(extraireBlocsItem(xml)).toHaveLength(2)
  })

  it('extrait les blocs <entry> (Atom) - sans ce support un flux Atom valide rend 0 item', () => {
    const xml = "<feed><entry><title type='text'>a</title></entry><entry><title type='text'>b</title></entry></feed>"
    expect(extraireBlocsItem(xml)).toHaveLength(2)
  })

  it('renvoie un tableau vide sans lever sur un flux sans item ni entry', () => {
    expect(extraireBlocsItem('<rss><channel></channel></rss>')).toEqual([])
  })
})

describe('extraireBalise', () => {
  it('extrait le texte d une balise RSS simple', () => {
    expect(extraireBalise('<title>Mon titre</title>', 'title')).toBe('Mon titre')
  })

  it('extrait le texte d une balise Atom avec attributs sur la balise ouvrante', () => {
    expect(extraireBalise("<title type='text'>Mon titre</title>", 'title')).toBe('Mon titre')
  })

  it('gere le CDATA', () => {
    expect(extraireBalise('<title><![CDATA[Titre <b>riche</b>]]></title>', 'title')).toBe('Titre <b>riche</b>')
  })
})

describe('extraireLien', () => {
  it('extrait un <link>texte</link> au format RSS', () => {
    expect(extraireLien('<item><link>https://example.test/1</link></item>')).toBe('https://example.test/1')
  })

  it('extrait le href de la balise <link rel="alternate"> au format Atom', () => {
    const bloc =
      "<entry>" +
      "<link rel='replies' type='application/atom+xml' href='https://example.test/comments'/>" +
      "<link rel='alternate' type='text/html' href='https://example.test/article'/>" +
      "<link rel='self' type='application/atom+xml' href='https://example.test/self'/>" +
      "</entry>"
    expect(extraireLien(bloc)).toBe('https://example.test/article')
  })

  it('a defaut de rel=alternate, prend le premier href disponible', () => {
    const bloc = "<entry><link rel='self' href='https://example.test/self'/></entry>"
    expect(extraireLien(bloc)).toBe('https://example.test/self')
  })

  it('renvoie null si aucun lien exploitable (ni texte ni href)', () => {
    expect(extraireLien('<item><title>Sans lien</title></item>')).toBeNull()
  })
})
