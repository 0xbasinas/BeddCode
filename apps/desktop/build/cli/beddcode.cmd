@echo off
rem The beddcode command: runs the app's own program as plain Node on the host script that ships
rem with it (the same way the app starts its host), so nothing else has to be installed.
setlocal
set "ELECTRON_RUN_AS_NODE=1"
set "BEDDCODE_APP=%~dp0..\..\BeddCode.exe"
set "BEDDCODE_WEB_ROOT=%~dp0..\web"
set "NODE_NO_WARNINGS=1"
"%BEDDCODE_APP%" "%~dp0..\server\main.mjs" %*
exit /b %ERRORLEVEL%
