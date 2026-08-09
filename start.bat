@echo off
REM ============================================================
REM  SIM Station launcher
REM    0. Self-elevate to administrator (UAC prompt)
REM    1. Build the React client into client/dist
REM    2. Start the Node server (serves API + built client)
REM
REM  Admin is required only for the optional 4G data uplink
REM  (RNDIS routing + Tailscale CLI). This script re-launches
REM  itself elevated automatically — just double-click it.
REM ============================================================

REM --- self-elevate: if not admin, relaunch this .bat via UAC and exit ---
net session >nul 2>&1
if %errorlevel% NEQ 0 (
  echo Requesting administrator privileges...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

setlocal
REM RunAs starts the elevated instance in System32 — go back to the script dir.
cd /d "%~dp0"

REM --- build client ---
echo.
echo [1/2] Building client...
cd client
call npm.cmd run build
if errorlevel 1 (
  echo.
  echo Build failed. Fix the errors above before launching the server.
  pause
  exit /b 1
)
cd ..

REM --- start server (foreground, blocks until Ctrl+C) ---
echo.
echo [2/2] Starting server on http://localhost:3001 ...
echo       Expose it with: tailscale funnel --bg 3001
echo       Press Ctrl+C to stop.
echo.
cd server
call npm.cmd start

endlocal
