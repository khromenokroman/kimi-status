# Kimi Code Limits Indicator

GNOME Shell расширение, показывающее остаток лимитов Kimi Code в панели:
процент использованного 5-часового окна и месячного лимита, с деталями в меню.

Аналог [claude-status](https://github.com/khromenokroman/claude-status), но для Kimi.

## Как это работает

- `kimi_usage.py` читает OAuth-токен из `~/.kimi-code/credentials/kimi-code-env-*.json`.
  Если `access_token` истёк, скрипт обновляет его через `https://auth.kimi.ai/api/oauth/token`
  по `refresh_token` и записывает обратно в credentials.
- Затем делает GET `https://api.kimi.ai/coding/v1/usages` (и `/me` для ника и тарифа).
  Все запросы идут с `User-Agent: kimi-code-cli/<ver>` и заголовками `X-Msh-*`
  как у официального CLI: Cloudflare (`api.kimi.ai`) блокирует запросы без этих
  заголовков ошибкой 1010.
- Расширение вызывает скрипт каждые 5 минут, показывает на панели
  `5ч: X% | мес: Y%`, в меню: 5ч/7д/месяц окна с временем до сброса,
  баланс бустеров (если есть), тариф и ник, ссылка на kimi.com/code.

## Установка

```bash
./install.sh
gnome-extensions enable kimi-status@panel.local
```

или перенесите `gnome-extension/` в
`~/.local/share/gnome-shell/extensions/kimi-status@panel.local/` и
`kimi_usage.py` в `~/.config/kimi-status/`.

## Удаление

```bash
./uninstall.sh
```

## Настройка

- `KIMI_CODE_BASE_URL` (переменная окружения для скрипта) позволяет переопределить
  базовый URL API (по умолчанию `https://api.kimi.ai/coding/v1`).
- Интервал обновления: `REFRESH_INTERVAL_SECONDS` в `gnome-extension/extension.js`
  (по умолчанию 300 секунд).

## Формат JSON скрипта

```json
{
  "ok": true,
  "user": {"user_id": "...", "nickname": "...", "user_level_name": "Pro"},
  "five_hour": {"utilization": 0.0, "resets_at": "2026-11-08T13:54:33Z"},
  "seven_day": null,
  "month_total": {"utilization": 22.6, "resets_at": "2026-12-02T00:00:00Z"},
  "month_code": {"utilization": 22.6, "resets_at": "2026-12-02T00:00:00Z"},
  "booster": null
}
```

- `utilization` — процент (0-100+).
- `seven_day` может отсутствовать, если у тарифа нет недельного окна.
- `booster` — баланс бустеров: `balance`, `total`, `currency`, месячный лимит.
