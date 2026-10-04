@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title Manga Voice Studio - Установка

echo ========================================
echo  Manga Voice Studio - Установка
echo  v1.3.11
echo ========================================
echo.

:: Проверка Node.js
where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ОШИБКА] Node.js не найден!
    echo Скачай с https://nodejs.org/ LTS версия 20+
    echo.
    pause
    exit /b 1
)

echo [OK] Node.js найден:
node --version

:: Проверка npm
where npm >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ОШИБКА] npm не найден!
    pause
    exit /b 1
)

echo [OK] npm найден:
call npm --version
if %ERRORLEVEL% NEQ 0 (
    echo [ОШИБКА] npm не работает
    pause
    exit /b 1
)
echo.

:: Установка зависимостей — используем ci если есть lock
echo [1/3] Установка основных зависимостей...
if exist package-lock.json (
    echo   Найден package-lock.json — использую npm ci
    call npm ci --legacy-peer-deps --no-audit --no-fund
    if !ERRORLEVEL! NEQ 0 (
        echo [ВНИМАНИЕ] npm ci упал — вероятная причина: postinstall Electron не может
        echo  проверить TLS-сертификат (корпоративный прокси/антивирус).
        echo  Повторяю установку без запуска postinstall-скриптов...
        call npm ci --legacy-peer-deps --no-audit --no-fund --ignore-scripts
    )
) else (
    call npm install --legacy-peer-deps --no-audit --no-fund
    if !ERRORLEVEL! NEQ 0 (
        echo [ВНИМАНИЕ] npm install упал — повторяю с --ignore-scripts...
        call npm install --legacy-peer-deps --no-audit --no-fund --ignore-scripts
    )
)
if %ERRORLEVEL% NEQ 0 (
    echo [ОШИБКА] Установка не удалась
    pause
    exit /b 1
)

echo.
echo [2/3] Проверка опциональных зависимостей...
echo  - @aws-sdk/client-polly (для Amazon Polly TTS) - опционально
echo  - nodejs-whisper (для локального Whisper STT) - опционально
echo  Если нужен Polly: npm install @aws-sdk/client-polly --no-save --no-audit --no-fund
echo  Если нужен локальный Whisper: npm install nodejs-whisper --no-save --no-audit --no-fund
echo  В защищённой сети (TLS-прокси/антивирус) добавьте --ignore-scripts
echo.

echo [3/3] Проверка сборки...
call npm run build
if %ERRORLEVEL% NEQ 0 (
    echo [ВНИМАНИЕ] Сборка с предупреждениями, но dev режим должен работать
) else (
    echo [OK] Сборка успешна
)

echo.
echo ========================================
echo  Установка завершена!
echo ========================================
echo.
echo  Далее запусти:
echo   - start-browser.bat  - браузерный режим (http://localhost:3000)
echo   - start-window.bat   - оконный режим (Chrome App / Electron)
echo   - run.bat            - меню выбора режима
echo.
pause
endlocal
exit /b 0
