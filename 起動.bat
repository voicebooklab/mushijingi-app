@echo off
chcp 65001 >nul
cd /d "C:\Users\wilch\Downloads\mushijingi-app"

echo.
echo Starting mushijingi-app server...

netstat -ano | findstr :3456 | findstr LISTENING >nul
if errorlevel 1 (
  start "mushijingi-server" cmd /k "npm start"
  timeout /t 3 >nul
) else (
  echo Server is already running.
)

start "" "http://localhost:3456/"

echo.
echo Done. This window will close in 3 seconds.
timeout /t 3 >nul
