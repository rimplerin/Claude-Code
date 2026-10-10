@echo off
setlocal
title Banana i2i
cd /d "%~dp0"

rem ---------------------------------------------------------------
rem  Some PCs have a broken PATH (C:\Windows\System32 missing),
rem  so add the Windows system folders back for this window only.
rem ---------------------------------------------------------------
if not defined SystemRoot set "SystemRoot=C:\Windows"
set "PATH=%SystemRoot%\System32;%SystemRoot%;%SystemRoot%\System32\Wbem;%PATH%"
"%SystemRoot%\System32\chcp.com" 65001 >nul 2>&1

rem ---- find node.exe (PATH first, then the usual install folders) ----
node -v >nul 2>&1
if not errorlevel 1 goto have_node

set "NODE_DIR="
for %%D in ("%ProgramFiles%\nodejs" "%ProgramW6432%\nodejs" "%ProgramFiles(x86)%\nodejs" "%LOCALAPPDATA%\Programs\nodejs" "%NVM_SYMLINK%" "%APPDATA%\nvm\current") do (
  if exist "%%~D\node.exe" set "NODE_DIR=%%~D"
)
if not defined NODE_DIR goto no_node
set "PATH=%NODE_DIR%;%PATH%"
goto have_node

:no_node
echo.
echo  [ERROR] Node.js was not found.
echo  1. Install the LTS version from https://nodejs.org
echo  2. Restart the PC (or sign out and in again), then run start.bat again.
echo.
pause
exit /b 1

:have_node
node -e "process.exit(+process.versions.node.split('.')[0] >= 20 ? 0 : 1)"
if errorlevel 1 goto old_node
for /f "delims=" %%V in ('node -v') do echo  Node.js %%V

rem ---- install packages on first run ----
node scripts\check-deps.cjs >nul 2>&1
if not errorlevel 1 goto run
echo.
echo  Installing packages (first run or after an update, takes a minute)...
call npm install --omit=dev --no-audit --no-fund
if errorlevel 1 goto npm_failed

:run
set "OPEN_BROWSER=1"
node server\index.js
echo.
echo  Server stopped.
pause
exit /b 0

:old_node
echo.
echo  [ERROR] Node.js is too old. Install Node.js 20 LTS or newer from https://nodejs.org
for /f "delims=" %%V in ('node -v') do echo  Current version: %%V
echo.
pause
exit /b 1

:npm_failed
echo.
echo  [ERROR] npm install failed. Check your internet connection and run start.bat again.
echo.
pause
exit /b 1
