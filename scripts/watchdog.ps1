# watchdog.ps1 - Winter server watchdog (Windows, PowerShell 5.1 compatible).
# Checks http://127.0.0.1:7979/health every 30s; after 2 consecutive failures
# kills whatever owns the port and restarts the server (logs appended).
# ASCII-only: English-language Windows mangles non-ASCII in PS 5.1 scripts.
$ErrorActionPreference = 'Continue'

# --- paths -----------------------------------------------------------------
$WinterHome = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Set-Location -Path $WinterHome

$port = if ($env:WINTER3_PORT) { [int]$env:WINTER3_PORT } else { 7979 }
$logDir = Join-Path $WinterHome 'data\logs'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null
$wdLog   = Join-Path $logDir 'watchdog.log'
$srvLog  = Join-Path $logDir 'server.log'
$srvErr  = Join-Path $logDir 'server.err.log'
$maxLogBytes = 10MB

function Write-WdLog {
    param([string]$Message)
    try {
        if ((Test-Path $wdLog) -and ((Get-Item $wdLog).Length -gt $maxLogBytes)) {
            Set-Content -Path $wdLog -Value '' -Encoding ascii
        }
        $stamp = Get-Date -Format 'yyyy-MM-dd HH:mm:ss'
        Add-Content -Path $wdLog -Value "[$stamp] $Message" -Encoding ascii
    } catch { }
}

# --- single-instance guard -------------------------------------------------
# If another watchdog.ps1 is already running, exit immediately.
try {
    $others = Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe' or Name = 'pwsh.exe'" |
        Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -match 'watchdog\.ps1' }
    if ($others) {
        Write-WdLog "duplicate watchdog detected (pid $($others[0].ProcessId)) - exiting"
        exit 0
    }
} catch {
    # CIM unavailable - proceed anyway rather than refuse to guard the server.
}

Write-WdLog "watchdog started (pid $PID, port $port, home $WinterHome)"

# --- helpers ---------------------------------------------------------------
function Test-ServerHealth {
    try {
        $null = Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -UseBasicParsing -TimeoutSec 5
        return $true
    } catch {
        return $false
    }
}

function Stop-PortOwner {
    try {
        $conns = Get-NetTCPConnection -LocalPort $port -ErrorAction Stop
        $procIds = $conns | Select-Object -ExpandProperty OwningProcess -Unique
        foreach ($procId in $procIds) {
            if ($procId -and $procId -gt 0) {
                try {
                    Stop-Process -Id $procId -Force -ErrorAction Stop
                    Write-WdLog "killed pid $procId on port $port"
                } catch {
                    Write-WdLog "failed to kill pid ${procId}: $($_.Exception.Message)"
                }
            }
        }
    } catch {
        Write-WdLog "no port owner found or Get-NetTCPConnection failed: $($_.Exception.Message)"
    }
}

function Start-WinterServer {
    # auth token: inject data\.auth-token if present (same as start.ps1)
    $tokenPath = Join-Path $WinterHome 'data\.auth-token'
    if ((Test-Path $tokenPath) -and (-not $env:CLAUDE_CODE_OAUTH_TOKEN)) {
        $env:CLAUDE_CODE_OAUTH_TOKEN = (Get-Content $tokenPath -Raw).Trim()
    }
    $env:WINTER3_PORT = "$port"
    # Start-Process -RedirectStandardOutput always truncates, so route through
    # cmd.exe with >> to APPEND to the existing logs instead.
    $cmdLine = "/c node server\index.js >> `"$srvLog`" 2>> `"$srvErr`""
    Start-Process -FilePath 'cmd.exe' -ArgumentList $cmdLine -WorkingDirectory $WinterHome -WindowStyle Hidden
    Write-WdLog "server start issued (node server\index.js)"
}

# --- bootstrap: start the server right away if it is not up -----------------
# (fresh logon / Start-ScheduledTask - do not make the user wait 2 cycles)
if (-not (Test-ServerHealth)) {
    Write-WdLog 'server not running at watchdog start - launching now'
    Stop-PortOwner
    Start-Sleep -Seconds 1
    Start-WinterServer
    Start-Sleep -Seconds 15
}

# --- main loop -------------------------------------------------------------
$failCount = 0
$restartCount = 0
while ($true) {
    if (Test-ServerHealth) {
        if ($failCount -gt 0) {
            Write-WdLog "server healthy again after $failCount failed check(s)"
        }
        $failCount = 0
    } else {
        $failCount++
        Write-WdLog "health check failed ($failCount consecutive)"
        if ($failCount -ge 2) {
            $restartCount++
            Write-WdLog "restarting server (restart #$restartCount)"
            Stop-PortOwner
            Start-Sleep -Seconds 3
            Start-WinterServer
            $failCount = 0
            # grace period so the fresh server can come up before next check
            Start-Sleep -Seconds 15
        }
    }
    Start-Sleep -Seconds 30
}
