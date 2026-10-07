@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title Manga Voice Studio - Launcher

:MENU
cls
echo ========================================
echo  Manga Voice Studio v1.3.15
echo  Студия без хлама - Launcher
echo ========================================
echo.
echo  1. Установить зависимости (install.bat)
echo  2. Браузерный режим - http://localhost:3000
echo  3. Оконный режим - отдельное окно (Chrome App)
echo  4. Production build + start (для релиза)
echo  5. Настройки провайдеров (открыть /settings)
echo  6. Выход
echo.
set "choice="
set /p "choice=Выбери режим [1-6]: "
:: Трим пробелов
set "choice=%choice: =%"
if "%choice%"=="" (
    echo Неверный выбор
    timeout /t 1 >nul
    goto MENU
)

if "%choice%"=="1" goto INSTALL
if "%choice%"=="2" goto BROWSER
if "%choice%"=="3" goto WINDOW
if "%choice%"=="4" goto PROD
if "%choice%"=="5" goto SETTINGS
if "%choice%"=="6" goto EXIT

echo Неверный выбор: %choice%
timeout /t 2 >nul
goto MENU

:INSTALL
call install.bat
if !ERRORLEVEL! NEQ 0 echo [ОШИБКА] Установка завершилась с ошибкой
pause
goto MENU

:BROWSER
call start-browser.bat
if !ERRORLEVEL! NEQ 0 echo [ОШИБКА] Браузерный режим завершился с ошибкой
pause
goto MENU

:WINDOW
call start-window.bat
if !ERRORLEVEL! NEQ 0 echo [ОШИБКА] Оконный режим завершился с ошибкой
pause
goto MENU

:PROD
echo [INFO] Собираю production build...
call npm run build
if !ERRORLEVEL! NEQ 0 (
    echo [ОШИБКА] Build failed
    pause
    goto MENU
)
echo [OK] Build готов, запускаю production сервер...
call npm run start -- -H 0.0.0.0 -p 3000
if !ERRORLEVEL! NEQ 0 echo [ОШИБКА] Production сервер упал
pause
goto MENU

:SETTINGS
echo [INFO] Запускаю сервер и открываю /settings...
:: Проверяем порт перед запуском
netstat -ano | findstr :3000 | findstr LISTENING >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    echo [INFO] Порт 3000 уже занят — открываю /settings в браузере
    start http://localhost:3000/settings
    pause
    goto MENU
)
start /B cmd /c "timeout /t 3 /nobreak >nul && start http://localhost:3000/settings"
call npm run dev -- -H 0.0.0.0 -p 3000
goto MENU

:EXIT
endlocal
exit /b 0
