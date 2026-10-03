#!/bin/bash
set -e

echo "========================================"
echo " Manga Voice Studio - Оконный режим"
echo "========================================"

# Проверка порта
if command -v lsof >/dev/null 2>&1 && lsof -i :3000 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[ОШИБКА] Порт 3000 уже занят. Закрой процесс: lsof -i :3000"
    exit 1
fi

if [ ! -d "node_modules" ]; then
    echo "[INFO] Устанавливаю зависимости..."
    if [ -f "package-lock.json" ]; then
        npm ci --legacy-peer-deps --no-audit --no-fund
    else
        npm install --legacy-peer-deps --no-audit --no-fund
    fi
fi

# Очистка старого лога/pid
rm -f .dev-window.pid
rm -f .dev-window.log

echo "[INFO] Запускаю сервер в фоне (process group)..."
# Запускаем в отдельной группе чтобы убить дерево
# setsid создаёт новую сессию, pgid == pid, поэтому $! — это PID группы
# и kill -TERM -$PID убивает всю группу (npm + node + next). 
# setsid exec'ает команду, так что PID setsid == PID npm (проверено на Linux)
# Если setsid нет (macOS без coreutils), fallback на обычный &
if command -v setsid >/dev/null 2>&1; then
    setsid npm run dev -- -H 0.0.0.0 -p 3000 > .dev-window.log 2>&1 &
    SERVER_PID=$!
else
    npm run dev -- -H 0.0.0.0 -p 3000 > .dev-window.log 2>&1 &
    SERVER_PID=$!
fi
echo $SERVER_PID > .dev-window.pid
echo "[INFO] PID $SERVER_PID (pgid) сохранен в .dev-window.pid"

cleanup() {
    echo ""
    echo "[INFO] Останавливаю сервер (PID $SERVER_PID, дерево)..."
    # Убить детей
    if command -v pkill >/dev/null 2>&1; then
        pkill -TERM -P $SERVER_PID 2>/dev/null || true
        sleep 1
        pkill -KILL -P $SERVER_PID 2>/dev/null || true
    fi
    # Убить группу
    kill -TERM -$SERVER_PID 2>/dev/null || kill -TERM $SERVER_PID 2>/dev/null || true
    sleep 2
    kill -KILL -$SERVER_PID 2>/dev/null || kill -KILL $SERVER_PID 2>/dev/null || true
    rm -f .dev-window.pid
    echo "[OK] Готово"
    exit 0
}
trap cleanup INT TERM EXIT

echo "[INFO] Жду сервер http://localhost:3000 (принимаю 200/401/302)..."
READY=0
for i in {1..60}; do
    # Проверяем что процесс еще жив
    if ! kill -0 $SERVER_PID 2>/dev/null; then
        echo "[ОШИБКА] Сервер умер. Лог:"
        cat .dev-window.log 2>/dev/null || true
        exit 1
    fi
    # Проверяем TCP порт открыт (не зависит от MVS_PASSWORD)
    if command -v curl >/dev/null 2>&1; then
        HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000 2>/dev/null || echo "000")
        if [[ "$HTTP_CODE" == "200" || "$HTTP_CODE" == "401" || "$HTTP_CODE" == "302" || "$HTTP_CODE" == "301" ]]; then
            READY=1
            break
        fi
    else
        # Fallback: nc check
        if command -v nc >/dev/null 2>&1 && nc -z 127.0.0.1 3000 2>/dev/null; then
            READY=1
            break
        fi
        # Last resort: try /dev/tcp
        if (echo > /dev/tcp/127.0.0.1/3000) 2>/dev/null; then
            READY=1
            break
        fi
    fi
    echo "  ... жду ($i/60) code=${HTTP_CODE:-?}"
    sleep 2
done

if [ $READY -eq 0 ]; then
    echo "[ОШИБКА] Сервер не запустился за 120с. Лог:"
    cat .dev-window.log 2>/dev/null || true
    exit 1
fi

echo "[OK] Сервер готов!"

# Try Chrome App mode
if command -v google-chrome &> /dev/null; then
    echo "[INFO] Chrome App режим 1280x800..."
    trap - EXIT
    google-chrome --app=http://localhost:3000 --window-size=1280,800 || true
    cleanup
elif command -v chromium-browser &> /dev/null; then
    trap - EXIT
    chromium-browser --app=http://localhost:3000 --window-size=1280,800 || true
    cleanup
elif command -v chromium &> /dev/null; then
    trap - EXIT
    chromium --app=http://localhost:3000 --window-size=1280,800 || true
    cleanup
else
    echo "[INFO] Chrome не найден, открываю обычный браузер..."
    xdg-open http://localhost:3000 2>/dev/null || open http://localhost:3000 2>/dev/null || echo "Открой http://localhost:3000"
    echo "Нажми Enter чтобы остановить сервер..."
    read
    cleanup
fi
