# Riveska Radar

Outil interne qui detecte, 24/7, les developpeurs bloques sur la publication de leur
application mobile (rejet App Store/Play Store, galere de testeurs, exigence Apple/Google
mal comprise...) et les fait remonter dans un Google Sheet, avec un brouillon de reponse
pret a relire.

## Regle de conception centrale

**Le radar ne publie et n'envoie jamais rien automatiquement.** Il detecte, note, traduit
et prepare un brouillon - c'est tout. Chaque brouillon est relu et reecrit par un humain
avant tout envoi. Aucune commande de ce projet ne poste de reponse, de message prive ni
de commentaire a la place de quelqu'un.

## Sources surveillees

- Reddit (API officielle, plusieurs subreddits dev mobile)
- Hacker News
- Stack Overflow
- Bluesky
- Mastodon
- Flux RSS/forums (dont les annonces Apple/Google elles-memes, pour detecter les nouvelles
  exigences de publication avant qu'elles ne debordent en vague de questions)

**Facebook et LinkedIn sont volontairement absents.** Ni l'un ni l'autre n'expose d'API de
recherche de posts publics accessible a un outil tiers. La seule facon d'y detecter des
prospects serait de scraper les pages, ce qui viole leurs conditions d'utilisation et
expose le compte utilise a un bannissement pur et simple. Le risque (perte du compte,
image degradee) depasse largement la valeur d'une source supplementaire.

## Installation

```bash
npm install
cp .env.example .env
```

Puis remplir `.env` avec les identifiants ci-dessous.

Node 24 execute directement les fichiers `.ts` (aucune compilation ni ts-node necessaire).

## Ou obtenir chaque identifiant

| Variable | Ou l'obtenir |
|---|---|
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` | [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) - creer une application de type **script**. L'ID est sous le nom de l'app, le secret est le champ "secret". |
| `REDDIT_USER_AGENT` | Chaine libre, format recommande `riveska-radar/0.1 by /u/TonPseudo` (Reddit bannit les user-agents generiques). |
| `TELEGRAM_BOT_TOKEN` | Parler a [@BotFather](https://t.me/BotFather) sur Telegram, `/newbot`, suivre les instructions. Le token est renvoye a la fin. |
| `TELEGRAM_CHAT_ID` | Envoyer un premier message au bot cree, puis appeler `https://api.telegram.org/bot<TOKEN>/getUpdates` dans un navigateur : le `chat.id` apparait dans la reponse JSON. |
| `GOOGLE_SA_EMAIL` / `GOOGLE_SA_PRIVATE_KEY` | Dans un projet Google Cloud (nommer le projet `riveska`) : IAM & Admin > Comptes de service > Creer > generer une cle JSON. `email` et `private_key` viennent de ce fichier JSON (coller la cle avec ses `\n` echappes, tel quel). **Il faut aussi activer l'API Google Sheets** sur ce meme projet (API et services > Activer des API > "Google Sheets API"), sinon toute requete echoue avec une erreur 403. |
| `SHEET_ID` | L'identifiant dans l'URL du Google Sheet : `https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit`. Le Sheet doit exister au prealable. |
| (partage du Sheet) | **Partager le Sheet en acces Editeur avec l'email du compte de service** (`GOOGLE_SA_EMAIL`, ex. `xxx@riveska.iam.gserviceaccount.com`). Sans ce partage, toutes les ecritures/lectures echouent silencieusement (voir Depannage). |
| `OPENROUTER_API_KEY` | [openrouter.ai/keys](https://openrouter.ai/keys), creer une cle. |

## Commandes npm

```bash
npm run radar     # collecte + score + enrichit + ecrit le Sheet + notifie Telegram
npm run recheck   # relance 48h : signale les prospects toujours sans reponse
npm run triggers  # surveille les annonces Apple/Google (nouvelles exigences)
npm run weekly    # bilan hebdomadaire du taux de reponse
npm test          # suite de tests (vitest)
npm run typecheck # verification TypeScript stricte, sans emission
```

Equivalent direct sans passer par npm : `node src/index.ts radar` (idem pour `recheck`,
`triggers`, `weekly`).

La base locale `radar.db` (SQLite) est creee automatiquement a la racine du projet au
premier lancement - elle memorise les posts deja vus pour ne jamais les retraiter deux
fois (et ne jamais refacturer un appel LLM deja paye).

## Planification Windows

Le radar doit tourner en continu. Sous Windows, le Planificateur de taches s'en charge :

```powershell
# Depuis riveska-radar/, dans un PowerShell ouvert en ADMINISTRATEUR
.\scripts\installer-taches.ps1
```

Cela enregistre quatre taches :

| Tache | Frequence |
|---|---|
| `RiveskaRadar-Radar` | toutes les 15 minutes |
| `RiveskaRadar-Recheck` | toutes les 6 heures |
| `RiveskaRadar-Triggers` | tous les jours a 9h |
| `RiveskaRadar-Weekly` | le lundi a 9h |

Chaque tache demarre meme sur batterie et se relance jusqu'a 3 fois en cas d'echec.
Le Planificateur de taches ne conserve pas la sortie console d'un process lance
directement : le script redirige donc chaque job vers son propre fichier dans
`riveska-radar/logs/` (`radar.log`, `recheck.log`, etc.), en mode ajout - c'est la
seule facon de diagnostiquer un run rate sans surveillance humaine en direct.

**Verifier l'installation :**

```powershell
Get-ScheduledTask -TaskName 'RiveskaRadar-*'
```

**Desinstaller les quatre taches :**

```powershell
Get-ScheduledTask -TaskName 'RiveskaRadar-*' | Unregister-ScheduledTask -Confirm:$false
```

## Le Google Sheet

`assurerEnTetes` ecrit automatiquement les 13 colonnes suivantes au premier lancement,
dans cet ordre :

`date_detect · source · lien · auteur · langue · extrait_orig · traduction_fr · probleme ·
score · brouillon · statut · notes · reaction`

### Cycle des statuts

Chaque prospect arrive avec `statut = nouveau`. La colonne se modifie **a la main**, y
compris depuis l'app mobile Google Sheets :

```
nouveau -> lu -> repondu
              -> ignore
```

- `lu` : quelqu'un a regarde le brouillon (facultatif, purement indicatif).
- `repondu` : la reponse (relue et reecrite par un humain) a ete postee.
- `ignore` : ce prospect ne sera pas contacte.

Le job `weekly` compte ces statuts (insensible a la casse et aux espaces de bord) pour
calculer un taux de reponse hebdomadaire.

## Reglages ajustables (dans `.env`)

| Variable | Effet | Defaut |
|---|---|---|
| `SCORE_THRESHOLD` | Score minimum (0-100) pour qu'un post soit retenu et ecrit au Sheet. | `60` |
| `MAX_POST_AGE_DAYS` | Age maximum d'un post pour rester eligible (au-dela, plus personne ne lira une reponse). | `30` |
| `RETENTION_DAYS` | Duree de conservation d'un post dans la base locale avant purge automatique. | `90` |

## Donnees personnelles

Le radar ne stocke que ce qui est deja public : le **pseudo** de l'auteur et l'**URL**
du post. Jamais d'adresse email, jamais de nom civil. La base locale est purgee
automatiquement selon `RETENTION_DAYS`.

**Toujours repondre publiquement, dans le fil du post - jamais en message prive non
sollicite.** Un message prive non sollicite a but commercial constitue du demarchage
electronique au sens de l'article L34-5 du code des postes et des communications
electroniques, et fait courir le risque d'un bannissement de la plateforme. Une reponse
publique, elle, est en plus lue par tous les futurs visiteurs du meme fil qui rencontrent
le meme probleme - elle vaut plus qu'un message prive, pas moins.

## Cout mensuel

Toutes les sources de collecte (Reddit, Hacker News, Stack Overflow, Bluesky, Mastodon,
RSS) et Telegram sont gratuites. Google Sheets est gratuit dans les volumes de cet outil.
Seul le LLM (OpenRouter) coute reellement : de l'ordre de **3 a 8 EUR par mois** selon le
volume de posts collectes et le modele choisi (`OPENROUTER_MODEL`).

## Depannage

**`npm install` echoue sur `better-sqlite3`**
Ce paquet compile un module natif et a besoin des outils de build C++ de Windows.
Installer les "Build Tools for Visual Studio" (composant "Desktop development with C++"),
ou plus simplement `npm install --global windows-build-tools` (ancienne methode) /
`npm install --global @vscode/windows-ctypes` selon la version de Node. Le plus fiable
reste d'installer Visual Studio Build Tools puis de relancer `npm install`.

**Le Sheet reste vide apres un run `radar`**
Verifier dans cet ordre :
1. Le Sheet est bien **partage en acces Editeur** avec l'email exact du compte de
   service (`GOOGLE_SA_EMAIL`) - une simple visibilite "peut consulter" ne suffit pas.
2. L'**API Google Sheets est activee** sur le projet Google Cloud (`riveska`) - sans ca,
   chaque appel echoue en 403 des la premiere requete.
3. `SHEET_ID` correspond bien a l'identifiant dans l'URL du Sheet, pas a son nom.
4. Les logs (`logs/radar.log` en planifie, ou la sortie console en lancement manuel)
   contiennent un avertissement `[radar] sheets : ...` qui precise la cause exacte.

**Telegram ne notifie jamais**
1. Verifier que `TELEGRAM_CHAT_ID` est correct : relancer `getUpdates` (voir tableau
   d'identifiants ci-dessus) apres avoir envoye un nouveau message au bot - le chat_id
   ne change pas, mais une premiere configuration ratee est la cause la plus frequente.
2. Le bot doit avoir recu au moins un message de la part de l'utilisateur avant de
   pouvoir lui envoyer quoi que ce soit (limitation de l'API Telegram elle-meme).
3. Les logs affichent `[radar] telegram : reponse HTTP <code> ...` en cas d'echec, avec
   le token toujours masque.
