@echo off
setlocal EnableExtensions
title Yanban AI - Starting Student Site

set "PROJECT_DIR=%~dp0"
set "LAUNCHER=%PROJECT_DIR%start-local.ps1"

if not exist "%LAUNCHER%" (
  echo.
  echo Start failed: start-local.ps1 was not found.
  echo Keep this file in the same project folder as start-local.ps1.
  echo.
  pause
  exit /b 1
)

echo.
echo Starting Yanban AI. This window will show the result.
echo Please wait while the local service starts...
echo.
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%LAUNCHER%" -Page student
set "RESULT=%ERRORLEVEL%"
echo.
if not "%RESULT%"=="0" (
  echo Startup failed with exit code %RESULT%.
  echo Please take a screenshot of all text in this window.
) else (
  echo Student page has been opened in your browser.
  echo You may close this window now.
)
echo.
pause
exit /b %RESULT%
