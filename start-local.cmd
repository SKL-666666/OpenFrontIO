@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"
title OpenFront local build

rem =========================================================================
rem  One-click launcher for the LOCAL (no game server) build.
rem
rem    start-local.cmd            serve the prebuilt client on :9000  (FAST)
rem    start-local.cmd --build    rebuild static\ first, then serve
rem    start-local.cmd --dev      vite dev server with hot reload     (for
rem                                editing source: first load ~15s)
rem    start-local.cmd --lan      same as --dev but reachable from
rem                                other machines on your wifi
rem    start-local.cmd --host     serve the prebuilt client on your LAN
rem =========================================================================
echo.
echo  =============================================
echo    OpenFront - LOCAL build (no game server)
echo  =============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo  [ERROR] Node.js not found on PATH.
  echo          Install Node 24 or newer, then run this script again.
  goto :fail
)
for /f "tokens=*" %%v in ('node -v') do echo  node %%v
echo.

if not exist "node_modules" (
  echo  [1/3] Installing dependencies ^(this can take a few minutes^)...
  call npm run inst
  if errorlevel 1 goto :fail
) else (
  echo  [1/3] Dependencies already installed.
)

if /i "%~1"=="--dev" goto :dev
if /i "%~1"=="--lan" goto :devlan

rem --------------------------------------------------------------- serve mode
if /i "%~1"=="--build" (
  echo  [2/3] Rebuilding the client...
  call npm run build:offline
  if errorlevel 1 goto :fail
  goto :doserve
)
if not exist "static\index.html" (
  echo  [2/3] Building the client ^(about a minute the first time^)...
  call npm run build:offline
  if errorlevel 1 goto :fail
  goto :doserve
)
echo  [2/3] static\ is already built. Use --build to force a rebuild.
:doserve
echo  [3/3] Serving the built client...
echo.
echo  ------------------------------------------------
if /i "%~1"=="--host" (
  echo  Open:  http://localhost:9000/
  echo         and on your LAN:  http://^<this machine's IP^>:9000/
) else (
  echo  Open:  http://localhost:9000/
)
echo.
echo  This is the built client: assets are content-hashed and cached, so
echo  repeat visits load in a fraction of a second.
echo  A browser window will open by itself.
echo  Keep this window open. Press Ctrl+C to stop.
echo  ------------------------------------------------
echo.
call node scripts\lan-host.mjs --port 9000 --open
set ERR=%ERRORLEVEL%
if not "%ERR%"=="0" (
  echo.
  echo  [ERROR] The server exited with code %ERR%.
  goto :fail
)
goto :eof

rem ---------------------------------------------------------------- dev mode
:dev
echo  [2/3] Starting the vite dev server...
goto :devgo
:devlan
echo  [2/3] Starting the vite dev server, reachable from your LAN...
set VITE_HOST=lan
:devgo
echo  [3/3] Dev mode compiles each module on demand, so the FIRST page load
echo        takes ~15s. Use this only when you are editing source code.
echo.
echo  ------------------------------------------------
echo  Open:  http://localhost:9000/
echo.
echo  Keep this window open. Press Ctrl+C to stop.
echo  ------------------------------------------------
echo.
set SKIP_BROWSER_OPEN=false
call npm run dev
set ERR=%ERRORLEVEL%
if not "%ERR%"=="0" (
  echo.
  echo  [ERROR] The dev server exited with code %ERR%.
  goto :fail
)
goto :eof

:fail
echo.
echo  ------------------------------------------------
echo  Startup failed. Press any key to close this window.
pause >nul
exit /b 1
