#!/usr/bin/env bash
# Удаление расширения и скрипта Kimi Code Limits Indicator
set -euo pipefail

echo "Деактивация и удаление расширения"
gnome-extensions disable kimi-status@panel.local 2>/dev/null || true
rm -rf "$HOME/.local/share/gnome-shell/extensions/kimi-status@panel.local"

echo "Удаление скрипта"
rm -rf "$HOME/.config/kimi-status"

echo "Готово."
