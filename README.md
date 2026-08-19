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

- Hacker News
- Stack Overflow
- Mastodon
- Bluesky (necessite `BLUESKY_ID`/`BLUESKY_APP_PASSWORD`, facultatifs - voir tableau
  ci-dessous ; sans eux, la source se desactive proprement)
- Annonces Apple/Google elles-memes (`jobs/triggers.ts`, flux distinct des sources
  ci-dessus - detecte une nouvelle exigence de publication avant qu'elle ne deborde
  en vague de questions)

**Facebook et LinkedIn sont volontairement absents.** Ni l'un ni l'autre n'expose d'API de
recherche de posts publics accessible a un outil tiers. La seule facon d'y detecter des
prospects serait de scraper les pages, ce qui viole leurs conditions d'utilisation et
expose le compte utilise a un bannissement pur et simple. Le risque (perte du compte,
image degradee) depasse largement la valeur d'une source supplementaire.

**Reddit n'est plus une source active : l'API a ferme la creation d'applications en
libre-service.** Verifie en appel reel (2026-08-19) : `reddit.com/prefs/apps` refuse la
creation, `/new.json` et `/search.json` renvoient 403 meme avec un user-agent de
navigateur, et Reddit exige desormais une approbation ecrite explicite pour tout usage
commercial - ce que ce radar est. La source reste dans le code (`src/collectors/reddit.ts`,
facultative comme Bluesky, `REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET`/`REDDIT_USER_AGENT`
dans `.env`) : si un accord Reddit arrive un jour, coller les cles suffit a la reveiller,
aucun autre changement necessaire. Sans elles, `collecteursParDefaut()` exclut Reddit de
la liste des sources plutot que d'echouer au demarrage.

**Un flux "forums" (forums.expo.dev + developer.apple.com/forums) a existe puis a ete
retire.** Verifie en appel reel : les deux flux sont morts - Expo redirige entierement
vers Discord (aucune API RSS n'y existe), et Apple bloque les requetes automatisees
derriere une verification anti-bot. Aucun flux de remplacement fonctionnel n'a ete
trouve pour ce role. Si tu en trouves un a l'avenir, il se cablerait dans
`collecteursParDefaut()` (`src/collectors/index.ts`).

Une source qui renvoie 0 post alors que d'autres en renvoient est un signal fort de
flux casse (redirection HTML, changement de format d'API...) : elle est journalisee
immediatement et comptee dans le bilan hebdomadaire (`weekly`), pour qu'une panne
comme celle du flux Expo ci-dessus ne dure jamais plusieurs mois sans etre vue.

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
| `TELEGRAM_BOT_TOKEN` | Parler a [@BotFather](https://t.me/BotFather) sur Telegram, `/newbot`, suivre les instructions. Le token est renvoye a la fin. |
| `TELEGRAM_CHAT_ID` | Envoyer un premier message au bot cree, puis appeler `https://api.telegram.org/bot<TOKEN>/getUpdates` dans un navigateur : le `chat.id` apparait dans la reponse JSON. |
| `GOOGLE_SA_EMAIL` / `GOOGLE_SA_PRIVATE_KEY` | Dans un projet Google Cloud (nommer le projet `riveska`) : IAM & Admin > Comptes de service > Creer > generer une cle JSON. `email` et `private_key` viennent de ce fichier JSON. **`GOOGLE_SA_PRIVATE_KEY` DOIT etre entre guillemets doubles**, tel quel sur une seule ligne, `\n` litteraux (pas de vrais retours a la ligne) - exemple exact : `GOOGLE_SA_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\nMIIEvQ...\n-----END PRIVATE KEY-----\n"`. **Sans les guillemets, la valeur est coupee au premier retour a la ligne** (mesure : 27 caracteres au lieu de ~1700, `BEGIN` present mais `END` absent) et devient invalide sans qu'aucune erreur ne le signale au moment de coller - `config.ts` bloque desormais au demarrage avec un message explicite si `BEGIN`/`END` sont absents apres lecture, mais autant l'eviter directement. **Il faut aussi activer l'API Google Sheets** sur ce meme projet (API et services > Activer des API > "Google Sheets API"), sinon toute requete echoue avec une erreur 403. |
| `SHEET_ID` | L'identifiant dans l'URL du Google Sheet : `https://docs.google.com/spreadsheets/d/<SHEET_ID>/edit`. Le Sheet doit exister au prealable. |
| (partage du Sheet) | **Partager le Sheet en acces Editeur avec l'email du compte de service** (`GOOGLE_SA_EMAIL`, ex. `xxx@riveska.iam.gserviceaccount.com`). Sans ce partage, toutes les ecritures/lectures echouent silencieusement (voir Depannage). |
| `OPENROUTER_API_KEY` | [openrouter.ai/keys](https://openrouter.ai/keys), creer une cle. |
| `BLUESKY_ID` / `BLUESKY_APP_PASSWORD` | **Facultatifs.** Reglages Bluesky > Confidentialite et securite > Mots de passe d'application > en creer un (gratuit, jamais le mot de passe du compte lui-meme). `BLUESKY_ID` est ton identifiant (`toi.bsky.social`). Necessaires depuis que la recherche Bluesky non authentifiee est fermee (verifie : 403 sur l'endpoint public). Absents ou incomplets -> la source Bluesky se desactive proprement (log explicite, aucune erreur), les autres sources continuent normalement. |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` / `REDDIT_USER_AGENT` | **Facultatifs, source actuellement injoignable.** [reddit.com/prefs/apps](https://www.reddit.com/prefs/apps) refuse desormais la creation d'applications de type **script** sans accord ecrit prealable (usage commercial). Si un accord arrive un jour : l'ID est sous le nom de l'app, le secret est le champ "secret", `REDDIT_USER_AGENT` est une chaine libre type `riveska-radar/0.1 by /u/TonPseudo`. Absents -> la source Reddit se desactive proprement (log explicite au demarrage), les autres sources continuent normalement. |

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

Le fichier `.env` est charge automatiquement (via `process.loadEnvFile`, natif depuis
Node 20.12) a chaque lancement d'une commande, depuis la racine du projet - peu importe
le repertoire courant. Une variable deja presente dans l'environnement du process (lancement
manuel, CI) n'est jamais ecrasee par le contenu du `.env`.

Chaque commande pose un verrou de process (fichier `<commande>.lock` a la racine, ex.
`radar.lock`) pendant son execution et le libere en fin de run. Si le run precedent de la
meme commande tourne encore (radar est relance toutes les 15 minutes par le Planificateur
et peut legitimement prendre plus longtemps : jusqu'a 2 appels LLM par candidat, plus
~40 appels Reddit sequentiels si cette source redevient un jour active), le nouveau
lancement s'arrete immediatement avec un avertissement
plutot que de scorer/facturer deux fois les memes posts. Un verrou dont le process n'existe
plus (crash, redemarrage) est automatiquement considere perime au lancement suivant - il
n'y a jamais besoin de le supprimer a la main. Le verrou se rafraichit automatiquement
toutes les 5 minutes tant que le run est en cours (pour ne jamais paraitre perime a tort
sur un run legitimement long) et verifie qu'il s'appartient encore avant de se liberer.

Un post abandonne definitivement (3 echecs techniques consecutifs a la meme etape -
scoring, enrichissement ou ecriture Sheet) declenche desormais une notification Telegram
avec son URL, pour pouvoir le rattraper a la main : avant, un post deja facture en LLM
pouvait disparaitre sans aucun temoin.

## Suivi 48h (`recheck`) : couverture partielle, assumee

`recheck` compte les reponses recues par chaque prospect 48h apres detection, pour
signaler ceux restes sans reponse. Cette verification n'est possible que sur les sources
qui exposent une API publique adaptee :

| Source | Suivi 48h |
|---|---|
| Hacker News | oui (enfants directs de l'item, API Algolia) |
| Stack Overflow | oui (`answer_count`, API StackExchange) |
| Bluesky | non |
| Mastodon | non |
| Reddit | non applicable - source desactivee (voir "Sources surveillees") |

Bluesky et Mastodon n'exposent pas d'equivalent simple et sans cle pour compter les
reponses a un post precis : ces prospects ne declenchent jamais la
notification "toujours sans reponse apres 48h", meme s'ils restent effectivement sans
reponse. Ce n'est pas un bug silencieux : c'est une limite connue, documentee ici plutot
que de laisser croire a une couverture universelle. Le code de suivi Reddit
(`jobs/recheck-compteurs.ts`) reste en place et se reactiverait avec la source si un
accord Reddit arrive un jour, mais degrade proprement en "inconnu" tant qu'elle est
desactivee.

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
`installer-taches.ps1` enregistre chaque tache pour qu'elle lance `scripts/lancer-job.ps1`
(pas `node` directement) : ce petit script redirige la sortie de la commande vers son
propre fichier dans `riveska-radar/logs/` (`radar.log`, `recheck.log`, etc., en mode
ajout - le Planificateur de taches ne conserve la sortie d'aucun process qu'il lance
directement, c'est la seule facon de diagnostiquer un run rate sans surveillance humaine
en direct) et applique une rotation simple : au-dela de 5 Mo, l'ancien contenu est archive
en `<commande>.log.1` (une seule generation, ecrasee a chaque rotation) et le job repart
d'un fichier vide - le disque d'un mini PC ne sature jamais sur un job relance toutes les
15 minutes sans surveillance. Ces fichiers sont ouvrables avec Notepad ou VS Code
(encodage UTF-16LE avec BOM - octets verifies en execution reelle - c'est le defaut
de PowerShell 5.1 pour `*>>` comme pour `Out-File` sans `-Encoding` explicite ; les
deux chemins d'ecriture de `lancer-job.ps1` restent volontairement sur ce meme defaut
pour ne jamais melanger deux encodages dans le meme fichier).

`lancer-job.ps1` resout le chemin de `node` a **chaque execution**, pas seulement a
l'installation : une mise a jour de Node qui change son emplacement ne casse donc pas les
taches deja enregistrees. Si Node devient introuvable (jamais installe, ou absent du PATH
systeme utilise par le Planificateur - qui peut differer du PATH d'une session interactive),
le job echoue proprement et l'ecrit dans son fichier de log plutot que d'echouer en silence.

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

Aucune des deux ne stocke jamais d'email ni de nom civil : uniquement le **pseudo**
public de l'auteur et ce qu'il a ecrit publiquement. Mais les deux endroits qui
stockent des donnees suivent des regles DIFFERENTES - c'est important de le savoir :

- **Base locale (`radar.db`, SQLite)** : id du post, pseudo, URL, score, compteurs
  internes. **Purgee automatiquement** selon `RETENTION_DAYS` (90 jours par defaut) -
  `purger()` tourne a chaque run `radar`.
- **Google Sheet** : les 13 colonnes decrites plus haut, dont un extrait de 300
  caracteres du post d'origine, sa traduction, le brouillon de reponse et tes propres
  notes. **N'est PAS purge automatiquement.** `RETENTION_DAYS` ne s'applique qu'a la
  base locale - le Sheet est ton outil de travail (CRM), les lignes y restent tant
  que tu ne les supprimes pas toi-meme.

Un nettoyage automatique du Sheet n'a volontairement pas ete implemente : supprimer
des lignes dans ton outil de travail sans confirmation humaine est plus risque que de
laisser l'historique s'accumuler (perte accidentelle d'un prospect encore utile en
cours de reponse, concurrence avec tes propres editions manuelles/mobiles au moment
de la suppression) - un choix delibere, pas un oubli. Si tu veux purger le Sheet,
trie par `date_detect` et supprime les lignes anciennes a la main de temps en temps.

**Toujours repondre publiquement, dans le fil du post - jamais en message prive non
sollicite.** Un message prive non sollicite a but commercial constitue du demarchage
electronique au sens de l'article L34-5 du code des postes et des communications
electroniques, et fait courir le risque d'un bannissement de la plateforme. Une reponse
publique, elle, est en plus lue par tous les futurs visiteurs du meme fil qui rencontrent
le meme probleme - elle vaut plus qu'un message prive, pas moins.

## Cout mensuel

Toutes les sources de collecte actives (Hacker News, Stack Overflow, Bluesky, Mastodon)
et Telegram sont gratuites - le mot de passe d'application Bluesky aussi. Google Sheets
est gratuit dans les volumes de cet outil.
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

**`installer-taches.ps1` s'arrete avec "Node introuvable dans le PATH"**
Node n'est pas installe, ou n'est pas dans le PATH utilise par ce PowerShell. Installer
Node depuis [nodejs.org](https://nodejs.org), verifier `node --version` dans un **nouveau**
terminal (le PATH ne se met a jour que dans les nouvelles sessions), puis relancer le
script. Un job planifie deja enregistre qui perd Node en cours de route (desinstallation,
deplacement) l'ecrit dans son propre log au lieu d'echouer en silence - inutile de
relancer `installer-taches.ps1` pour une simple mise a jour de Node au meme emplacement.

**Telegram ne notifie jamais**
1. Verifier que `TELEGRAM_CHAT_ID` est correct : relancer `getUpdates` (voir tableau
   d'identifiants ci-dessus) apres avoir envoye un nouveau message au bot - le chat_id
   ne change pas, mais une premiere configuration ratee est la cause la plus frequente.
2. Le bot doit avoir recu au moins un message de la part de l'utilisateur avant de
   pouvoir lui envoyer quoi que ce soit (limitation de l'API Telegram elle-meme).
3. Les logs affichent `[radar] telegram : reponse HTTP <code> ...` en cas d'echec, avec
   le token toujours masque.
