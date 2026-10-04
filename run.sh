#!/bin/bash
set -e

# Проверка порта helper
check_port() {
    if command -v lsof >/dev/null 2>&1 && lsof -i :3000 -sTCP:LISTEN >/dev/null 2>&1; then
        return 1
    fi
    return 0
}

while true; do
    clear
    echo "========================================"
    echo " Manga Voice Studio v1.3.14 - Launcher"
    echo "========================================"
    echo ""
    echo " 1. Установить зависимости"
    echo " 2. Браузерный режим - http://localhost:3000"
    echo " 3. Оконный режим - Chrome App 1280x800"
    echo " 4. Electron режим - настоящее десктоп окно"
    echo " 5. Production build + start"
    echo " 6. Настройки провайдеров /settings"
    echo " 7. Выход"
    echo ""
    read -p "Выбери [1-7]: " choice
    choice=$(echo "$choice" | tr -d ' ')

    case $choice in
        1) ./install.sh || echo "[ОШИБКА] Установка упала"; read -p "Enter..." ;;
        2) ./start-browser.sh || echo "[ОШИБКА] Браузерный режим упал с кодом $?"; read -p "Enter..." ;;
        3) ./start-window.sh || echo "[ОШИБКА] Оконный режим упал с кодом $?"; read -p "Enter..." ;;
        4) 
            if [ ! -d "node_modules/electron" ]; then
                echo "[INFO] Устанавливаю Electron (без сохранения)..."
                npm install --no-save electron --legacy-peer-deps --no-audit --no-fund || { echo "[ОШИБКА] Electron не установлен: бинарь качается postinstall-скриптом, --ignore-scripts не поможет. Настройте npm proxy или используйте браузерный режим."; read -p "Enter..."; continue; }
            fi
            npx electron electron/main.js || echo "[ОШИБКА] Electron упал"
            read -p "Enter..."
            ;;
        5) 
            if npm run build; then
                npm run start -- -H 0.0.0.0 -p 3000
            else
                echo "[ОШИБКА] Build failed"
                read -p "Enter..."
            fi
            ;;
        6) 
            if ! check_port; then
                echo "[INFO] Порт 3000 уже занят — открываю /settings"
                xdg-open http://localhost:3000/settings 2>/dev/null || open http://localhost:3000/settings 2>/dev/null || echo "Открой http://localhost:3000/settings"
                read -p "Enter..."
            else
                ( sleep 3 && xdg-open http://localhost:3000/settings 2>/dev/null || open http://localhost:3000/settings 2>/dev/null ) &
                npm run dev -- -H 0.0.0.0 -p 3000 || echo "[ОШИБКА] dev упал"
            fi
            ;;
        7) exit 0 ;;
        *) echo "Неверный выбор: $choice"; sleep 1 ;;
    esac
done
