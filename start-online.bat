@echo off
title TableNest - Online (permanent URL)
cd /d "%~dp0"

set "TS=C:\Program Files\Tailscale\tailscale.exe"
set "URL=https://tablenest.tail0010e0.ts.net"

echo ============================================================
echo   TableNest - Online mode
echo   Permanent URL: %URL%
echo ============================================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js nahi mila. https://nodejs.org se install karein.
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies ^(first time only^)...
  call npm install --no-fund --no-audit
  echo.
)

if not exist "%TS%" (
  echo [ERROR] Tailscale nahi mila.
  echo Install: winget install -e --id Tailscale.Tailscale
  echo.
  pause
  exit /b 1
)

rem QR codes should follow the public URL, not a leftover tunnel URL.
powershell -NoProfile -Command "(Get-Content '.env') -replace '^BASE_URL=.*','# BASE_URL=' | Set-Content '.env' -Encoding utf8" >nul 2>nul

rem Make sure the public funnel is (still) pointing at port 3000.
rem Safe to run every time - it is idempotent.
"%TS%" funnel --bg 3000 >nul 2>nul

echo   Public URL : %URL%
echo.
echo   Owner      : %URL%/admin
echo   Kitchen    : %URL%/kitchen
echo   Cashier    : %URL%/cashier
echo   Customer   : %URL%/menu?table=^<table-token^>
echo.
echo   NOTE: Yeh window band karne par app band ho jayega.
echo         Chalu rakhne ke liye ise minimize karein.
echo.

start "" "%URL%"

node server.js

echo.
echo Server band ho gaya.
pause
