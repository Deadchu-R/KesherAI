@echo off
rem Lets the KesherAI phone app reach this computer on your home network.
rem 1. Checks that KesherAI listens for other devices (not only this computer).
rem 2. Allows port 7420 through Windows Firewall on private (home) networks.
title KesherAI - allow the phone
echo.
echo === Is KesherAI listening for the phone? ===
netstat -ano | findstr LISTENING | findstr ":7420 " > "%TEMP%\kesher-port.txt"
findstr "0.0.0.0:7420" "%TEMP%\kesher-port.txt" >nul
if not errorlevel 1 (
  echo [ok] KesherAI accepts connections from other devices.
) else (
  findstr "127.0.0.1:7420" "%TEMP%\kesher-port.txt" >nul
  if not errorlevel 1 (
    echo [!] KesherAI only listens to this computer.
    echo     Turn on Settings - Phone - "Allow access from other devices", then CLOSE KesherAI
    echo     ^(and any black command window running it^) and open it again.
  ) else (
    echo [!] KesherAI is not running. Open it, then run this file again.
  )
)
echo.
echo === Your network ===
powershell -NoProfile -Command "Get-NetConnectionProfile | ForEach-Object { '  ' + $_.InterfaceAlias + ': ' + $_.NetworkCategory }"
echo   If your home network says Public, Windows blocks the phone. Change it to Private:
echo   Settings - Network and internet - Wi-Fi or Ethernet - your network - Private network.
echo.
echo === Windows Firewall ===
netsh advfirewall firewall show rule name="KesherAI (phone)" >nul 2>nul
if not errorlevel 1 (
  echo [ok] The firewall rule already exists.
  goto :done
)
echo Adding a firewall rule for port 7420 on private networks. Windows asks for permission: click Yes.
powershell -NoProfile -Command "Start-Process netsh -Verb RunAs -Wait -ArgumentList 'advfirewall firewall add rule name=\"KesherAI (phone)\" dir=in action=allow protocol=TCP localport=7420 profile=private'"
netsh advfirewall firewall show rule name="KesherAI (phone)" >nul 2>nul
if errorlevel 1 (echo [!] The rule was not added. Run this file again and click Yes.) else (echo [ok] Firewall rule added.)
:done
echo.
echo Now try Connect in the phone app again.
pause
