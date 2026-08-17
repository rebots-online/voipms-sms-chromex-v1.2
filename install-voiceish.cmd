@echo off
setlocal
cd /d "%~dp0services\reseller-gateway"
where node >nul 2>nul || (echo Voice-ish requires Node.js 20 or newer. & exit /b 1)
where npm >nul 2>nul || (echo Voice-ish requires npm. & exit /b 1)
call npm install || exit /b 1
call npm run setup
