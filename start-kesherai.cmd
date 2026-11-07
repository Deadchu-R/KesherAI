@echo off
rem Starts KesherAI for development on Windows: the core server on port 7420
rem and the interface on http://localhost:5173 (opened in your browser).
rem Close this window to stop it.
title KesherAI
cd /d "%~dp0"
if not exist node_modules (
  echo First run: installing dependencies...
  call pnpm install || goto :fail
  call pnpm build:packages || goto :fail
)
start "" /min cmd /c "timeout /t 6 >nul & start http://localhost:5173"
call pnpm dev
goto :eof
:fail
echo Something went wrong. See the messages above.
pause
