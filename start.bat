@echo off
title TableNest - Restaurant QR Ordering
cd /d "%~dp0"

echo ============================================
echo   TableNest - Starting...
echo ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js nahi mila.
  echo Please install Node.js LTS from https://nodejs.org  and try again.
  pause
  exit /b 1
)

if not exist node_modules (
  echo Installing dependencies (first time only)...
  call npm install --no-fund --no-audit
  echo.
)

if not exist data\tablenest.db (
  echo Creating demo restaurant...
  call npm run seed
  echo.
)

echo Starting server on http://localhost:3000 ...
echo Browser khul jayega - agar na khule toh khud jaake http://localhost:3000 kholein.
echo.

start "" http://localhost:3000
node server.js

pause
