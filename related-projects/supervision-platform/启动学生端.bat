@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title Student Platform
set "PLATFORM_PORT=5173"
set "PLATFORM_URL=http://127.0.0.1:%PLATFORM_PORT%/student"
set "RUNTIME_DIR=%~dp0.runtime"
set "LOG_FILE=%RUNTIME_DIR%\student-vite.log"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required.
  echo Install it from https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules\.bin\vite.cmd" (
  echo Installing project dependencies...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo Dependency installation failed.
    pause
    exit /b 1
  )
)

if not exist "%RUNTIME_DIR%" mkdir "%RUNTIME_DIR%"

rem Reuse an already healthy Vite server; do not trust a TCP port alone.
powershell.exe -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 '%PLATFORM_URL%'; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
if not errorlevel 1 goto :open_student

rem Start Vite in the background and keep its output for diagnosis.
start "Student Platform Server" /b cmd /d /c "call npm run dev -- --host 127.0.0.1 --port %PLATFORM_PORT% >"%LOG_FILE%" 2>&1"

echo Student Platform is starting...
echo Waiting for %PLATFORM_URL%
for /l %%I in (1,1,30) do (
  powershell.exe -NoProfile -Command "try { $r=Invoke-WebRequest -UseBasicParsing -TimeoutSec 1 '%PLATFORM_URL%'; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
  if not errorlevel 1 goto :open_student
  timeout /t 1 /nobreak >nul
)

echo Student Platform failed to start on port %PLATFORM_PORT%.
echo Check the log: %LOG_FILE%
type "%LOG_FILE%" 2>nul
pause
exit /b 1

:open_student
start "" "%PLATFORM_URL%"
echo Student Platform is ready: %PLATFORM_URL%
exit /b 0
