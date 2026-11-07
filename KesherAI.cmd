@echo off
rem Opens KesherAI as a desktop app (its own window, no browser).
rem The first run builds it, which takes a minute. Later runs open in seconds.
rem Also puts a "KesherAI" shortcut on your desktop the first time.
title KesherAI
cd /d "%~dp0"
set "PATH=%ProgramFiles%\nodejs;%APPDATA%\npm;%PATH%"
if not exist node_modules (
  echo [..] First run: installing dependencies...
  call pnpm install || goto :fail
)
if not exist apps\desktop\dist\main.js (
  echo [..] Building KesherAI...
  call pnpm build:packages || goto :fail
  call pnpm --filter @kesher/web build || goto :fail
  call pnpm --filter @kesher/desktop build || goto :fail
)
rem pnpm may skip Electron's own download step; fetch the Electron program if it is missing.
if not exist apps\desktop\node_modules\electron\dist\electron.exe (
  echo [..] Downloading the Electron window ^(about 100 MB, first run only^)...
  pushd apps\desktop\node_modules\electron
  call node install.js
  popd
)
rem Electron's own unzip step sometimes stops after the first file on new Node.js
rem versions. Unzip the downloaded copy with Windows' own tool instead.
if not exist apps\desktop\node_modules\electron\dist\electron.exe (
  echo [..] Unpacking Electron...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $v=(Get-Content apps\desktop\node_modules\electron\package.json | ConvertFrom-Json).version; $zip=Get-ChildItem -Recurse -Filter ('electron-v'+$v+'-win32-x64.zip') (Join-Path $env:LOCALAPPDATA 'electron\Cache') | Select-Object -First 1; if (-not $zip) { throw 'The Electron download was not found' }; $d='apps\desktop\node_modules\electron\dist'; Remove-Item -Recurse -Force $d -ErrorAction SilentlyContinue; Expand-Archive -Force $zip.FullName $d; Set-Content -NoNewline apps\desktop\node_modules\electron\path.txt 'electron.exe'"
  if not exist apps\desktop\node_modules\electron\dist\electron.exe goto :fail
)
if not exist "%USERPROFILE%\Desktop\KesherAI.lnk" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\KesherAI.lnk'); $s.TargetPath='%~dp0KesherAI.cmd'; $s.WorkingDirectory='%~dp0'; $s.WindowStyle=7; $s.IconLocation='%~dp0apps\desktop\node_modules\electron\dist\electron.exe,0'; $s.Save()" >nul 2>nul
  echo [ok] Added a KesherAI shortcut to your desktop.
)
start "" "%~dp0apps\desktop\node_modules\electron\dist\electron.exe" "%~dp0apps\desktop"
goto :eof
:fail
echo [!] Something went wrong. Copy the messages above and send them to Claude.
pause
