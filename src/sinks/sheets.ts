import { google } from 'googleapis'
import type { EnrichedPost } from '../types.ts'

/** Borne defensive : Sheets rejette au-dela de 50000 caracteres/cellule, ce qui ferait perdre toute la ligne. */
const TAILLE_CELLULE_MAX = 40_000

/** Ordre des colonnes du Sheet. Toute modification doit rester synchrone avec versLigne(). */
export const EN_TETES = [
  'date_detect', 'source', 'lien', 'auteur', 'langue', 'extrait_orig',
  'traduction_fr', 'probleme', 'score', 'brouillon', 'statut', 'notes', 'reaction',
] as const

function borner(valeur: string): string {
  return valeur.length > TAILLE_CELLULE_MAX ? valeur.slice(0, TAILLE_CELLULE_MAX) : valeur
}

export function versLigne(p: EnrichedPost): string[] {
  return [
    new Date().toISOString(),
    p.source,
    p.url,
    p.auteur,
    p.langue,
    p.contenu.slice(0, 300),
    p.traductionFr,
    p.probleme,
    String(p.score),
    p.brouillon,
    'nouveau',
    '',
    '',
  ].map(borner)
}

export interface OptionsSheets {
  email: string
  clePrivee: string
  sheetId: string
  onglet: string
}

/**
 * Entoure le nom de l'onglet de guillemets simples (syntaxe A1 standard), en
 * echappant un guillemet simple interne en le doublant (regle Google Sheets).
 * Sans ca, un SHEET_TAB contenant un espace (ex: "Prospects Riveska") produit une
 * plage invalide ("Prospects Riveska!A:M") : la requete echoue en 400 et TOUS les
 * prospects du run sont perdus en silence (echec technique -> abandon apres 3 runs).
 * Toujours quoter, y compris pour un nom simple sans espace : accepte dans tous les cas.
 */
export function citerOnglet(onglet: string): string {
  return `'${onglet.replace(/'/g, "''")}'`
}

function client(o: OptionsSheets) {
  const auth = new google.auth.JWT({
    email: o.email,
    key: o.clePrivee,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  })
  return google.sheets({ version: 'v4', auth })
}

/**
 * Journalise une erreur Sheets de facon exploitable. Les erreurs 401/403 sont
 * le cas le plus probable au premier lancement (cle service account manquante,
 * onglet non partage avec le compte de service) : on les distingue explicitement.
 */
function journaliserErreur(contexte: string, err: unknown): void {
  const codeAuth = (err as { code?: number | string })?.code
  if (codeAuth === 401 || codeAuth === 403 || codeAuth === '401' || codeAuth === '403') {
    console.warn(
      `[radar] sheets : ${contexte} - echec d'authentification/permission (code ${codeAuth}). ` +
        `Verifie que le Sheet est partage avec le compte de service et que la cle privee est valide.`,
    )
    return
  }
  const raison = err instanceof Error ? err.message : String(err)
  console.warn(`[radar] sheets : ${contexte} - ${raison}`)
}

/** Ecrit les en-tetes si l'onglet est vide. Idempotent. Ne leve jamais. */
export async function assurerEnTetes(o: OptionsSheets): Promise<void> {
  try {
    const api = client(o)
    const r = await api.spreadsheets.values.get({
      spreadsheetId: o.sheetId,
      range: `${citerOnglet(o.onglet)}!A1:M1`,
    })
    if (r.data.values && r.data.values.length > 0) return
    await api.spreadsheets.values.update({
      spreadsheetId: o.sheetId,
      range: `${citerOnglet(o.onglet)}!A1`,
      // RAW volontaire : USER_ENTERED interpreterait une cellule commencant par
      // =, +, - ou @ comme une formule. Le contenu vient de posts publics ecrits
      // par des tiers, donc un vecteur d'injection de formule. Ne pas changer.
      valueInputOption: 'RAW',
      requestBody: { values: [[...EN_TETES]] },
    })
  } catch (err) {
    journaliserErreur('assurerEnTetes', err)
  }
}

/**
 * Ajoute une ligne par prospect. Renvoie le numero de la premiere ligne ecrite,
 * ou null si la liste est vide (aucun appel reseau) ou en cas d'echec.
 * Un prospect perdu vaut mieux qu'un run plante : ne leve jamais.
 */
export async function ajouterLignes(posts: EnrichedPost[], o: OptionsSheets): Promise<number | null> {
  if (posts.length === 0) return null
  try {
    const api = client(o)
    const r = await api.spreadsheets.values.append({
      spreadsheetId: o.sheetId,
      range: `${citerOnglet(o.onglet)}!A:M`,
      // RAW volontaire : voir commentaire dans assurerEnTetes. Ne pas passer en USER_ENTERED.
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: posts.map(versLigne) },
    })
    // updatedRange ressemble a "Prospects!A47:M48"
    const m = r.data.updates?.updatedRange?.match(/![A-Z]+(\d+)/)
    return m?.[1] ? Number(m[1]) : null
  } catch (err) {
    journaliserErreur('ajouterLignes', err)
    return null
  }
}
