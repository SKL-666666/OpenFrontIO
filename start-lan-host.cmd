@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title OpenFront - LAN host (offline build + relay)

echo.
echo  =============================================
echo    OpenFront - LAN host
echo  =============================================
echo.
echo  Serves the built client and relays local-room frames for
echo  OTHER machines. Game logic still runs in each browser.
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  [ERROR] Node.js not found on PATH.
  goto :fail
)

if not exist "node_modules" (
  echo  [1/3] Installing dependencies...
  call npm run inst
  if errorlevel 1 goto :fail
) else (
  echo  [1/3] Dependencies already installed.
)

if not exist "static\index.html" (
  echo  [2/3] Building the offline client ^(this can take a minute^)...
  call npm run build:offline
  if errorlevel 1 goto :fail
) else (
  echo  [2/3] static\ already built. Delete it to force a rebuild.
)

echo  [3/3] Starting the LAN host...
echo.
echo  ------------------------------------------------
echo  A browser window will open by itself.
echo  Press Ctrl+C to stop.
echo  ------------------------------------------------
call node scripts\lan-host.mjs --open
set ERR=%ERRORLEVEL%
if not "%ERR%"=="0" (
  echo.
  echo  [ERROR] The LAN host exited with code %ERR%.
  goto :fail
)
goto :eof

:fail
echo.
echo  Startup failed. Press any key to close this window.
pause >nul
exit /b 1
