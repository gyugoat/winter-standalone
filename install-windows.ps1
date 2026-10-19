# install-windows.ps1 - Winter installer (Windows)
# ASCII-only messages: non-BOM UTF-8 Korean renders as "????" in PowerShell 5.1,
# especially on English-language Windows.
$ErrorActionPreference = 'Stop'
Set-Location -Path $PSScriptRoot

Write-Host '=============================='
Write-Host ' Winter installer (Windows)'
Write-Host '=============================='

# -- 1) Node.js >= 20 -----------------------------------------------------
$needNode = $true
if (Get-Command node -ErrorAction SilentlyContinue) {
    $major = [int]((node -v).TrimStart('v').Split('.')[0])
    if ($major -ge 20) { $needNode = $false }
}
if ($needNode) {
    Write-Host '[1/4] Node.js 20+ not found - installing via winget'
    if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
        Write-Host '  Node.js installed. Close this window and run install-windows.bat again (new PATH).'
        exit 0
    } else {
        Write-Host '  winget not available. Install Node.js LTS from https://nodejs.org/en/download then rerun.'
        exit 1
    }
} else {
    Write-Host "[1/4] Node.js OK ($(node -v))"
}

# -- 2) claude CLI --------------------------------------------------------
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Write-Host '[2/4] Installing claude CLI...'
    irm https://claude.ai/install.ps1 | iex
    $env:PATH = (Join-Path $env:USERPROFILE '.local\bin') + ';' + $env:PATH
    if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
        Write-Host '  claude CLI not on PATH yet. Open a NEW PowerShell window and rerun this script.'
        exit 1
    }
} else {
    Write-Host '[2/4] claude CLI OK'
}

# -- 3) npm install -------------------------------------------------------
Write-Host '[3/4] Installing Node packages...'
npm install --omit=dev --silent
Write-Host '[3/4] npm OK'

# -- 4) Claude auth -------------------------------------------------------
$tokenPath = Join-Path $PSScriptRoot 'data\.auth-token'
if ((Test-Path $tokenPath) -and ((Get-Item $tokenPath).Length -gt 0)) {
    Write-Host '[4/4] Auth token already present (data\.auth-token)'
} else {
    Write-Host '[4/4] Claude account login required (your own Claude Pro/Max subscription).'
    Write-Host '  "claude setup-token" will run now. Sign in with your Claude account.'
    Write-Host '  Copy the sk-ant-oat... token shown at the end.'
    Start-Process -FilePath 'claude' -ArgumentList 'setup-token' -Wait -NoNewWindow
    $token = Read-Host 'Paste the token (sk-ant-oat...) here (or press Enter to skip)'
    if ($token -and $token.StartsWith('sk-ant-oat')) {
        New-Item -ItemType Directory -Force -Path (Join-Path $PSScriptRoot 'data') | Out-Null
        Set-Content -Path $tokenPath -Value $token.Trim() -NoNewline -Encoding ascii
        Write-Host '  Token saved (data\.auth-token)'
    } else {
        Write-Host '  No token entered - will use the local claude CLI login state.'
        Write-Host '  (If issues occur: run "claude setup-token" and save the token to data\.auth-token)'
    }
}

# -- 5) Watchdog scheduled task (auto start on logon + crash recovery) -----
Write-Host '[5/5] Registering WinterWatchdog scheduled task...'
try {
    & (Join-Path $PSScriptRoot 'scripts\register-watchdog-task.ps1') -WinterHome $PSScriptRoot
    Write-Host '[5/5] WinterWatchdog task registered (starts at logon, restarts server if it dies).'
} catch {
    Write-Host "[5/5] WARNING: scheduled task registration failed: $($_.Exception.Message)"
    Write-Host '  The server will still work, but will not auto-start after reboot.'
}

# -- start ----------------------------------------------------------------
& (Join-Path $PSScriptRoot 'start.ps1')
Write-Host ''
Write-Host 'Install complete. From now on the server starts automatically at logon.'
Write-Host 'If it ever looks down, just double-click start.bat.'
