# restart.ps1 - Winter server restart (Windows). ASCII-only messages (PS 5.1 encoding).
$ErrorActionPreference = 'Continue'
Set-Location -Path $PSScriptRoot
$port = if ($env:WINTER3_PORT) { [int]$env:WINTER3_PORT } else { 7979 }
try {
    $conns = Get-NetTCPConnection -LocalPort $port -ErrorAction Stop
    $procIds = $conns | Select-Object -ExpandProperty OwningProcess -Unique
    foreach ($procId in $procIds) {
        if ($procId -and $procId -gt 0) {
            try { Stop-Process -Id $procId -Force -ErrorAction Stop } catch { }
        }
    }
} catch { }
Start-Sleep -Seconds 2
& (Join-Path $PSScriptRoot 'start.ps1')
