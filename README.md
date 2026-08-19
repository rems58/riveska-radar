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
- Reddit, via **`search.rss`** uniquement, sur sa propre commande horaire (`reddit`) -
  voir la section dediee ci-dessous
- Annonces Apple/Google elles-memes (`jobs/triggers.ts`, flux distinct des sources
  ci-dessus - detecte une nouvelle exigence de publication avant qu'elle ne deborde
  en vague de questions)

**Facebook et LinkedIn sont volontairement absents.** Ni l'un ni l'autre n'expose d'API de
recherche de posts publics accessible a un outil tiers. La seule facon d'y detecter des
prospects serait de scraper les pages, ce qui viole leurs conditions d'utilisation et
expose le compte utilise a un bannissement pur et simple. Le risque (perte du compte,
image degradee) depasse largement la valeur d'une source supplementaire.

## Reddit : de retour, mais uniquement via `search.rss`

L'**API OAuth de Reddit reste fermee** en creation d'application libre-service
(Responsible Builder Policy, verifie en appel reel : `reddit.com/prefs/apps` refuse
la creation, `/new.json`/`/search.json` renvoient 403, `api/v1/access_token` 401 -
une approbation ecrite explicite est desormais exigee pour tout usage commercial).
Ces chemins (tout `/.json`, l'API OAuth) restent **deliberement hors limites** dans
tout ce projet : ce n'est pas une preference, c'est un controle d'acces ferme qu'on
ne contourne jamais. `src/collectors/reddit.ts` (OAuth) reste dans le code,
desactivee, facultative comme Bluesky (`REDDIT_CLIENT_ID`/`REDDIT_CLIENT_SECRET`/
`REDDIT_USER_AGENT` dans `.env`) : si un accord Reddit arrive un jour, coller les
cles suffit a la reveiller.

**Reddit sert deliberement `search.rss` pour la syndication** - un lecteur de flux
qui le consomme utilise le flux comme prevu, ce n'est pas un contournement du 403.
`src/collectors/reddit-rss.ts` interroge `search.rss` (format Atom) pour une
douzaine de requetes couvrant les 5 langues, dans les memes signaux de douleur que
les autres sources (`filter/keywords.ts`).

### Ce qui est prouve, et ce qui ne l'est pas

**Prouve en appel reel (2026-08-19)** :
- Le flux repond avec de vraies donnees : une recherche "app rejected" a renvoye
  **25 entrees Atom** (22 posts + 3 resultats de subreddits, ignores).
- Le parsing fonctionne : id, auteur, lien, date, contenu correctement extraits sur
  ces 22 posts reels.
- **L'espacement de 60s entre deux requetes est respecte** : mesure directe sur
  l'ecart reel entre deux appels `fetch()` successifs (pas juste lu dans le code) :
  **60,3s puis 60,1s**.

**PAS prouve : la tenue dans la duree a cadence horaire.** Reddit limite par IP et
**escalade** (429 d'abord, puis 403 - blocage temporaire - en cas d'insistance) :
mesure directe, la MEME URL avec le MEME user-agent a echoue en 429 aussi bien en
curl qu'en fetch Node, alors qu'elle avait repondu 200 avec 25 entrees une heure
plus tot. Nos propres mesures cumulees de verification ont mis l'IP de test en
penalite. Nous n'avons donc **pas pu valider un fonctionnement soutenu depuis une
IP non penalisee** - seulement que le collecteur se comporte correctement (bon
espacement, arret propre) face a cette limite.

**Si `reddit` renvoie des 403 en serie, ce n'est pas une panne, c'est la
limitation Reddit qui retombe d'elle-meme.** Ne jamais relancer la commande
manuellement dans ce cas : ca ne ferait qu'entretenir le blocage. Le prochain run
planifie (dans l'heure) reessaiera normalement.

### Comment le collecteur se comporte face a cette limite

- **Jamais de parallelisme** sur cette source, contrairement aux autres : au moins
  60s entre deux requetes, en sequentiel strict.
- **Une commande separee (`reddit`), planifiee une fois par heure** - pas dans
  `radar` (toutes les 15 min, en parallele) : l'y greffer casserait soit la
  cadence de radar, soit la politesse envers Reddit. 12 requetes x 1/min = jusqu'a
  12 minutes par run, largement dans les clous d'une cadence horaire.
- Sur une reponse limitee (**429 ou 403 - le 403 recoit exactement le meme
  traitement que le 429**, c'est la forme escaladee de la meme limite, pas une
  erreur distincte), une seule retentative apres un delai plus long.
- **Si le retry echoue AUSSI** (2 reponses limitees consecutives), **le run
  s'arrete immediatement** sans tenter les requetes restantes - les enchainer
  prolongerait la penalite au lieu de la laisser retomber. Mieux vaut zero post
  ce cycle-ci ; le run suivant (dans l'heure) reessaiera depuis le debut.

Reutilise **exactement le meme pipeline aval** que `radar` (`jobs/pipeline.ts`,
factorise pour les deux jobs) : meme deduplication, memes compteurs d'echecs et
d'abandons, meme verrou. L'id d'un post est construit **de la meme facon** que
par l'API OAuth (`reddit:<id>`, sans le prefixe `t3_` de search.rss) : si l'API
OAuth redevient active un jour en plus de `search.rss`, aucun doublon n'est
possible - c'est la meme base de deduplication qui tranche.

**Le suivi 48h (`recheck`) ne s'applique jamais a Reddit**, quelle que soit la
source qui a collecte le post : compter les reponses d'un post precis exigerait
`<url>.json`, le meme genre de chemin ferme evoque plus haut. Voir le tableau
"Suivi 48h" plus bas.

### `search.rss` est bruyant : verifie et corrige sur des donnees reelles

Une recherche "app rejected" reelle a renvoye 25 entrees (22 posts + 3 resultats
de subreddits, ignores) ; la majorite n'a aucun rapport avec Riveska (Reddit fait
du matching flou, pas une recherche par phrase exacte - "getting is rejection...
dating apps" est remonte pour "app rejected" sans contenir cette phrase). Deux
constats reels sur cet echantillon, traites differemment :

- **Faux positif mesure, laisse tel quel** : un post sans rapport (methodologie
  personnelle d'usage de chatbots IA) passe le prefiltre via le signal
  `vibe coding`, cite en passant sans lien avec une app ou un store. Le signal LLM
  suivant (`enrich/score.ts`, seuil 0-39 = hors sujet) l'aurait rejete pour le prix
  d'un seul appel LLM bon marche - un cout marginal, pas un risque de polluer le
  Sheet. Arbitrage assume : a ce stade du produit, un prospect manque coute plus
  cher qu'un appel LLM gaspille.
- **Faux negatifs mesures, corriges** : deux posts genuinement pertinents de cet
  echantillon ("Initially got rejected due to privacy policy violation...
  reviewer rejected it", "i am guessing this is reason for rejection") ne
  matchaient aucune phrase exacte de `SIGNAUX_DOULEUR` - la prose naturelle de
  Reddit, pas les titres factuels d'un Stack Overflow. `SIGNAUX_DOULEUR`
  (partagee par les 6 collecteurs) a ete elargie avec 4 phrases reprises **mot
  pour mot** de ces posts reels ('got rejected due to', 'reviewer rejected',
  'reason for rejection', 'rejection in app store'), plus leurs traductions
  FR/DE/ES/IT (analogies linguistiques du concept "rejete a cause de"/"motif du
  rejet" - **non verifiees sur des posts reels** dans ces langues, aucun
  echantillon reel collecte au-dela de l'anglais a ce jour). Mesure sur les 22
  posts reels : **1 candidat avant -> 3 apres**, les deux prospects manques sont
  desormais retenus, le faux positif `vibe coding` reste le seul bruit. Verifie
  qu'aucun des nouveaux mots-cles ne recoupe les fixtures de test des 5 autres
  collecteurs (aucune correspondance trouvee) : pas de derive de volume attendue
  ailleurs, mais non mesuree en reel faute de large echantillon pour ces sources.

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
npm run radar     # sources paralleles (HN, SO, Mastodon, Bluesky) + pipeline complet
npm run reddit    # Reddit via search.rss, sequentiel a 1 req/min - a part de radar
npm run recheck   # relance 48h : signale les prospects toujours sans reponse
npm run triggers  # surveille les annonces Apple/Google (nouvelles exigences)
npm run weekly    # bilan hebdomadaire du taux de reponse
npm run sante     # "est-ce que tout va bien ?" en quelques lignes - lecture seule
npm test          # suite de tests (vitest)
npm run typecheck # verification TypeScript stricte, sans emission
```

Equivalent direct sans passer par npm : `node src/index.ts radar` (idem pour `reddit`,
`recheck`, `triggers`, `weekly`, `sante`). `reddit` prend jusqu'a une douzaine de minutes
(debit impose par Reddit, voir plus haut) - c'est normal, ce n'est pas un blocage.

`sante` est la seule commande qui ne se planifie pas : elle se lance a la main quand on
veut savoir ou en est le radar (voir Depannage). Elle est aussi la seule a accepter un
drapeau : `node src/index.ts sante --notif`.

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
| Reddit | **jamais**, meme collecte via `search.rss` - voir ci-dessous |

Bluesky et Mastodon n'exposent pas d'equivalent simple et sans cle pour compter les
reponses a un post precis : ces prospects ne declenchent jamais la
notification "toujours sans reponse apres 48h", meme s'ils restent effectivement sans
reponse. Ce n'est pas un bug silencieux : c'est une limite connue, documentee ici plutot
que de laisser croire a une couverture universelle.

**Reddit n'aura jamais de suivi 48h, meme collecte active.** Compter les reponses d'un
post precis exigerait `<url>.json` - le meme genre de chemin que `/new.json`/`/search.json`,
que Reddit garde deliberement ferme (voir "Reddit : de retour, mais uniquement via
search.rss" plus haut). C'est une contrainte permanente de ce projet, pas une limite
technique temporaire : `compterReponsesReddit()` renvoie -1 inconditionnellement, sans
appel reseau, quelle que soit la source qui a collecte le post.

## Planification Windows

Le radar doit tourner en continu. Sous Windows, le Planificateur de taches s'en charge :

```powershell
# Depuis riveska-radar/, dans un PowerShell ouvert en ADMINISTRATEUR
.\scripts\installer-taches.ps1
```

Cela enregistre cinq taches :

| Tache | Frequence |
|---|---|
| `RiveskaRadar-Radar` | toutes les 15 minutes |
| `RiveskaRadar-Reddit` | toutes les heures - jamais plus souvent (debit Reddit) |
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

Toutes les sources de collecte actives (Hacker News, Stack Overflow, Bluesky, Mastodon,
Reddit via `search.rss`) et Telegram sont gratuites - le mot de passe d'application
Bluesky aussi. Google Sheets
est gratuit dans les volumes de cet outil.
Seul le LLM (OpenRouter) coute reellement : de l'ordre de **3 a 8 EUR par mois** selon le
volume de posts collectes et le modele choisi (`OPENROUTER_MODEL`).

## Depannage

### D'abord : `node src/index.ts sante`

Une panne silencieuse - Sheet devenu inaccessible, cle OpenRouter epuisee, tache qui ne
se declenche plus - ne se voit autrement qu'en constatant l'absence de prospects,
parfois plusieurs jours trop tard. Cette commande repond en quelques secondes a la seule
question qui compte, et **dit quoi faire** quand quelque chose cloche.

```bash
node src/index.ts sante            # ou : npm run sante
node src/index.ts sante --notif    # + un vrai message de test sur Telegram
```

Un marqueur par ligne : `OK` (rien a faire) · `!!` (probleme reel, la ligne dit quoi
faire) · `--` (desactive ou non applicable - une information, pas un probleme). Le
**code de sortie vaut 1 des qu'un `!!` apparait**, 0 sinon : de quoi la brancher plus
tard sur une alerte automatique.

Ce qu'elle regarde, un bloc par domaine :

| Bloc | Ce qui est verifie |
|---|---|
| Configuration | le `.env` se charge et chaque variable obligatoire passe la meme validation qu'un vrai run ; les sources facultatives eteintes (Reddit OAuth, Bluesky) apparaissent en `--` |
| Google Sheets | acces reel, onglet present, nombre de prospects, date du plus recent |
| Telegram | le bot repond (`getMe`) - **aucun message n'est envoye** sans `--notif` |
| OpenRouter | cle valide et credit restant : c'est le seul poste qui coute de l'argent, et une cle epuisee arrete le scoring **sans** arreter la collecte |
| Base locale | `radar.db` lisible, posts vus, dernier ajout, echecs en attente de retry, abandons definitifs des 7 derniers jours |
| Verrous | un verrou present est normal pendant un run, suspect s'il est vieux ou laisse par un process disparu |
| Taches planifiees | Windows seulement : pour chaque `RiveskaRadar-*`, dernier resultat et prochaine execution |
| Logs | date de derniere ecriture de chaque `logs/*.log` et derniere fin de run qu'il contient |

**Le signal le plus utile est le bloc Logs.** Un `logs/radar.log` fige depuis 3 heures
alors que le job tourne toutes les 15 minutes est la preuve qu'une tache ne se declenche
plus - c'est exactement ce qu'aucune autre verification ne montre.

Ce bloc recoupe ce que les blocs Verrous et Taches ont deja etabli, pour qu'un `!!`
veuille toujours dire quelque chose : un log sans ligne de fin **pendant qu'un run
tourne** (verrou tenu, ou tache declaree en cours par le Planificateur) reste `OK`, et
un log absent pour une tache **jamais declenchee** est un `--` - l'etat normal des
premieres heures apres l'installation, et l'etat permanent d'une tache hebdomadaire
installee en milieu de semaine. Restent en `!!` les deux cas qui signalent vraiment
quelque chose : un log absent pour une tache qui s'est deja executee, et un log sans
fin de run alors qu'aucun run ne tourne.

Trois garanties, par construction :

- **Elle n'appelle jamais Reddit.** Le budget tolere est d'une requete par minute (voir
  plus haut) : le depenser pour une verification prolongerait la penalite au lieu de la
  laisser retomber. L'etat de Reddit se lit dans `logs/reddit.log`, point.
- **Elle ne fait aucun appel LLM de scoring** : verifier la cle interroge l'endpoint de
  compte d'OpenRouter, gratuit. La verification ne coute rien.
- **Elle ne modifie rien** : aucune ecriture dans le Sheet, aucune purge, aucun verrou
  pose (c'est volontaire : elle doit pouvoir tourner *pendant* un run pour en rendre
  compte).

Deux `--` sont normaux sur une machine qui n'est pas le mini PC de production :
"aucune tache RiveskaRadar-*" et "aucun dossier logs/" - les taches et leurs logs
n'existent que la ou tourne le Planificateur.

Enfin, un code de resultat de tache merite d'etre connu : **`267011` signifie "jamais
declenchee", ce n'est pas un echec** (c'est l'etat normal des premieres heures apres
l'installation, et l'etat permanent d'une tache hebdomadaire installee un mardi). La
commande l'affiche en `OK`, jamais en erreur.

### Autres problemes

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

**`reddit` renvoie 0 posts, les logs montrent des 429/403 sur `search.rss`**
Ce n'est pas une panne : Reddit limite par IP et **escalade** (429 d'abord, puis 403
en cas d'insistance) - mesure directe, la meme URL avec le meme user-agent a echoue
en 429 aussi bien en curl qu'en fetch Node, une heure apres avoir repondu 200. Le
collecteur respecte scrupuleusement 1 requete/minute (espacement mesure : 60,1s et
60,3s) et **s'arrete de lui-meme** des qu'une requete reste limitee apres son retry
(2 reponses 429/403 consecutives), sans tenter les requetes restantes - il n'y a
donc rien a corriger cote code. La limitation retombe d'elle-meme avec le temps ;
le prochain run planifie (dans l'heure) reessaiera normalement.
**Ne JAMAIS relancer `reddit` manuellement dans ce cas**, ni en boucle pour
"tester" : chaque appel supplementaire prolonge la penalite au lieu de la laisser
retomber - meme un simple `curl` de verification isole compte pour Reddit.

**Telegram ne notifie jamais**
1. Verifier que `TELEGRAM_CHAT_ID` est correct : relancer `getUpdates` (voir tableau
   d'identifiants ci-dessus) apres avoir envoye un nouveau message au bot - le chat_id
   ne change pas, mais une premiere configuration ratee est la cause la plus frequente.
2. Le bot doit avoir recu au moins un message de la part de l'utilisateur avant de
   pouvoir lui envoyer quoi que ce soit (limitation de l'API Telegram elle-meme).
3. Les logs affichent `[radar] telegram : reponse HTTP <code> ...` en cas d'echec, avec
   le token toujours masque.
