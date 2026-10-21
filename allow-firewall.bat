@echo off
title TableNest - Allow port 3000 through Windows Firewall
echo.
echo ============================================================
echo   Windows Firewall mein port 3000 allow ho raha hai...
echo   (Phone se QR scan karne ke liye zaroori hai)
echo ============================================================
echo.

netsh advfirewall firewall add rule name="TableNest (Node.js) port 3000" dir=in action=allow protocol=TCP localport=3000

echo.
if errorlevel 1 (
  echo [DHYAN DE] Rule nahi bana. Ise RIGHT-CLICK karke
  echo           "Run as administrator" se chalayein.
) else (
  echo [OK] Port 3000 allow ho gaya. Ab phone se QR scan karke dekhein.
)
echo.
pause
