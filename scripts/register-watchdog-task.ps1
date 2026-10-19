# register-watchdog-task.ps1 - Register the WinterWatchdog scheduled task.
# Shared by install-windows.ps1 and updater.ps1 (idempotent).
# Logon trigger + current user + -RunLevel Limited needs NO admin rights.
# ASCII-only: English-language Windows mangles non-ASCII in PS 5.1 scripts.
param(
    [Parameter(Mandatory = $true)]
    [string]$WinterHome
)
$ErrorActionPreference = 'Stop'

$taskName = 'WinterWatchdog'
$watchdogPath = Join-Path $WinterHome 'scripts\watchdog.ps1'
if (-not (Test-Path $watchdogPath)) {
    Write-Host "ERROR: watchdog script not found: $watchdogPath"
    exit 1
}

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
    -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$watchdogPath`"" `
    -WorkingDirectory $WinterHome
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

if (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
    -Settings $settings -RunLevel Limited | Out-Null
Write-Host "WinterWatchdog task registered (watchdog: $watchdogPath)."

# Start it now. If a watchdog is already running, the new instance exits
# immediately via its single-instance guard - that is normal, NOT a failure.
try {
    Start-ScheduledTask -TaskName $taskName
    Write-Host 'WinterWatchdog task started (if one was already running = OK, duplicate exits by design).'
} catch {
    Write-Host "WARNING: could not start task now: $($_.Exception.Message)"
    Write-Host '  It will still start automatically at next logon.'
}
