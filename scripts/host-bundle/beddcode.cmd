@echo off
rem The beddcode command for a headless Windows host: runs the bundled host script with its own Node
rem when the installer fetched one, else the Node on PATH. Installed by scripts/install-host.ps1; the
rem release zip keeps it next to server\ and web\.
setlocal
set "BEDDCODE_WEB_ROOT=%~dp0web"
set "NODE_NO_WARNINGS=1"
set "BEDDCODE_NODE=%~dp0node\node.exe"
if not exist "%BEDDCODE_NODE%" set "BEDDCODE_NODE=node"
if "%~1"=="" (
  "%BEDDCODE_NODE%" "%~dp0server\main.mjs" help
) else (
  "%BEDDCODE_NODE%" "%~dp0server\main.mjs" %*
)
exit /b %ERRORLEVEL%
