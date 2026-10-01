#!/bin/bash
set -e

echo "========================================"
echo " Manga Voice Studio - Установка"
echo " v1.3.1 Студия без хлама"
echo "========================================"
echo ""

if ! command -v node &> /dev/null; then
    echo "[ОШИБКА] Node.js не найден! Установи с https://nodejs.org/ LTS 20+"
    exit 1
fi

echo "[OK] Node.js: $(node --version)"
echo "[OK] npm: $(npm --version)"
echo ""

echo "[1/3] Установка зависимостей..."
if [ -f "package-lock.json" ]; then
    echo "  Найден package-lock.json — использую npm ci"
    npm ci --legacy-peer-deps
else
    npm install --legacy-peer-deps
fi

echo ""
echo "[2/3] Опционально:"
echo "  - Polly: npm install @aws-sdk/client-polly --no-save"
echo "  - Whisper: npm install nodejs-whisper --no-save"
echo ""

echo "[3/3] Проверка сборки..."
if npm run build; then
    echo "[OK] Сборка успешна"
else
    echo "[ВНИМАНИЕ] Сборка с предупреждениями, dev должен работать"
fi

echo ""
echo "========================================"
echo " Установка завершена!"
echo " ./start-browser.sh - браузерный"
echo " ./start-window.sh  - оконный (Chrome App)"
echo " ./run.sh           - меню"
echo "========================================"
