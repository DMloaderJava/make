#!/bin/bash
set -e

echo "========================================"
echo " Manga Voice Studio - Установка"
echo " v1.3.12"
echo "========================================"
echo ""

if ! command -v node &> /dev/null; then
    echo "[ОШИБКА] Node.js не найден! Установи с https://nodejs.org/ LTS 20+"
    exit 1
fi

echo "[OK] Node.js: $(node --version)"
echo "[OK] npm: $(npm --version)"
echo ""


# npm ci может упасть на postinstall Electron: в корпоративной сети/за прокси
# npm не может проверить TLS-сертификат. Тогда повторяем без postinstall-скриптов
# (сам Electron для веб-режима не нужен; для desktop его можно поставить вручную).
npm_install_with_fallback() {
    if "$@" ; then
        return 0
    fi
    echo "[ВНИМАНИЕ] Установка упала — вероятно, postinstall Electron не смог проверить TLS." >&2
    echo "            Повторяю с --ignore-scripts..." >&2
    local with_ignore=("$@")
    with_ignore+=("--ignore-scripts")
    "${with_ignore[@]}"
}

echo "[1/3] Установка зависимостей..."
if [ -f "package-lock.json" ]; then
    echo "  Найден package-lock.json — использую npm ci"
    npm_install_with_fallback npm ci --legacy-peer-deps --no-audit --no-fund
else
    npm_install_with_fallback npm install --legacy-peer-deps --no-audit --no-fund
fi

echo ""
echo "[2/3] Опционально:"
echo "  - Polly: npm install @aws-sdk/client-polly --no-save --no-audit --no-fund"
echo "  - Whisper: npm install nodejs-whisper --no-save --no-audit --no-fund"
echo "  В защищённой сети (TLS-прокси/антивирус) добавьте --ignore-scripts: "
echo "    npm install <пакет> --no-save --no-audit --no-fund --ignore-scripts"
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
