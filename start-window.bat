@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title Manga Voice Studio - Оконный режим

echo ========================================
echo  Manga Voice Studio - Оконный режим
echo  Отдельное окно без вкладок браузера
echo ========================================
echo.

where node >nul 2>nul
if %ERRORLEVEL% NEQ 0 (
    echo [ОШИБКА] Node.js не найден. Запусти install.bat
    pause
    exit /b 1
)

:: Проверка порта 3000 заранее
netstat -ano | findstr :3000 | findstr LISTENING >nul 2>nul
if %ERRORLEVEL% EQU 0 (
    echo [ОШИБКА] Порт 3000 уже занят. Закрой процесс или используй другой порт.
    echo   netstat -ano ^| findstr :3000
    pause
    exit /b 1
)

if not exist node_modules (
    echo [INFO] Устанавливаю зависимости...
    if exist package-lock.json (
        call npm ci --legacy-peer-deps
    ) else (
        call npm install --legacy-peer-deps
    )
    if !ERRORLEVEL! NEQ 0 (
        echo [ОШИБКА] Установка не удалась
        pause
        exit /b 1
    )
)

:: Проверка Chrome / Edge для app режима
set CHROME_FOUND=0
set EDGE_FOUND=0

where chrome >nul 2>nul
if %ERRORLEVEL% EQU 0 set CHROME_FOUND=1

if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set CHROME_FOUND=1
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set CHROME_FOUND=1
if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" set CHROME_FOUND=1

if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" set EDGE_FOUND=1
if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" set EDGE_FOUND=1

:: Очистка старого PID файла (если процесс уже мертв)
:: Фикс: tasklist всегда возвращает 0, проверяем через find
if exist .dev-window.pid (
    for /f %%i in (.dev-window.pid) do (
        tasklist /FI "PID eq %%i" 2>nul | find "%%i" >nul
        if !ERRORLEVEL! NEQ 0 (
            echo [INFO] Старый PID файл от мертвого процесса — удаляю
            del .dev-window.pid 2>nul
        ) else (
            echo [ВНИМАНИЕ] Найден старый .dev-window.pid с живым PID %%i — пробую остановить
            taskkill /PID %%i /T /F >nul 2>nul
            del .dev-window.pid 2>nul
            timeout /t 2 /nobreak >nul
        )
    )
)

echo [INFO] Запускаю Next.js сервер в фоне (PID сохраняется в .dev-window.pid)...
:: Запускаем через PowerShell чтобы получить PID и убивать только его дерево
:: Deadlock fix: перенаправление > .dev-window.log делается внутри cmd /c, а не в PowerShell pipeline
powershell -NoProfile -Command "$p=Start-Process -FilePath 'cmd' -ArgumentList '/c npm run dev -- -H 0.0.0.0 -p 3000 > .dev-window.log 2>&1' -WindowStyle Minimized -PassThru; $p.Id | Out-File -FilePath '.dev-window.pid' -Encoding ascii"

if not exist .dev-window.pid (
    echo [ОШИБКА] Не удалось создать PID файл
    pause
    exit /b 1
)

echo [INFO] Жду запуска сервера (http://localhost:3000)...
set ATTEMPTS=0
:WAIT_LOOP
set /a ATTEMPTS+=1
if %ATTEMPTS% GTR 60 (
    echo [ОШИБКА] Сервер не запустился за 120 секунд. Смотри .dev-window.log
    type .dev-window.log
    goto CLEANUP_FAIL
)
timeout /t 2 /nobreak >nul

:: Проверяем что процесс еще жив — через find, т.к. tasklist ERRORLEVEL всегда 0
if exist .dev-window.pid (
    for /f %%i in (.dev-window.pid) do (
        tasklist /FI "PID eq %%i" 2>nul | find "%%i" >nul
        if !ERRORLEVEL! NEQ 0 (
            echo [ОШИБКА] Процесс сервера умер. Лог:
            type .dev-window.log 2>nul
            del .dev-window.pid 2>nul
            pause
            exit /b 1
        )
    )
)

:: Проверяем TCP порт 3000 открыт (не зависит от HTTP статуса, работает с MVS_PASSWORD=401)
powershell -NoProfile -Command "try { $c=New-Object System.Net.Sockets.TcpClient; $c.Connect('127.0.0.1',3000); $c.Close(); exit 0 } catch { exit 1 }"
if %ERRORLEVEL% NEQ 0 (
    echo   ... ещё не готов, жду (%ATTEMPTS%/60)
    goto WAIT_LOOP
)

echo [OK] Сервер готов!
echo.

if %CHROME_FOUND%==1 (
    echo [INFO] Запускаю в Chrome App режиме (1280x800)...
    if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
        start "" "%ProgramFiles%\Google\Chrome\Application\chrome.exe" --app=http://localhost:3000 --window-size=1280,800 --window-position=100,100
        goto END
    )
    if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
        start "" "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" --app=http://localhost:3000 --window-size=1280,800
        goto END
    )
    if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" (
        start "" "%LocalAppData%\Google\Chrome\Application\chrome.exe" --app=http://localhost:3000 --window-size=1280,800
        goto END
    )
    start "" chrome --app=http://localhost:3000 --window-size=1280,800
    goto END
)

if %EDGE_FOUND%==1 (
    echo [INFO] Chrome не найден, запускаю в Edge App режиме...
    if exist "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" (
        start "" "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe" --app=http://localhost:3000 --window-size=1280,800
        goto END
    )
    if exist "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" (
        start "" "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe" --app=http://localhost:3000 --window-size=1280,800
        goto END
    )
    start "" msedge --app=http://localhost:3000 --window-size=1280,800
    goto END
)

echo [ВНИМАНИЕ] Chrome/Edge не найдены для app режима
echo [INFO] Открываю в обычном браузере...
start http://localhost:3000

:END
echo.
echo ========================================
echo  Оконный режим запущен!
echo  Сервер: http://localhost:3000
echo  Лог: .dev-window.log
echo  PID: .dev-window.pid
echo  Для остановки нажми любую клавишу — убьётся только этот сервер
echo ========================================
echo.
echo Нажми любую клавишу чтобы остановить сервер...
pause >nul

:: Остановка сервера — только PID из файла, не все node.exe
:: Фикс: проверяем через find, т.к. tasklist ERRORLEVEL ненадёжен
echo [INFO] Останавливаю сервер...
if exist .dev-window.pid (
    for /f %%i in (.dev-window.pid) do (
        echo   Убиваю дерево PID %%i
        tasklist /FI "PID eq %%i" 2>nul | find "%%i" >nul
        if !ERRORLEVEL! EQU 0 (
            taskkill /PID %%i /T /F 2>nul
        ) else (
            echo   PID %%i уже мертв
        )
    )
    del .dev-window.pid 2>nul
) else (
    echo   PID файл не найден, пробую по порту 3000
    for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3000 ^| findstr LISTENING') do (
        echo   Убиваю PID %%a по порту
        taskkill /PID %%a /T /F 2>nul
    )
)
echo [OK] Готово
pause
endlocal
exit /b 0

:CLEANUP_FAIL
if exist .dev-window.pid (
    for /f %%i in (.dev-window.pid) do taskkill /PID %%i /T /F >nul 2>nul
    del .dev-window.pid 2>nul
)
pause
endlocal
exit /b 1
