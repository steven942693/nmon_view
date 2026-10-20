@echo off
setlocal EnableExtensions DisableDelayedExpansion
if /i "%~1"=="--help" goto help
pushd "%~dp0"
if errorlevel 1 exit /b 1
where node >nul 2>nul
if errorlevel 1 goto missing_node
where npm.cmd >nul 2>nul
if errorlevel 1 goto missing_node
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)"
if errorlevel 1 goto old_node
set "NMON_PORT=7577"
if not "%~1"=="" set "NMON_PORT=%~1"
node -e "const p=process.env.NMON_PORT; process.exit(/^\d+$/.test(p) && Number(p)>0 && Number(p)<65536 ? 0 : 1)"
if errorlevel 1 goto bad_port
if not exist "node_modules\.bin\vite.cmd" (
  echo Installing dependencies. Internet access is required on first run.
  call npm.cmd ci --no-audit --no-fund
  if errorlevel 1 goto failed
)
echo Open http://127.0.0.1:%NMON_PORT%/ after Vite reports ready.
echo Keep this window open. Press Ctrl+C to stop.
call npm.cmd run dev -- --port %NMON_PORT% --strictPort
if errorlevel 1 goto failed
popd
exit /b 0

:missing_node
echo Node.js and npm were not found. Install Node.js 24 with npm, then reopen this script.
goto failed
:old_node
echo Node.js 22 or newer is required by this launcher. Node.js 24 is recommended.
goto failed
:bad_port
echo Invalid port. Use a number from 1 to 65535, for example: start.cmd 7578
goto failed
:failed
echo Startup failed. Check the error above.
echo If port 7577 is in use, run: start.cmd 7578
popd
pause
exit /b 1
:help
echo Usage: start.cmd [port]
echo Default port: 7577. Requires Node.js 22 or newer and npm.
echo First run installs locked dependencies using npm ci.
echo The server listens only on 127.0.0.1. Press Ctrl+C to stop.
exit /b 0
