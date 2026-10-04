@echo off
setlocal
chcp 65001 >nul
title Manga Voice Studio - Браузерный режим

echo ========================================
echo  Manga Voice Studio - Браузерный режим
echo  http://localhost:3000
echo ========================================
echo.

where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ОШИБКА] Node.js не найден. Запусти install.bat
    pause
    exit /b 1
)

:: Проверка порта 3000
netstat -ano | findstr :3000 | findstr LISTENING >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    echo [ОШИБКА] Порт 3000 уже занят. Закрой другой процесс или смени PORT.
    echo   netstat -ano ^| findstr :3000
    pause
    exit /b 1
)

if not exist node_modules (
    echo [INFO] node_modules не найден, устанавливаю...
    if exist package-lock.json (
        call npm ci --legacy-peer-deps --no-audit --no-fund
    ) else (
        call npm install --legacy-peer-deps --no-audit --no-fund
    )
    if %ERRORLEVEL% NEQ 0 (
        echo [ОШИБКА] Установка зависимостей не удалась
        pause
        exit /b 1
    )
)

echo [INFO] Запускаю dev сервер...
echo [INFO] После запуска откроется браузер на http://localhost:3000
echo [INFO] Для остановки нажми Ctrl+C
echo.

:: Запуск браузера через 5 сек в фоне
start /B cmd /c "timeout /t 5 /nobreak >nul && start http://localhost:3000"

:: Запуск Next.js (blocking)
call npm run dev -- -H 0.0.0.0 -p 3000
set EXITCODE=%ERRORLEVEL%
if %EXITCODE% NEQ 0 (
    echo [ОШИБКА] Dev сервер завершился с кодом %EXITCODE%
    pause
    exit /b %EXITCODE%
)

endlocal
exit /b 0
