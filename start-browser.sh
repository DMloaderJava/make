#!/bin/bash
set -e

echo "========================================"
echo " Manga Voice Studio - Браузерный режим"
echo " http://localhost:3000"
echo "========================================"

# Проверка порта 3000
if command -v lsof >/dev/null 2>&1 && lsof -i :3000 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "[ОШИБКА] Порт 3000 уже занят. Закрой процесс: lsof -i :3000"
    exit 1
fi
if command -v ss >/dev/null 2>&1 && ss -tlnp 2>/dev/null | grep -q ":3000 "; then
    echo "[ОШИБКА] Порт 3000 уже занят (ss). Закрой процесс."
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

echo "[INFO] Открываю браузер через 5 сек..."
( sleep 5 && (xdg-open http://localhost:3000 2>/dev/null || open http://localhost:3000 2>/dev/null || echo "Открой http://localhost:3000") ) &

echo "[INFO] Запускаю dev сервер..."
npm run dev -- -H 0.0.0.0 -p 3000
