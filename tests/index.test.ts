import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { COMMANDES, chargerEnv } from '../src/index.ts'

describe('COMMANDES', () => {
  it('expose les quatre jobs', () => {
    expect(Object.keys(COMMANDES).sort()).toEqual(['radar', 'recheck', 'triggers', 'weekly'])
  })
})

describe('chargerEnv', () => {
  const cle = `RADAR_TEST_CHARGERENV_${Date.now()}`
  let dossier: string

  afterEach(() => {
    delete process.env[cle]
    if (dossier) rmSync(dossier, { recursive: true, force: true })
  })

  it('charge les variables d un fichier .env existant dans process.env', () => {
    dossier = mkdtempSync(path.join(tmpdir(), 'radar-env-'))
    const fichier = path.join(dossier, '.env')
    writeFileSync(fichier, `${cle}=valeur_test\n`)

    chargerEnv(fichier)

    expect(process.env[cle]).toBe('valeur_test')
  })

  it('ne leve pas si le fichier n existe pas (la validation zod prend le relais)', () => {
    expect(() => chargerEnv('/chemin/totalement/inexistant/.env')).not.toThrow()
  })

  it('ne remplace pas une variable deja presente dans l environnement (CI/lancement manuel)', () => {
    process.env[cle] = 'valeur_deja_presente'
    dossier = mkdtempSync(path.join(tmpdir(), 'radar-env-'))
    const fichier = path.join(dossier, '.env')
    writeFileSync(fichier, `${cle}=valeur_du_fichier\n`)

    chargerEnv(fichier)

    expect(process.env[cle]).toBe('valeur_deja_presente')
  })
})
