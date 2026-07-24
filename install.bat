@echo off
REM install.bat - install cc-proxy from a clone of the repo.
REM
REM Default flow:  npm install  ->  npm test  ->  npm run build  ->  npm link
REM Flags:
REM   --skip-test       Skip both `npm install` and `npm test` (deps already
REM                     present and a build is all that's needed); still
REM                     builds + links.
REM   -h, --help          Show this message and exit
REM
REM Any unknown flag is an error. Each step bails on failure so you keep
REM the last good build. Uses `|| goto :error` because batch has no `set -e`.

setlocal enabledelayedexpansion

set "SKIP_TEST=0"

REM Parse args
:argloop
if "%~1"=="" goto argsdone
if /i "%~1"=="--skip-test"    ( set "SKIP_TEST=1"     & shift & goto argloop )
if /i "%~1"=="-h"             ( call :usage & exit /b 0 )
if /i "%~1"=="--help"         ( call :usage & exit /b 0 )
echo install.bat: unknown flag: %~1 1>&2
call :usage
exit /b 1
:argsdone

REM cd to the directory this script lives in (script_dir = %~dp0, sans trailing backslash)
set "SCRIPT_DIR=%~dp0"
if "!SCRIPT_DIR:~-1!"=="\" set "SCRIPT_DIR=!SCRIPT_DIR:~0,-1!"
cd /d "!SCRIPT_DIR!"

REM Node 18+ guard - mirrors bin/cc-proxy.js so the error message is familiar.
call node -v >nul 2>nul
if errorlevel 1 (
  echo install.bat: node was not found on PATH. Install Node 18+ from https://nodejs.org/ 1>&2
  exit /b 1
)
for /f "delims=." %%v in ('node -p "process.versions.node.split('.')[0]"') do set "NODE_MAJOR=%%v"
if !NODE_MAJOR! LSS 18 (
  echo cc-proxy requires Node.js 18 or newer. Please upgrade: https://nodejs.org/ 1>&2
  exit /b 1
)

echo ==^> cc-proxy install (skip-test=!SKIP_TEST!)

if "!SKIP_TEST!"=="0" (
  echo ==^> npm install
  call npm install
  if errorlevel 1 ( echo npm install failed 1>&2 & exit /b 1 )
  echo ==^> npm test
  call npm test
  if errorlevel 1 ( echo npm test failed 1>&2 & exit /b 1 )
) else (
  echo ==^> ^(skipping npm install + npm test^)
)

echo ==^> npm run build
call npm run build
if errorlevel 1 ( echo npm run build failed 1>&2 & exit /b 1 )

echo ==^> npm link
call npm link
if errorlevel 1 ( echo npm link failed 1>&2 & exit /b 1 )

echo ==^> done. cc-proxy is now available as 'cc-proxy' on your PATH.
exit /b 0

:usage
echo install.bat - install cc-proxy from a clone of the repo.
echo.
echo Usage: install.bat [flags]
echo.
echo   --skip-test       Skip npm install and npm test (still builds + links)
echo   -h, --help        Show this message and exit
goto :eof
