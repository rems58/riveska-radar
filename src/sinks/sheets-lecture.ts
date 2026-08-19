import { google } from 'googleapis'
import { dateValideOuNull } from '../collectors/http.ts'
import { EN_TETES } from './sheets.ts'
import type { OptionsSheets } from './sheets.ts'

/**
 * Convertit un index de colonne 0-based en lettre(s) de colonne Sheets (0 -> A, 25 -> Z, 26 -> AA).
 * Les lettres sont derivees d'EN_TETES, jamais codees en dur : si l'ordre des colonnes
 * du Sheet change, ce fichier suit automatiquement.
 */
function versLettreColonne(index: number): string {
  let n = index + 1
  let lettres = ''
  while (n > 0) {
    const reste = (n - 1) % 26
    lettres = String.fromCharCode(65 + reste) + lettres
    n = Math.floor((n - 1) / 26)
  }
  return lettres
}

const INDEX_DATE = EN_TETES.indexOf('date_detect')
const INDEX_STATUT = EN_TETES.indexOf('statut')
const COL_DATE = versLettreColonne(INDEX_DATE)
const COL_STATUT = versLettreColonne(INDEX_STATUT)
// Decalage des deux colonnes a l'interieur de la plage lue (date_detect..statut),
// pas dans le Sheet entier : la plage commence a COL_DATE, donc l'index 0 de chaque
// ligne lue correspond a date_detect, pas forcement a la colonne A.
const DECALAGE_STATUT = INDEX_STATUT - INDEX_DATE

function client(o: OptionsSheets) {
  const auth = new google.auth.JWT({
    email: o.email,
    key: o.clePrivee,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  })
  return google.sheets({ version: 'v4', auth })
}

/** Journalise une erreur de lecture Sheets de facon exploitable. Ne leve jamais depuis l'appelant. */
function journaliserErreur(contexte: string, err: unknown): void {
  const codeAuth = (err as { code?: number | string })?.code
  if (codeAuth === 401 || codeAuth === 403 || codeAuth === '401' || codeAuth === '403') {
    console.warn(
      `[radar] sheets-lecture : ${contexte} - echec d'authentification/permission (code ${codeAuth}). ` +
        `Verifie que le Sheet est partage avec le compte de service et que la cle privee est valide.`,
    )
    return
  }
  const raison = err instanceof Error ? err.message : String(err)
  console.warn(`[radar] sheets-lecture : ${contexte} - ${raison}`)
}

/**
 * Lit les statuts du Sheet dont date_detect est posterieure a "depuis".
 * Le filtrage par date est fait ICI (a la charge de l'appelant, cf jobs/weekly.ts) :
 * sans lui, le taux de reponse hebdomadaire comparerait deux populations differentes.
 * Ne leve jamais : toute panne reseau/auth est journalisee et renvoie un tableau vide.
 */
export async function lireStatutsDepuis(depuis: Date, o: OptionsSheets): Promise<string[]> {
  try {
    const api = client(o)
    const r = await api.spreadsheets.values.get({
      spreadsheetId: o.sheetId,
      range: `${o.onglet}!${COL_DATE}2:${COL_STATUT}`,
    })

    const lignes = r.data.values ?? []
    const statuts: string[] = []

    for (const ligne of lignes) {
      const brut = ligne[0]
      if (typeof brut !== 'string') continue
      const date = dateValideOuNull(new Date(brut))
      if (!date) continue
      if (date < depuis) continue

      const statut = ligne[DECALAGE_STATUT]
      statuts.push(typeof statut === 'string' ? statut : '')
    }

    return statuts
  } catch (err) {
    journaliserErreur('lireStatutsDepuis', err)
    return []
  }
}
