import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { acquerirVerrou, libererVerrou, verrouActif } from '../src/verrou.ts'

const DUREE_MAX_MS = 60_000

let dossier: string

function cheminVerrou(): string {
  return path.join(dossier, 'test.lock')
}

afterEach(() => {
  if (dossier) rmSync(dossier, { recursive: true, force: true })
})

describe('acquerirVerrou / libererVerrou', () => {
  it('acquiert un verrou libre', () => {
    dossier = mkdtempSync(path.join(tmpdir(), 'radar-verrou-'))
    expect(acquerirVerrou(cheminVerrou(), DUREE_MAX_MS)).toBe(true)
  })

  it('refuse un deuxieme acquerirVerrou tant que le premier n est pas libere', () => {
    dossier = mkdtempSync(path.join(tmpdir(), 'radar-verrou-'))
    const v = cheminVerrou()
    expect(acquerirVerrou(v, DUREE_MAX_MS)).toBe(true)
    expect(acquerirVerrou(v, DUREE_MAX_MS)).toBe(false)
  })

  it('libererVerrou permet un nouvel acquerirVerrou', () => {
    dossier = mkdtempSync(path.join(tmpdir(), 'radar-verrou-'))
    const v = cheminVerrou()
    expect(acquerirVerrou(v, DUREE_MAX_MS)).toBe(true)
    libererVerrou(v)
    expect(acquerirVerrou(v, DUREE_MAX_MS)).toBe(true)
  })

  it('libererVerrou est sans effet si le fichier n existe pas (pas d exception)', () => {
    dossier = mkdtempSync(path.join(tmpdir(), 'radar-verrou-'))
    expect(() => libererVerrou(cheminVerrou())).not.toThrow()
  })
})

describe('verrouActif', () => {
  it('renvoie false si aucun fichier de verrou n existe', () => {
    dossier = mkdtempSync(path.join(tmpdir(), 'radar-verrou-'))
    expect(verrouActif(cheminVerrou(), DUREE_MAX_MS)).toBe(false)
  })

  it('renvoie true pour un verrou recent pose par le process courant (toujours vivant)', () => {
    dossier = mkdtempSync(path.join(tmpdir(), 'radar-verrou-'))
    const v = cheminVerrou()
    acquerirVerrou(v, DUREE_MAX_MS)
    expect(verrouActif(v, DUREE_MAX_MS)).toBe(true)
  })

  it('un verrou dont l age depasse dureeMaxMs est considere perime, meme si le process est vivant', () => {
    dossier = mkdtempSync(path.join(tmpdir(), 'radar-verrou-'))
    const v = cheminVerrou()
    writeFileSync(v, JSON.stringify({ pid: process.pid, horodatage: Date.now() - 1_000_000 }))
    expect(verrouActif(v, DUREE_MAX_MS)).toBe(false)
  })

  it('un verrou pose par un process qui n existe plus est considere perime, meme recent', () => {
    dossier = mkdtempSync(path.join(tmpdir(), 'radar-verrou-'))
    const v = cheminVerrou()
    // Un process lance puis termine : son PID n'est (tres probablement) plus attribue.
    const enfant = spawnSync(process.execPath, ['-e', '0'])
    const pidMort = enfant.pid
    expect(pidMort).toBeTypeOf('number')
    writeFileSync(v, JSON.stringify({ pid: pidMort, horodatage: Date.now() }))
    expect(verrouActif(v, DUREE_MAX_MS)).toBe(false)
  })

  it('un fichier de verrou corrompu est traite comme absent (jamais de blocage permanent)', () => {
    dossier = mkdtempSync(path.join(tmpdir(), 'radar-verrou-'))
    const v = cheminVerrou()
    writeFileSync(v, 'pas du json valide {{{')
    expect(verrouActif(v, DUREE_MAX_MS)).toBe(false)
    expect(acquerirVerrou(v, DUREE_MAX_MS)).toBe(true)
  })
})
