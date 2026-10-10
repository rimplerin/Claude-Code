@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js가 필요합니다. https://nodejs.org 에서 LTS 버전을 설치한 뒤 다시 실행하세요.
  pause
  exit /b 1
)
if not exist node_modules (
  echo 처음 실행: 필요한 패키지를 설치합니다...
  call npm install --omit=dev
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
set OPEN_BROWSER=1
node server\index.js
pause
