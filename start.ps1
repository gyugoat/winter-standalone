# start.ps1 - Winter server start (Windows). ASCII-only messages (PS 5.1 encoding).
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

$port = if ($env:WINTER3_PORT) { $env:WINTER3_PORT } else { '7979' }

# auth token: inject data\.auth-token if present
$tokenPath = Join-Path $PSScriptRoot 'data\.auth-token'
if ((Test-Path $tokenPath) -and (-not $env:CLAUDE_CODE_OAUTH_TOKEN)) {
    $env:CLAUDE_CODE_OAUTH_TOKEN = (Get-Content $tokenPath -Raw).Trim()
}

# already running? then just report and exit
try {
    $null = Invoke-RestMethod -Uri "http://localhost:$port/health" -TimeoutSec 2
    Write-Host "[winter] already running - http://localhost:$port"
    exit 0
} catch { }

# port in use by someone else? (health 통과 못 했는데 포트 점유 = 다른 프로세스)
$portBusy = $false
try {
    $t = Test-NetConnection -ComputerName 'localhost' -Port ([int]$port) -InformationLevel Quiet -WarningAction SilentlyContinue
    if ($t) { $portBusy = $true }
} catch {
    try {
        $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, [int]$port)
        $listener.Start(); $listener.Stop()
    } catch { $portBusy = $true }
}
if ($portBusy) {
    Write-Host "[winter] port $port is already used by another process."
    Write-Host "         to use a different port: `$env:WINTER3_PORT='8080'; .\start.ps1"
    exit 1
}

New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot 'data\logs') | Out-Null
Write-Host "[winter] starting server - http://localhost:$port"
$env:WINTER3_PORT = $port
$logFile = Join-Path $PSScriptRoot 'data\logs\server.log'
$errFile = Join-Path $PSScriptRoot 'data\logs\server.err.log'

# Prefer the WinterWatchdog scheduled task (auto-restart on crash). Fall back to
# direct launch for old installs that never registered the task.
$useTask = $false
try {
    if (Get-ScheduledTask -TaskName 'WinterWatchdog' -ErrorAction SilentlyContinue) { $useTask = $true }
} catch { }
if ($useTask) {
    Write-Host '[winter] launching via WinterWatchdog scheduled task'
    Start-ScheduledTask -TaskName 'WinterWatchdog'
} else {
    # Start-Process -RedirectStandardOutput truncates, so append via cmd.exe >>.
    $cmdLine = "/c node server\index.js >> `"$logFile`" 2>> `"$errFile`""
    Start-Process -FilePath 'cmd.exe' -ArgumentList $cmdLine -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
}

# wait for health (max 30s - watchdog bootstrap can take a few seconds)
for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $null = Invoke-RestMethod -Uri "http://localhost:$port/health" -TimeoutSec 2
        Write-Host "[winter] ready - open http://localhost:$port in your browser"
        Start-Process "http://localhost:$port"
        exit 0
    } catch { }
}
Write-Host "[winter] WARNING: health check failed - see data\logs\server.log"
exit 1
