#!/usr/bin/env bash
# Установка скрипта и расширения Kimi Code Limits Indicator
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/kimi-status@panel.local"
CONFIG_DIR="$HOME/.config/kimi-status"

echo "Установка скрипта в $CONFIG_DIR"
mkdir -p "$CONFIG_DIR"
cp "$PROJECT_DIR/kimi_usage.py" "$CONFIG_DIR/kimi_usage.py"
chmod +x "$CONFIG_DIR/kimi_usage.py"

echo "Установка расширения в $EXT_DIR"
rm -rf "$EXT_DIR"
mkdir -p "$EXT_DIR"
cp "$PROJECT_DIR/gnome-extension/extension.js" "$EXT_DIR/"
cp "$PROJECT_DIR/gnome-extension/metadata.json" "$EXT_DIR/"

echo
echo "Готово. Активируйте расширение:"
echo "  gnome-extensions enable kimi-status@panel.local"
echo "или через Настройки -> Расширения."
echo
echo "Проверка скрипта:"
echo "  $CONFIG_DIR/kimi_usage.py"
