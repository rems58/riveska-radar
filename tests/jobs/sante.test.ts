import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  decoderTexteLog,
  nettoyerBruitPowershell,
  dernierRunTermine,
  analyserTachesCsv,
  analyserConfig,
  formaterAge,
  formaterRapport,
  aUnProbleme,
  executerSante,
  CODE_JAMAIS_DECLENCHEE,
  type DepsSante,
  type Bloc,
} from '../../src/jobs/sante.ts'

afterEach(() => vi.restoreAllMocks())

const MINUTE = 60_000
const HEURE = 60 * MINUTE

/** Cle PEM factice au format attendu par config.ts (\n echappes sur une ligne). */
const CLE_PEM = '-----BEGIN PRIVATE KEY-----\\nMIIfake\\n-----END PRIVATE KEY-----\\n'

const ENV_OK: Record<string, string | undefined> = {
  TELEGRAM_BOT_TOKEN: 'TOKEN_TELEGRAM_SECRET',
  TELEGRAM_CHAT_ID: '42',
  GOOGLE_SA_EMAIL: 'riveska@riveska.iam.gserviceaccount.com',
  GOOGLE_SA_PRIVATE_KEY: CLE_PEM,
  SHEET_ID: 'SHEET',
  OPENROUTER_API_KEY: 'sk-or-test',
}

function utf16leAvecBom(texte: string): Buffer {
  return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(texte, 'utf16le')])
}

/** Retrouve une ligne du rapport par le fragment de texte qu'elle contient. */
function ligneDe(blocs: Bloc[], titre: string, fragment: string) {
  const bloc = blocs.find((b) => b.titre === titre)
  if (!bloc) throw new Error(`bloc "${titre}" absent du rapport`)
  const ligne = bloc.lignes.find((l) => l.texte.includes(fragment))
  if (!ligne) throw new Error(`aucune ligne "${fragment}" dans le bloc "${titre}" : ${JSON.stringify(bloc.lignes)}`)
  return ligne
}

describe('decoderTexteLog', () => {
  it('decode un log PowerShell en UTF-16LE avec BOM', () => {
    const buf = utf16leAvecBom('[radar] commande "radar" terminee : ok\r\n')
    expect(decoderTexteLog(buf)).toContain('[radar] commande "radar" terminee')
  })

  it('decode une queue de fichier UTF-16LE sans BOM (lecture partielle)', () => {
    const complet = utf16leAvecBom('[radar] debut\r\n[radar] commande "radar" terminee : ok\r\n')
    // Coupe le BOM : c'est exactement ce que produit une lecture des N derniers octets.
    const queue = complet.subarray(2)
    expect(decoderTexteLog(queue)).toContain('commande "radar" terminee')
  })

  it('decode aussi un log UTF-8 (lancement manuel redirige, autre shell)', () => {
    expect(decoderTexteLog(Buffer.from('[radar] commande "weekly" terminee : ok', 'utf8'))).toContain(
      'commande "weekly" terminee',
    )
  })
})

describe('nettoyerBruitPowershell', () => {
  const brut = [
    'node : [radar] telegram : reponse HTTP 400',
    'Au caractere C:\\radar\\scripts\\lancer-job.ps1:59 : 1',
    '+ & $node $indexTs $Commande *>> $log',
    '+ ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~',
    '    + CategoryInfo          : NotSpecified: (:String) [], RemoteException',
    '    + FullyQualifiedErrorId : NativeCommandError',
    '[radar] commande "radar" terminee : { collectes: 12 }',
  ].join('\r\n')

  it('retire les lignes de bruit NativeCommandError', () => {
    const propre = nettoyerBruitPowershell(brut)
    expect(propre).not.toContain('CategoryInfo')
    expect(propre).not.toContain('FullyQualifiedErrorId')
    expect(propre).not.toContain('~~~')
    expect(propre).not.toContain('Au caractere')
  })

  it('retire le prefixe "node : " que PowerShell colle devant chaque ligne stderr', () => {
    const propre = nettoyerBruitPowershell(brut)
    expect(propre).toContain('[radar] telegram : reponse HTTP 400')
    expect(propre).not.toContain('node : [radar]')
  })

  it('ne touche pas au contenu utile', () => {
    expect(nettoyerBruitPowershell(brut)).toContain('[radar] commande "radar" terminee')
  })
})

describe('dernierRunTermine', () => {
  it('trouve la ligne de fin de run dans un log UTF-16LE bruite', () => {
    const buf = utf16leAvecBom(
      [
        'node : [radar] telegram : reponse HTTP 400',
        '    + FullyQualifiedErrorId : NativeCommandError',
        '[radar] commande "radar" terminee : { collectes: 12, retenus: 2 }',
      ].join('\r\n'),
    )
    const ligne = dernierRunTermine(buf)
    expect(ligne).toContain('commande "radar" terminee')
    expect(ligne).toContain('retenus: 2')
    expect(ligne).not.toContain('NativeCommandError')
  })

  it('renvoie la DERNIERE fin de run quand le log en contient plusieurs', () => {
    const buf = utf16leAvecBom(
      '[radar] commande "radar" terminee : { retenus: 1 }\r\n[radar] commande "radar" terminee : { retenus: 9 }\r\n',
    )
    expect(dernierRunTermine(buf)).toContain('retenus: 9')
  })

  it('survit a un message coupe en plusieurs lignes par PowerShell', () => {
    const buf = utf16leAvecBom('[radar] commande "radar"\r\nterminee : { retenus: 3 }\r\n')
    expect(dernierRunTermine(buf)).toContain('terminee')
  })

  it('renvoie null si aucun run termine n apparait', () => {
    expect(dernierRunTermine(utf16leAvecBom('[radar] rien du tout\r\n'))).toBeNull()
  })
})

const ENTETE_CSV =
  '"HostName","TaskName","Next Run Time","Status","Logon Mode","Last Run Time","Last Result","Author","Task To Run"'

function ligneTache(
  nom: string,
  prochaine: string,
  statut: string,
  resultat: string,
  dernierRun = '19/08/2026 17:00:00',
): string {
  return `"MINIPC","\\${nom}","${prochaine}","${statut}","Interactive/Background","${dernierRun}","${resultat}","MINIPC\\rems","powershell.exe"`
}

describe('analyserTachesCsv', () => {
  it('extrait uniquement les taches RiveskaRadar-*', () => {
    const csv = [
      ENTETE_CSV,
      ligneTache('Microsoft\\Windows\\Defrag\\ScheduledDefrag', '20/08/2026 03:00:00', 'Ready', '0'),
      ligneTache('RiveskaRadar-Radar', '19/08/2026 17:15:00', 'Ready', '0'),
    ].join('\r\n')

    const taches = analyserTachesCsv(csv)
    expect(taches).toHaveLength(1)
    expect(taches[0]!.nom).toBe('RiveskaRadar-Radar')
    expect(taches[0]!.dernierResultat).toBe(0)
    expect(taches[0]!.prochaine).toBe('19/08/2026 17:15:00')
    expect(taches[0]!.statut).toBe('Ready')
  })

  it('ignore l en-tete et les lignes trop courtes', () => {
    expect(analyserTachesCsv([ENTETE_CSV, '', '"MINIPC"'].join('\r\n'))).toEqual([])
  })

  it('lit le code de resultat meme si le nom de tache est prefixe d un dossier', () => {
    const csv = [ENTETE_CSV, ligneTache('Riveska\\RiveskaRadar-Weekly', 'N/A', 'Ready', '267011')].join('\r\n')
    const taches = analyserTachesCsv(csv)
    expect(taches[0]!.nom).toBe('RiveskaRadar-Weekly')
    expect(taches[0]!.dernierResultat).toBe(CODE_JAMAIS_DECLENCHEE)
  })
})

describe('formaterAge', () => {
  it('formate les minutes, les heures et les jours', () => {
    expect(formaterAge(30_000)).toContain('moins')
    expect(formaterAge(12 * MINUTE)).toBe('12 min')
    expect(formaterAge(3 * HEURE + 5 * MINUTE)).toBe('3 h 5 min')
    expect(formaterAge(50 * HEURE)).toBe('2 j 2 h')
  })
})

describe('analyserConfig', () => {
  it('valide une configuration complete', () => {
    const { bloc, cfg } = analyserConfig(ENV_OK, true, '/x/.env')
    expect(cfg).not.toBeNull()
    expect(aUnProbleme([bloc])).toBe(false)
  })

  it('signale precisement une variable obligatoire manquante', () => {
    const { bloc, cfg } = analyserConfig({ ...ENV_OK, SHEET_ID: undefined }, true, '/x/.env')
    expect(cfg).toBeNull()
    expect(aUnProbleme([bloc])).toBe(true)
    expect(JSON.stringify(bloc)).toContain('SHEET_ID')
  })

  it('signale un .env absent', () => {
    const { bloc } = analyserConfig(ENV_OK, false, '/x/.env')
    expect(aUnProbleme([bloc])).toBe(true)
    expect(JSON.stringify(bloc)).toContain('.env')
  })

  it('traite les sources facultatives desactivees comme une information, pas un probleme', () => {
    const { bloc } = analyserConfig(ENV_OK, true, '/x/.env')
    expect(aUnProbleme([bloc])).toBe(false)
    const desactives = bloc.lignes.filter((l) => l.marqueur === '--')
    expect(desactives.length).toBeGreaterThanOrEqual(2)
    expect(JSON.stringify(desactives)).toContain('Bluesky')
    expect(JSON.stringify(desactives)).toContain('Reddit')
  })

  it('ne signale pas Bluesky quand ses identifiants sont fournis', () => {
    const { bloc } = analyserConfig(
      { ...ENV_OK, BLUESKY_ID: 'moi.bsky.social', BLUESKY_APP_PASSWORD: 'x' },
      true,
      '/x/.env',
    )
    const desactives = bloc.lignes.filter((l) => l.marqueur === '--')
    expect(JSON.stringify(desactives)).not.toContain('Bluesky')
  })
})

describe('formaterRapport', () => {
  const blocs: Bloc[] = [
    { titre: 'Configuration', lignes: [{ marqueur: 'OK', texte: 'tout bon' }] },
    { titre: 'Google Sheets', lignes: [{ marqueur: '!!', texte: 'Sheet inaccessible' }] },
  ]

  it('affiche un marqueur par ligne et un bloc par domaine', () => {
    const r = formaterRapport(blocs, new Date())
    expect(r).toContain('Configuration')
    expect(r).toContain('OK')
    expect(r).toContain('!!')
  })

  it('termine par une conclusion en une ligne qui nomme le domaine en cause', () => {
    const lignes = formaterRapport(blocs, new Date()).trimEnd().split('\n')
    const conclusion = lignes[lignes.length - 1]!
    expect(conclusion).toMatch(/^Conclusion :/)
    expect(conclusion).toContain('Google Sheets')
  })

  it('conclut positivement quand tout va bien', () => {
    const r = formaterRapport([blocs[0]!], new Date())
    const lignes = r.trimEnd().split('\n')
    expect(lignes[lignes.length - 1]).toMatch(/^Conclusion : tout va bien/)
  })
})

describe('executerSante', () => {
  let racine: string
  const MAINTENANT = new Date('2026-08-19T12:00:00Z')

  const CSV_TACHES = [
    ENTETE_CSV,
    ligneTache('RiveskaRadar-Radar', '19/08/2026 17:15:00', 'Ready', '0'),
    ligneTache('RiveskaRadar-Reddit', '19/08/2026 18:00:00', 'Ready', '267011'),
    ligneTache('RiveskaRadar-Recheck', '19/08/2026 18:00:00', 'Ready', '0'),
    ligneTache('RiveskaRadar-Triggers', '20/08/2026 09:00:00', 'Ready', '0'),
    ligneTache('RiveskaRadar-Weekly', '24/08/2026 09:00:00', 'Ready', '0'),
  ].join('\r\n')

  beforeEach(() => {
    racine = mkdtempSync(path.join(tmpdir(), 'radar-sante-'))
    writeFileSync(path.join(racine, '.env'), 'SHEET_ID=x\n')
  })

  afterEach(() => {
    rmSync(racine, { recursive: true, force: true })
  })

  function deps(surcharge: Partial<DepsSante> = {}): DepsSante {
    return {
      racine,
      cheminDb: path.join(racine, 'radar.db'),
      env: ENV_OK,
      notif: false,
      maintenant: MAINTENANT,
      plateforme: 'win32',
      verifierSheet: async () => ({
        ok: true,
        ongletTrouve: true,
        lignes: 128,
        dernierProspect: new Date(MAINTENANT.getTime() - 2 * HEURE),
      }),
      verifierTelegram: async () => ({ ok: true, nom: 'riveska_bot' }),
      envoyerTest: async () => true,
      verifierOpenrouter: async () => ({ ok: true, restant: 4.32 }),
      statsDb: () => ({
        posts: 128,
        dernierAjout: new Date(MAINTENANT.getTime() - 12 * MINUTE),
        enAttenteRetry: 0,
        abandons: 0,
        abandonsRecents: 0,
      }),
      lireTaches: async () => CSV_TACHES,
      ...surcharge,
    }
  }

  /** Un log frais, comme en produit une tache planifiee qui vient de tourner. */
  function ecrireLog(commande: string, ageMs: number, contenu?: string): void {
    const dossier = path.join(racine, 'logs')
    mkdirSync(dossier, { recursive: true })
    const fichier = path.join(dossier, `${commande}.log`)
    writeFileSync(fichier, utf16leAvecBom(contenu ?? `[radar] commande "${commande}" terminee : { retenus: 1 }\r\n`))
    const date = new Date(MAINTENANT.getTime() - ageMs)
    utimesSync(fichier, date, date)
  }

  function tousLesLogsFrais(): void {
    ecrireLog('radar', 5 * MINUTE)
    ecrireLog('reddit', 20 * MINUTE)
    ecrireLog('recheck', 2 * HEURE)
    ecrireLog('triggers', 10 * HEURE)
    ecrireLog('weekly', 2 * 24 * HEURE)
  }

  it('conclut positivement quand tout va bien', async () => {
    tousLesLogsFrais()
    const r = await executerSante(deps())
    expect(r.ok).toBe(true)
    expect(r.rapport).not.toContain('!!')
    expect(r.rapport).toContain('Conclusion : tout va bien')
  })

  it('n appelle JAMAIS le reseau directement (aucune requete Reddit possible)', async () => {
    const fetchMock = vi.fn(() => {
      throw new Error('aucun appel reseau direct ne doit sortir de executerSante')
    })
    vi.stubGlobal('fetch', fetchMock)
    tousLesLogsFrais()
    await executerSante(deps())
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('ne modifie rien sur le disque (ni verrou, ni base, ni log)', async () => {
    tousLesLogsFrais()
    const avant = readdirSync(racine).sort()
    const logsAvant = readdirSync(path.join(racine, 'logs')).sort()
    await executerSante(deps())
    expect(readdirSync(racine).sort()).toEqual(avant)
    expect(readdirSync(path.join(racine, 'logs')).sort()).toEqual(logsAvant)
  })

  it('ne fait apparaitre aucun secret dans le rapport (il sera copie-colle)', async () => {
    tousLesLogsFrais()
    const r = await executerSante(deps({ notif: true }))
    expect(r.rapport).not.toContain('TOKEN_TELEGRAM_SECRET')
    expect(r.rapport).not.toContain('sk-or-test')
    expect(r.rapport).not.toContain('PRIVATE KEY')
  })

  it('n envoie aucun message Telegram par defaut', async () => {
    const envoyerTest = vi.fn(async () => true)
    await executerSante(deps({ envoyerTest }))
    expect(envoyerTest).not.toHaveBeenCalled()
  })

  it('envoie un message de test uniquement avec --notif', async () => {
    const envoyerTest = vi.fn(async () => true)
    const r = await executerSante(deps({ envoyerTest, notif: true }))
    expect(envoyerTest).toHaveBeenCalledTimes(1)
    expect(r.rapport).toContain('message de test')
  })

  it('dit quoi faire quand le Sheet renvoie 403', async () => {
    const r = await executerSante(deps({ verifierSheet: async () => ({ ok: false, code: 403 }) }))
    expect(r.ok).toBe(false)
    expect(r.rapport).toContain('403')
    expect(r.rapport).toContain('Editeur')
    expect(r.rapport).toContain('riveska@riveska.iam.gserviceaccount.com')
  })

  it('signale un onglet absent en nommant SHEET_TAB', async () => {
    const r = await executerSante(deps({ verifierSheet: async () => ({ ok: false, ongletTrouve: false }) }))
    expect(r.ok).toBe(false)
    expect(r.rapport).toContain('SHEET_TAB')
  })

  it('signale une cle OpenRouter refusee et dit ou en refaire une', async () => {
    const r = await executerSante(deps({ verifierOpenrouter: async () => ({ ok: false, code: 401 }) }))
    expect(r.ok).toBe(false)
    expect(r.rapport).toContain('OPENROUTER_API_KEY')
  })

  it('alerte quand le credit OpenRouter est presque epuise (le scoring s arreterait)', async () => {
    const r = await executerSante(deps({ verifierOpenrouter: async () => ({ ok: true, restant: 0.12 }) }))
    expect(r.ok).toBe(false)
    expect(r.rapport).toContain('0.12')
    expect(r.rapport.toLowerCase()).toContain('recharger')
  })

  it('accepte une API qui n expose aucun credit', async () => {
    const r = await executerSante(deps({ verifierOpenrouter: async () => ({ ok: true, restant: null }) }))
    expect(r.ok).toBe(true)
  })

  it('n arrive pas a un faux positif quand la base locale n existe pas encore', async () => {
    const statsDb = vi.fn(() => {
      throw new Error('ne doit pas etre appele si le fichier est absent')
    })
    const r = await executerSante(deps({ statsDb }))
    expect(statsDb).not.toHaveBeenCalled()
    expect(r.ok).toBe(true)
    expect(r.rapport).toContain('base locale absente')
  })

  it('signale les abandons definitifs recents', async () => {
    writeFileSync(path.join(racine, 'radar.db'), 'base factice, lue par le stub statsDb')
    const r = await executerSante(
      deps({
        statsDb: () => ({ posts: 5, dernierAjout: MAINTENANT, enAttenteRetry: 2, abandons: 3, abandonsRecents: 3 }),
      }),
    )
    expect(r.ok).toBe(false)
    expect(r.rapport).toContain('abandon')
    // Les echecs en attente de nouvelle tentative sont une information, pas une alerte.
    expect(r.rapport).toContain('2 post')
  })

  it('accepte un verrou frais (un run est simplement en cours)', async () => {
    writeFileSync(
      path.join(racine, 'radar.lock'),
      JSON.stringify({ pid: process.pid, horodatage: MAINTENANT.getTime() - 2 * MINUTE }),
    )
    tousLesLogsFrais()
    const r = await executerSante(deps())
    expect(r.ok).toBe(true)
    expect(r.rapport).toContain('run "radar" en cours')
  })

  it('signale un verrou ancien', async () => {
    writeFileSync(
      path.join(racine, 'reddit.lock'),
      JSON.stringify({ pid: process.pid, horodatage: MAINTENANT.getTime() - 5 * HEURE }),
    )
    const r = await executerSante(deps())
    expect(r.ok).toBe(false)
    expect(r.rapport).toContain('reddit.lock')
  })

  it('signale un verrou laisse par un process disparu', async () => {
    writeFileSync(
      path.join(racine, 'radar.lock'),
      JSON.stringify({ pid: 999_999_999, horodatage: MAINTENANT.getTime() - MINUTE }),
    )
    const r = await executerSante(deps())
    expect(r.ok).toBe(false)
    expect(r.rapport.toLowerCase()).toContain('interrompu')
  })

  it('ne compte pas 267011 (jamais declenchee) comme un echec', async () => {
    tousLesLogsFrais()
    const r = await executerSante(deps())
    expect(r.ok).toBe(true)
    expect(r.rapport).toContain('jamais declenchee')
    expect(r.rapport).not.toContain('267011')
  })

  it('signale un code de resultat de tache reellement en echec', async () => {
    tousLesLogsFrais()
    const csv = CSV_TACHES.replace('"0","MINIPC\\rems"', '"1","MINIPC\\rems"')
    const r = await executerSante(deps({ lireTaches: async () => csv }))
    expect(r.ok).toBe(false)
    expect(r.rapport).toContain('RiveskaRadar-Radar')
  })

  it('signale une tache manquante quand les autres sont bien la', async () => {
    tousLesLogsFrais()
    const csv = CSV_TACHES.split('\r\n')
      .filter((l) => !l.includes('RiveskaRadar-Weekly'))
      .join('\r\n')
    const r = await executerSante(deps({ lireTaches: async () => csv }))
    expect(r.ok).toBe(false)
    expect(r.rapport).toContain('RiveskaRadar-Weekly')
  })

  it('ne rougit pas sur une machine sans aucune tache installee (poste de dev)', async () => {
    const r = await executerSante(deps({ lireTaches: async () => ENTETE_CSV }))
    expect(r.ok).toBe(true)
    expect(r.rapport).toContain('installer-taches.ps1')
  })

  it('ne lit pas les taches planifiees hors Windows', async () => {
    const lireTaches = vi.fn(async () => CSV_TACHES)
    const r = await executerSante(deps({ plateforme: 'linux', lireTaches }))
    expect(lireTaches).not.toHaveBeenCalled()
    expect(r.ok).toBe(true)
  })

  it('signale un log fige bien au-dela de la cadence de son job', async () => {
    tousLesLogsFrais()
    ecrireLog('radar', 6 * HEURE)
    const r = await executerSante(deps())
    expect(r.ok).toBe(false)
    expect(r.rapport).toContain('radar.log')
    expect(r.rapport).toContain('Planificateur')
  })

  it('signale un log sans fin de run (dernier run interrompu)', async () => {
    tousLesLogsFrais()
    ecrireLog('recheck', MINUTE, '[radar] recheck : boum\r\n')
    const r = await executerSante(deps())
    expect(r.ok).toBe(false)
    expect(r.rapport).toContain('recheck.log')
  })

  it('ne rougit pas quand aucun log n existe (jamais lance en planifie)', async () => {
    const r = await executerSante(deps())
    expect(r.ok).toBe(true)
  })

  it('ne verifie rien en reseau si la configuration est invalide', async () => {
    const verifierSheet = vi.fn(async () => ({ ok: true }))
    const verifierTelegram = vi.fn(async () => ({ ok: true }))
    const verifierOpenrouter = vi.fn(async () => ({ ok: true }))
    const r = await executerSante(
      deps({
        env: { ...ENV_OK, TELEGRAM_BOT_TOKEN: undefined },
        verifierSheet,
        verifierTelegram,
        verifierOpenrouter,
      }),
    )
    expect(r.ok).toBe(false)
    expect(verifierSheet).not.toHaveBeenCalled()
    expect(verifierTelegram).not.toHaveBeenCalled()
    expect(verifierOpenrouter).not.toHaveBeenCalled()
    expect(r.rapport).toContain('TELEGRAM_BOT_TOKEN')
  })

  // -------------------------------------------------------------------------
  // Faux positifs observes au premier lancement sur le mini PC de production :
  // le bloc Logs concluait a la panne sur des etats que les blocs Verrous et
  // Taches, dans la MEME sortie, declaraient normaux.
  // -------------------------------------------------------------------------

  /**
   * Etat reel quelques heures apres l'installation des taches : radar a tourne,
   * reddit tourne en ce moment, les trois autres ne se sont jamais declenchees.
   */
  const CSV_JUSTE_INSTALLE = [
    ENTETE_CSV,
    ligneTache('RiveskaRadar-Radar', '19/08/2026 18:14:51', 'Ready', '0'),
    ligneTache('RiveskaRadar-Reddit', '19/08/2026 18:59:51', 'Running', '267009'),
    ligneTache('RiveskaRadar-Recheck', '19/08/2026 22:59:51', 'Ready', '267011', 'N/A'),
    ligneTache('RiveskaRadar-Triggers', '20/08/2026 09:00:00', 'Ready', '267011', 'N/A'),
    ligneTache('RiveskaRadar-Weekly', '24/08/2026 09:00:00', 'Ready', '267011', 'N/A'),
  ].join('\r\n')

  /** Un log en cours d'ecriture : le run a commence, la ligne de fin n'existe pas encore. */
  const LOG_SANS_FIN = '[radar] reddit : collecte rss en cours\r\n'

  it('ne prend pas un run en cours pour un run interrompu (verrou tenu)', async () => {
    tousLesLogsFrais()
    ecrireLog('reddit', 6 * MINUTE, LOG_SANS_FIN)
    writeFileSync(
      path.join(racine, 'reddit.lock'),
      JSON.stringify({ pid: process.pid, horodatage: MAINTENANT.getTime() - MINUTE }),
    )

    const r = await executerSante(deps())

    const ligne = ligneDe(r.blocs, 'Logs', 'reddit.log')
    expect(ligne.marqueur).toBe('OK')
    expect(ligne.texte).toContain('en cours')
    expect(ligne.texte).toContain('1 min')
    expect(ligne.texte).not.toContain('interrompu')
    expect(r.ok).toBe(true)
  })

  it('ne prend pas un run en cours pour un run interrompu quand seul le Planificateur le sait', async () => {
    tousLesLogsFrais()
    ecrireLog('reddit', 6 * MINUTE, LOG_SANS_FIN)

    const r = await executerSante(deps({ lireTaches: async () => CSV_JUSTE_INSTALLE }))

    const ligne = ligneDe(r.blocs, 'Logs', 'reddit.log')
    expect(ligne.marqueur).toBe('OK')
    expect(ligne.texte).toContain('en cours')
    expect(ligne.texte).not.toContain('interrompu')
    expect(r.ok).toBe(true)
  })

  it('ne signale pas le log absent d une tache jamais declenchee (attente, pas panne)', async () => {
    ecrireLog('radar', 5 * MINUTE)
    ecrireLog('reddit', 6 * MINUTE)

    const r = await executerSante(deps({ lireTaches: async () => CSV_JUSTE_INSTALLE }))

    for (const commande of ['recheck', 'triggers', 'weekly']) {
      const ligne = ligneDe(r.blocs, 'Logs', `${commande}.log`)
      expect(ligne.marqueur).toBe('--')
      expect(ligne.texte).toContain('jamais declenchee')
    }
    expect(r.ok).toBe(true)
  })

  it('signale toujours le log absent d une tache qui s est deja executee', async () => {
    ecrireLog('radar', 5 * MINUTE)
    ecrireLog('reddit', 6 * MINUTE)
    // Recheck a tourne (resultat 0) sans jamais rien ecrire : la, c'est un vrai defaut.
    const csv = [
      ENTETE_CSV,
      ligneTache('RiveskaRadar-Radar', '19/08/2026 18:14:51', 'Ready', '0'),
      ligneTache('RiveskaRadar-Reddit', '19/08/2026 18:59:51', 'Ready', '0'),
      ligneTache('RiveskaRadar-Recheck', '19/08/2026 22:59:51', 'Ready', '0'),
      ligneTache('RiveskaRadar-Triggers', '20/08/2026 09:00:00', 'Ready', '267011', 'N/A'),
      ligneTache('RiveskaRadar-Weekly', '24/08/2026 09:00:00', 'Ready', '267011', 'N/A'),
    ].join('\r\n')

    const r = await executerSante(deps({ lireTaches: async () => csv }))

    expect(ligneDe(r.blocs, 'Logs', 'recheck.log').marqueur).toBe('!!')
    expect(r.ok).toBe(false)
  })

  it('signale toujours un log sans fin de run quand aucun run ne tourne', async () => {
    tousLesLogsFrais()
    ecrireLog('reddit', 6 * MINUTE, LOG_SANS_FIN)

    // Aucun verrou, et le Planificateur declare reddit au repos.
    const r = await executerSante(deps())

    expect(ligneDe(r.blocs, 'Logs', 'reddit.log').marqueur).toBe('!!')
    expect(r.rapport).toContain('interrompu')
    expect(r.ok).toBe(false)
  })

  it('garde la fraicheur comme signal fort sur une tache qui, elle, s est deja lancee', async () => {
    tousLesLogsFrais()
    ecrireLog('radar', 6 * HEURE)

    const r = await executerSante(deps({ lireTaches: async () => CSV_JUSTE_INSTALLE }))

    const ligne = ligneDe(r.blocs, 'Logs', 'radar.log')
    expect(ligne.marqueur).toBe('!!')
    expect(ligne.texte).toContain('Planificateur')
    expect(r.ok).toBe(false)
  })

  it('ne juge pas la fraicheur du log d une tache jamais declenchee', async () => {
    tousLesLogsFrais()
    // Log laisse par un lancement manuel il y a longtemps, la tache n a jamais tourne.
    ecrireLog('weekly', 30 * 24 * HEURE)

    const r = await executerSante(deps({ lireTaches: async () => CSV_JUSTE_INSTALLE }))

    expect(ligneDe(r.blocs, 'Logs', 'weekly.log').marqueur).not.toBe('!!')
    expect(r.ok).toBe(true)
  })

  it('rend 0 sur l etat observe au premier lancement (les quatre !! etaient faux)', async () => {
    ecrireLog('radar', 5 * MINUTE)
    ecrireLog('reddit', 6 * MINUTE, LOG_SANS_FIN)
    writeFileSync(
      path.join(racine, 'reddit.lock'),
      JSON.stringify({ pid: process.pid, horodatage: MAINTENANT.getTime() - MINUTE }),
    )

    const r = await executerSante(deps({ lireTaches: async () => CSV_JUSTE_INSTALLE }))

    expect(r.rapport).not.toContain('!!')
    expect(r.rapport).toContain('Conclusion : tout va bien')
    expect(r.ok).toBe(true)
  })
})
