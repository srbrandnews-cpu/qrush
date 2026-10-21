@echo off
title TableNest - Trial mode (server + free public HTTPS URL)
cd /d "%~dp0"

echo ============================================================
echo   TableNest Trial Mode
echo   - Free public HTTPS URL (Cloudflare tunnel)
echo   - QR codes apne aap update ho jayenge
echo ============================================================
echo.

where cloudflared >nul 2>nul
if errorlevel 1 (
  echo [ERROR] cloudflared nahi mila.
  echo Install karne ke liye:
  echo    winget install Cloudflare.cloudflared
  echo.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js nahi mila. https://nodejs.org se install karein.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies (first time only)...
  call npm install --no-fund --no-audit
  echo.
)

call npm run tunnel

pause
