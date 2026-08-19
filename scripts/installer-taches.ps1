# scripts/installer-taches.ps1
# Enregistre les quatre jobs du radar dans le Planificateur de taches Windows.
# A lancer une fois, dans un PowerShell ouvert en administrateur, depuis riveska-radar/.

$dossier = (Get-Location).Path
$node = (Get-Command node).Source

# Le Planificateur de taches n'affiche ni ne conserve la sortie console d'une
# action lancee directement : sans redirection, un run rate est invisible.
# On passe donc par cmd.exe pour rediriger stdout+stderr vers un fichier par job,
# en mode ajout (>>) pour garder l'historique des runs precedents.
$dossierLogs = Join-Path $dossier 'logs'
New-Item -ItemType Directory -Force -Path $dossierLogs | Out-Null

function Ajouter-Tache {
    param([string]$Nom, [string]$Commande, $Declencheur)

    $log = Join-Path $dossierLogs "$Commande.log"
    $argCmd = "/c `"$node`" src/index.ts $Commande >> `"$log`" 2>&1"

    $action = New-ScheduledTaskAction -Execute 'cmd.exe' `
        -Argument $argCmd -WorkingDirectory $dossier

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

Write-Host "4 taches enregistrees. Verifier avec : Get-ScheduledTask -TaskName 'RiveskaRadar-*'"
Write-Host "Logs par job dans : $dossierLogs"
