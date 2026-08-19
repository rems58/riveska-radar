# scripts/installer-taches.ps1
# Enregistre les cinq jobs du radar dans le Planificateur de taches Windows.
# A lancer une fois, dans un PowerShell ouvert en administrateur.

# Racine du projet deduite de l'EMPLACEMENT DU SCRIPT (scripts/.. ), pas du
# repertoire courant : (Get-Location).Path pointait vers un dossier different -
# et donc inexistant du point de vue de $lanceur/-WorkingDirectory, sans jamais le
# signaler - des qu'on lance ce script depuis ailleurs que riveska-radar/ (double-clic,
# raccourci, autre repertoire ouvert dans le terminal administrateur).
$dossier = Split-Path -Parent $PSScriptRoot

# Sans cette garde, un Node absent du PATH ferait enregistrer les quatre taches
# quand meme, avec une action cassee, sans jamais le signaler : mieux vaut
# echouer tout de suite avec un message clair qu'a la premiere execution planifiee,
# invisible sans surveillance humaine.
$commandeNode = Get-Command node -ErrorAction SilentlyContinue
if (-not $commandeNode) {
    Write-Error "Node introuvable dans le PATH. Installe Node.js (https://nodejs.org), verifie 'node --version' dans un NOUVEAU terminal, puis relance ce script."
    exit 1
}

$lanceur = Join-Path $dossier 'scripts\lancer-job.ps1'

function Ajouter-Tache {
    param([string]$Nom, [string]$Commande, $Declencheur)

    # lancer-job.ps1 gere la rotation du log (5 Mo) et resout le chemin de node a
    # chaque execution (pas seulement a l'installation) : voir ce fichier pour le detail.
    $argument = "-NoProfile -ExecutionPolicy Bypass -File `"$lanceur`" -Commande $Commande"

    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
        -Argument $argument -WorkingDirectory $dossier

    # Demarre meme sur batterie et relance en cas d'echec.
    $reglages = New-ScheduledTaskSettingsSet -StartWhenAvailable `
        -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries `
        -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 5)

    Register-ScheduledTask -TaskName $Nom -Action $action -Trigger $Declencheur `
        -Settings $reglages -Description "Riveska Radar - $Commande" -Force
}

# Radar : toutes les 15 minutes, indefiniment.
$t1 = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Minutes 15)
Ajouter-Tache -Nom 'RiveskaRadar-Radar' -Commande 'radar' -Declencheur $t1

# Reddit (search.rss) : une fois par heure - jamais plus souvent. Cette source
# est sequentielle stricte a 1 requete/minute (contrainte Reddit mesuree, voir
# src/collectors/reddit-rss.ts) : un run dure jusqu'a une douzaine de minutes,
# largement dans les clous d'une cadence horaire, mais casserait la politesse
# envers Reddit si on la lancait toutes les 15 minutes comme radar.
$t5 = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Hours 1)
Ajouter-Tache -Nom 'RiveskaRadar-Reddit' -Commande 'reddit' -Declencheur $t5

# Recheck : toutes les 6 heures.
$t2 = New-ScheduledTaskTrigger -Once -At (Get-Date) `
    -RepetitionInterval (New-TimeSpan -Hours 6)
Ajouter-Tache -Nom 'RiveskaRadar-Recheck' -Commande 'recheck' -Declencheur $t2

# Triggers plateformes : tous les jours a 9h.
$t3 = New-ScheduledTaskTrigger -Daily -At 9am
Ajouter-Tache -Nom 'RiveskaRadar-Triggers' -Commande 'triggers' -Declencheur $t3

# Bilan hebdo : lundi 9h.
$t4 = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At 9am
Ajouter-Tache -Nom 'RiveskaRadar-Weekly' -Commande 'weekly' -Declencheur $t4

Write-Host "5 taches enregistrees. Verifier avec : Get-ScheduledTask -TaskName 'RiveskaRadar-*'"
Write-Host "Logs par job dans : $(Join-Path $dossier 'logs') (rotation automatique au-dela de 5 Mo)"
