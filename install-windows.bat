@echo off
rem install-windows.bat - double-click wrapper. Runs install-windows.ps1 in the same folder.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install-windows.ps1"
pause
