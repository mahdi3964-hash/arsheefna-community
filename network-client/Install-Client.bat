@echo off
setlocal
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0Install-Client.ps1"
set "install_result=%ERRORLEVEL%"
if not "%install_result%"=="0" pause
exit /b %install_result%
