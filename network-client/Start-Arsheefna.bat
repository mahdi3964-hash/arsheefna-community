@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-Arsheefna.ps1"
set "launch_result=%ERRORLEVEL%"
if not "%launch_result%"=="0" pause
exit /b %launch_result%
