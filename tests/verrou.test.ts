import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { acquerirVerrou, libererVerrou, verrouActif, rafraichirVerrou } from '../src/verrou.ts'

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

  it('reacquiert un verrou perime (process mort) au lieu de rester bloque', () => {
    dossier = mkdtempSync(path.join(tmpdir(), 'radar-verrou-'))
    const v = cheminVerrou()
    const enfant = spawnSync(process.execPath, ['-e', '0'])
    writeFileSync(v, JSON.stringify({ pid: enfant.pid, horodatage: Date.now() }))
    expect(acquerirVerrou(v, DUREE_MAX_MS)).toBe(true)
  })

  it('un seul process gagne quand plusieurs acquierent simultanement', async () => {
    // Deux process lances en parallele sur le meme verrou : l'OS doit en departager
    // exactement un. Un "verrouActif() puis ecriture" non atomique laisse passer les
    // deux (mesure : 4 fois sur 5), ce qui ferait scorer et facturer deux fois.
    dossier = mkdtempSync(path.join(tmpdir(), 'radar-verrou-'))
    const v = cheminVerrou()
    const src = path.join(dossier, 'concurrent.mjs')
    const modVerrou = pathToFileURL(path.resolve('src/verrou.ts')).href
    // L'enfant garde le verrou un court instant avant de rendre la main, comme un
    // vrai run : sans cette attente il se terminerait aussitot et l'autre process
    // reacquerrait legitimement un verrou devenu perime (ce qui ne teste rien).
    writeFileSync(
      src,
      `import { acquerirVerrou } from ${JSON.stringify(modVerrou)}\n` +
        `const gagne = acquerirVerrou(${JSON.stringify(v)}, ${DUREE_MAX_MS})\n` +
        `await new Promise((r) => setTimeout(r, 500))\n` +
        `console.log(gagne)\n`,
    )

    const lancer = (): Promise<string> =>
      new Promise((resoudre, rejeter) => {
        const enfant = spawn(process.execPath, [src], { stdio: ['ignore', 'pipe', 'pipe'] })
        let sortie = ''
        let erreur = ''
        enfant.stdout.on('data', (c: Buffer) => (sortie += c.toString()))
        enfant.stderr.on('data', (c: Buffer) => (erreur += c.toString()))
        enfant.on('error', rejeter)
        enfant.on('close', (code) =>
          code === 0 ? resoudre(sortie.trim()) : rejeter(new Error(erreur || `code ${code}`)),
        )
      })

    for (let essai = 0; essai < 5; essai++) {
      rmSync(v, { force: true })
      const resultats = await Promise.all([lancer(), lancer()])
      expect(resultats.filter((r) => r === 'true')).toHaveLength(1)
    }
  }, 30_000)

  it('ne supprime pas un verrou repris entre-temps par un autre process (pid different)', () => {
    // Simule le scenario du Fix 6 : A a acquis puis un autre process (B, ou un test)
    // a repose le fichier avec un pid different (B l'a juge perime a tort et l'a pris).
    // Si A appelle libererVerrou sans verifier, il supprimerait le verrou de B.
    dossier = mkdtempSync(path.join(tmpdir(), 'radar-verrou-'))
    const v = cheminVerrou()
    const pidEtranger = process.pid + 1
    writeFileSync(v, JSON.stringify({ pid: pidEtranger, horodatage: Date.now() }))

    libererVerrou(v)

    expect(existsSync(v)).toBe(true)
    const contenu = JSON.parse(readFileSync(v, 'utf8')) as { pid: number }
    expect(contenu.pid).toBe(pidEtranger)
  })

  it('supprime normalement un verrou qui nous appartient toujours (meme pid)', () => {
    dossier = mkdtempSync(path.join(tmpdir(), 'radar-verrou-'))
    const v = cheminVerrou()
    writeFileSync(v, JSON.stringify({ pid: process.pid, horodatage: Date.now() }))

    libererVerrou(v)

    expect(existsSync(v)).toBe(false)
  })
})

describe('rafraichirVerrou', () => {
  it('met a jour l horodatage sans changer le proprietaire (meme pid)', () => {
    dossier = mkdtempSync(path.join(tmpdir(), 'radar-verrou-'))
    const v = cheminVerrou()
    writeFileSync(v, JSON.stringify({ pid: process.pid, horodatage: Date.now() - 1_000_000 }))

    rafraichirVerrou(v)

    const contenu = JSON.parse(readFileSync(v, 'utf8')) as { pid: number; horodatage: number }
    expect(contenu.pid).toBe(process.pid)
    expect(Date.now() - contenu.horodatage).toBeLessThan(5000)
  })

  it('empeche un verrou d etre juge perime alors que le run tourne toujours plus longtemps que dureeMaxMs', () => {
    // Reproduit le scenario mesure : un run legitime depasse dureeMaxMs (LLM lent),
    // mais tant qu'il rafraichit periodiquement, un nouvel appelant ne doit jamais
    // pouvoir le juger perime et l'evincer.
    dossier = mkdtempSync(path.join(tmpdir(), 'radar-verrou-'))
    const v = cheminVerrou()
    const dureeMaxCourte = 1000
    writeFileSync(v, JSON.stringify({ pid: process.pid, horodatage: Date.now() - 10_000 })) // deja "perime"
    expect(verrouActif(v, dureeMaxCourte)).toBe(false)

    rafraichirVerrou(v)

    expect(verrouActif(v, dureeMaxCourte)).toBe(true)
    expect(acquerirVerrou(v, dureeMaxCourte)).toBe(false)
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
