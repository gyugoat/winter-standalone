@echo off
rem start.bat - starts the Winter server (double-click). Runs start.ps1 in the same folder.
rem Keep this file inside the Winter folder (next to install-windows.bat).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start.ps1"
pause
