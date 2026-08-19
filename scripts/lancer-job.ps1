# scripts/lancer-job.ps1
# Lance une commande du radar (radar|recheck|triggers|weekly) en redirigeant sa
# sortie vers logs/<commande>.log, avec rotation simple si ce fichier depasse 5 Mo.
# Appele par les taches planifiees enregistrees par installer-taches.ps1 - pour un
# lancement manuel ponctuel, `node src/index.ts <commande>` suffit et va plus vite.

param(
    [Parameter(Mandatory = $true)]
    [string]$Commande
)

# ATTENTION : ne jamais mettre $ErrorActionPreference = 'Stop' ici. Node ecrit ses
# avertissements/erreurs sur stderr (console.warn/console.error) ; sous PowerShell
# 5.1, avec ErrorActionPreference = Stop, chaque ligne de stderr d'un process
# externe est enveloppee en ErrorRecord et devient une erreur TERMINANTE des la
# premiere ligne - le script s'arrete avant meme que la redirection *>> ait pu
# ecrire quoi que ce soit dans le log (verifie en execution reelle : ce fichier
# etait vide alors que node avait bien tourne). Garder la valeur par defaut
# ('Continue') est necessaire pour que la capture du log fonctionne.

# scripts/ est un sous-dossier direct de la racine du projet.
$dossier = Split-Path -Parent $PSScriptRoot
$dossierLogs = Join-Path $dossier 'logs'
New-Item -ItemType Directory -Force -Path $dossierLogs | Out-Null

$log = Join-Path $dossierLogs "$Commande.log"
$LIMITE_OCTETS = 5MB

# Rotation simple, une seule generation d'archive (.1) ecrasee a chaque rotation :
# suffisant pour diagnostiquer un run rate sans laisser le disque se remplir sur un
# job relance toutes les 15 minutes sans surveillance humaine.
if ((Test-Path $log) -and ((Get-Item $log).Length -gt $LIMITE_OCTETS)) {
    $archive = "$log.1"
    Move-Item -Path $log -Destination $archive -Force
}

# Resolu a CHAQUE run (pas fige a l'installation) : une mise a jour de Node qui
# change son chemin ne casse donc pas la tache silencieusement. Si Node reste
# introuvable (jamais installe, ou absent du PATH systeme utilise par le
# Planificateur), on l'ecrit dans le log plutot que de laisser une tache "reussie"
# qui n'a en realite rien fait.
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
    # Pas de -Encoding ici : le defaut de Out-File sous PowerShell 5.1 (UTF-16LE
    # avec BOM) doit rester identique a celui de *>> plus bas, sinon le meme fichier
    # de log melange deux encodages selon le chemin de code qui a ecrit en dernier.
    "[$(Get-Date -Format o)] [radar] node introuvable dans le PATH - impossible de lancer '$Commande'" |
        Out-File -FilePath $log -Append
    exit 1
}

$indexTs = Join-Path $dossier 'src/index.ts'

# *>> capture toutes les sorties (succes, avertissements, erreurs) en mode ajout.
# Le Planificateur de taches ne conserve la sortie console d'aucun process qu'il
# lance directement : ce fichier est la seule trace exploitable d'un run rate.
& $node $indexTs $Commande *>> $log
exit $LASTEXITCODE
