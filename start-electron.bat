@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title Manga Voice Studio - Electron (Настоящее окно)

echo ========================================
echo  Manga Voice Studio - Electron режим
echo  Настоящее десктопное окно
echo ========================================
echo.

where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ОШИБКА] Node.js не найден. Запусти install.bat
    pause
    exit /b 1
)

:: Проверка порта
netstat -ano | findstr :3000 | findstr LISTENING >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    echo [ВНИМАНИЕ] Порт 3000 уже занят — возможно dev сервер уже запущен
)

if not exist node_modules (
    echo [INFO] Устанавливаю зависимости...
    if exist package-lock.json (
        call npm ci --legacy-peer-deps --no-audit --no-fund
    ) else (
        call npm install --legacy-peer-deps --no-audit --no-fund
    )
    rem См. start-browser.bat: внутри блока нужен отложенный ERRORLEVEL.
    if !ERRORLEVEL! NEQ 0 (
        echo [ОШИБКА] Установка не удалась
        pause
        exit /b 1
    )
)

:: Проверка electron — не модифицируем package.json, используем --no-save
if not exist node_modules\electron (
    echo [INFO] Устанавливаю Electron для оконного режима, без сохранения в package.json...
    call npm install --no-save electron --legacy-peer-deps --no-audit --no-fund
    if !ERRORLEVEL! NEQ 0 (
        echo [ОШИБКА] Не удалось установить Electron.
        echo   Бинарь Electron качается postinstall-скриптом, поэтому --ignore-scripts тут
        echo   не поможет: загрузчик будет пропущен и оконный режим всё равно не заработает.
        echo   В защищённой сети настройте npm proxy/https-proxy, поставьте Electron вручную
        echo   или используйте браузерный режим.
        echo [INFO] Fallback на Chrome App режим - запускаю start-window.bat
        call start-window.bat
        exit /b !ERRORLEVEL!
    )
)

rem Проверяем, что postinstall действительно скачал бинарь: npm мог установить пакет,
rem но не бинарь (прерванная загрузка, частичный кэш, ручной --ignore-scripts).
if not exist node_modules\electron\dist\electron.exe (
    echo [ОШИБКА] Пакет Electron есть, но бинарь не найден - postinstall не завершился.
    echo [INFO] Fallback на Chrome App режим - запускаю start-window.bat
    call start-window.bat
    exit /b 1
)

echo [INFO] Запускаю в Electron...
echo [INFO] Окно 1280x800, graphite тема, без вкладок браузера
echo.

:: Запуск Electron
call npx electron electron/main.js
set EXITCODE=%ERRORLEVEL%
echo [INFO] Electron закрыт с кодом %EXITCODE%
pause
endlocal
exit /b %EXITCODE%
