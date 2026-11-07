@echo off
rem KesherAI's command line: kesher chat "hello", kesher models, kesher run <pipeline> …
rem It talks to the KesherAI app running on this computer (start it, or: KesherAI.exe --headless).
set ELECTRON_RUN_AS_NODE=1
"%~dp0..\KesherAI.exe" "%~dp0kesher-cli.mjs" %*
