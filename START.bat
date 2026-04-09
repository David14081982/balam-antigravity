@echo off
title Balam Virtual Try-On — Iniciando...
color 0A

echo.
echo  ██████╗  ██████╗      ██╗██╗
echo  ██╔══██╗██╔═══██╗     ██║██║
echo  ██║  ██║██║   ██║     ██║██║
echo  ██║  ██║██║   ██║██   ██║██║
echo  ██████╔╝╚██████╔╝╚█████╔╝██║
echo  ╚═════╝  ╚═════╝  ╚════╝ ╚═╝
echo.
echo  Virtual Try-On Designer Fashion
echo  ─────────────────────────────────
echo.

:: ── Limpiar instancias viejas ───────────────────────────────────────────────
echo  [0/3] Cerrando instancias anteriores...
taskkill /F /IM node.exe >nul 2>&1
taskkill /F /IM http-server >nul 2>&1
timeout /t 1 /nobreak >nul
echo  [OK] Puerto 3018 liberado
echo.

:: ── Check Node.js ──────────────────────────────────────────────────────────
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
  echo  [ERROR] Node.js no encontrado.
  echo  Descarga Node.js en: https://nodejs.org/
  echo.
  pause
  exit /b 1
)

for /f "tokens=1" %%v in ('node --version') do set NODE_VER=%%v
echo  [OK] Node.js %NODE_VER% detectado
echo.

:: ── Install Backend dependencies ───────────────────────────────────────────
echo  [1/3] Instalando dependencias del backend...
cd /d "%~dp0doji-pwa\backend"
if not exist "node_modules" (
  call npm install --silent
  if %ERRORLEVEL% NEQ 0 (
    echo  [ERROR] Fallo al instalar backend. Verifica tu conexion a internet.
    pause
    exit /b 1
  )
)
echo  [OK] Backend listo
echo.

:: ── Create uploads/results directories ─────────────────────────────────────
if not exist "%~dp0doji-pwa\backend\uploads" mkdir "%~dp0doji-pwa\backend\uploads"
if not exist "%~dp0doji-pwa\backend\results" mkdir "%~dp0doji-pwa\backend\results"

:: ── Start Backend ───────────────────────────────────────────────────────────
echo  [2/3] Iniciando servidores...
echo.

start "Balam Backend (Puerto 3018)" cmd /k "cd /d "%~dp0doji-pwa\backend" && color 0B && echo  BALAM BACKEND - API && echo  ─────────────────── && node server.js"

:: Wait for backend to be ready
timeout /t 2 /nobreak >nul

:: ── Start Frontend ──────────────────────────────────────────────────────────
echo  [3/3] Iniciando frontend...
start "Balam Frontend (Puerto 3000)" cmd /k "cd /d "%~dp0" && color 0E && echo  BALAM FRONTEND - PWA && echo  ─────────────────── && npx http-server . -p 3000 -c-1 --cors"

:: ── Wait and open browser ───────────────────────────────────────────────────
timeout /t 3 /nobreak >nul

echo.
echo  ─────────────────────────────────────────────
echo  ✅  Balam está corriendo:
echo.
echo     Frontend PWA:  http://localhost:3000
echo     Backend API:   http://localhost:3018/api
echo     API Health:    http://localhost:3018/api/health
echo.
echo  Para detener: cierra las ventanas del backend y frontend
echo  ─────────────────────────────────────────────
echo.

:: Open browser if not already opened
start "" "http://localhost:3000"

echo  Presiona cualquier tecla para cerrar este mensaje...
pause >nul
