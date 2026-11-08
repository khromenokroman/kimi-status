#!/usr/bin/env python3
"""
Скрипт получения лимитов Kimi Code из API Kimi.

Читает OAuth-токен из ~/.kimi-code/credentials/kimi-code-env-*.json,
при необходимости обновляет его через https://auth.kimi.ai/api/oauth/token
и ходит на https://api.kimi.ai/coding/v1/usages.

Важно: Cloudflare блокирует запросы к api.kimi.ai без «browsersких» заголовков
клиента CLI, поэтому все запросы уходят с User-Agent и заголовками X-Msh-*.

Формат вывода:
{
  "ok": true,
  "user": {"user_id": "...", "nickname": "...", "user_level_name": "..."},
  "five_hour": {"utilization": 1.23, "resets_at": "2026-..."},
  "seven_day": {"utilization": 4.56, "resets_at": "2026-..."},
  "month_total": {"utilization": 0.1, "resets_at": "..."},
  "month_code": {"utilization": 0.05, "resets_at": "..."},
  "booster": {"balance": 12.5, "total": 100.0, "currency": "USD", ...}
}

При ошибке:
{
  "ok": false,
  "error": "описание ошибки"
}

Exit code: 0 при успехе, 1 при ошибке.
"""

import json
import os
import socket
import sys
import time
import urllib.parse
import urllib.request
import urllib.error
from datetime import datetime, timezone
from pathlib import Path

KIMI_HOME = Path.home() / ".kimi-code"
CREDENTIALS_DIR = KIMI_HOME / "credentials"
OAUTH_HOST = "https://auth.kimi.ai"
API_BASE_URL = os.environ.get("KIMI_CODE_BASE_URL", "https://api.kimi.ai/coding/v1")
CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098"
PRODUCT = "kimi-code-cli"
PLATFORM = "kimi_code_cli"
CLI_VERSION = "2.5.2"
TIMEOUT_SECONDS = 15


def eprint(*args):
    print(*args, file=sys.stderr)


def cli_version():
    """Версия CLI: из файла, если есть, иначе константа."""
    try:
        return (KIMI_HOME / "version").read_text().strip() or CLI_VERSION
    except Exception:
        return CLI_VERSION


def ascii(value, fallback="unknown"):
    """Только ASCII-принтабельные символы, как в CLI."""
    cleaned = str(value).encode("ascii", "ignore").decode().strip()
    return cleaned if cleaned else fallback


def build_headers():
    """Заголовки, как у официального CLI (нужны, чтобы пройти Cloudflare)."""
    try:
        device_id = (KIMI_HOME / "device_id").read_text().strip()
    except Exception:
        device_id = "unknown"
    version = cli_version()
    return {
        "User-Agent": f"{PRODUCT}/{version}",
        "X-Msh-Platform": PLATFORM,
        "X-Msh-Version": version,
        "X-Msh-Device-Name": ascii(os.uname().nodename),
        "X-Msh-Device-Model": ascii(socket.gethostname()),
        "X-Msh-Os-Version": ascii(os.uname().release),
        "X-Msh-Device-Id": device_id,
        "Accept": "application/json",
    }


def find_credentials_file():
    """Ищем credentials-файл (kimi-code-env-*.json), берём самый свежий."""
    if not CREDENTIALS_DIR.is_dir():
        raise FileNotFoundError(f"Не найдена папка: {CREDENTIALS_DIR}")
    files = sorted(
        CREDENTIALS_DIR.glob("kimi-code-env-*.json"),
        key=lambda p: p.stat().st_mtime,
        reverse=True,
    )
    if not files:
        raise FileNotFoundError(f"Нет файлов credentials в {CREDENTIALS_DIR}")
    return files[0]


def read_credentials(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def write_credentials(path, data):
    tmp = path.with_suffix(".json.tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    tmp.replace(path)


def post_form(url, params, headers):
    """POST form-данных, возвращает (status, json)."""
    body = urllib.parse.urlencode(params).encode()
    h = dict(headers)
    h["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=body, headers=h, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", errors="replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"error": raw[:300]}


def refresh_access_token(path, refresh_token):
    """Обновляет access_token по refresh_token, записывает в credentials."""
    url = OAUTH_HOST.rstrip("/") + "/api/oauth/token"
    status, data = post_form(url, {
        "client_id": CLIENT_ID,
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
    }, build_headers())
    if not isinstance(data, dict) or status != 200 \
            or not isinstance(data.get("access_token"), str):
        detail = data.get("error_description") or data.get("error") \
            if isinstance(data, dict) else f"HTTP {status}"
        raise RuntimeError(f"Refresh токена не удался: {detail}")
    creds = {
        "access_token": data["access_token"],
        "refresh_token": data.get("refresh_token") or refresh_token,
        "expires_at": int(time.time()) + int(data.get("expires_in", 3600)),
        "scope": data.get("scope", "kimi-code"),
        "token_type": data.get("token_type", "Bearer"),
    }
    write_credentials(path, creds)
    return creds["access_token"]


def get_access_token():
    """Читает токен, при истечении обновляет."""
    path = find_credentials_file()
    creds = read_credentials(path)
    access = creds.get("access_token")
    if not access:
        raise KeyError("В credentials нет access_token")
    expires_at = creds.get("expires_at")
    if expires_at and time.time() > expires_at - 60:
        eprint("INFO: access_token истёк, обновляю через refresh_token")
        access = refresh_access_token(path, creds["refresh_token"])
    return access


def api_get(url, token, extra_headers=None):
    h = dict(build_headers())
    h["Authorization"] = f"Bearer {token}"
    if extra_headers:
        h.update(extra_headers)
    req = urllib.request.Request(url, headers=h, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as resp:
            if resp.status != 200:
                raise RuntimeError(f"HTTP {resp.status}")
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        body = ""
        try:
            body = e.read().decode("utf-8", errors="replace")[:300]
        except Exception:
            pass
        raise RuntimeError(f"HTTP {e.code}: {body}")


def usage_entry(raw):
    """parseQuotaEntry: used_ratio (доля 0..N) + reset_time."""
    if not isinstance(raw, dict):
        return None
    ratio = raw.get("used_ratio")
    if not isinstance(ratio, (int, float)):
        return None
    result = {"utilization": float(ratio) * 100.0}
    reset = raw.get("reset_time")
    if isinstance(reset, str) and reset:
        result["resets_at"] = reset
    return result


def money_cents(money):
    if isinstance(money, dict) and isinstance(money.get("priceInCents"), (int, float)):
        return money["priceInCents"] / 1e6, money.get("currency", "")
    return 0.0, ""


def parse_booster(raw):
    """parseBoosterWallet: баланс бустеров в денежных единицах."""
    if not isinstance(raw, dict):
        return None
    balance = raw.get("balance")
    if not isinstance(balance, dict) or balance.get("type") != "BOOSTER":
        return None
    amount = balance.get("amount")
    if not isinstance(amount, (int, float)) or amount <= 0:
        return None
    total = amount / 1e6
    amount_left = balance.get("amountLeft")
    left = (amount_left / 1e6) if isinstance(amount_left, (int, float)) else 0.0
    if 0 < total < 1:
        total = 1.0
    if 0 < left < 1:
        left = 1.0
    limit_cents, currency = money_cents(raw.get("monthlyChargeLimit"))
    used_cents, used_currency = money_cents(raw.get("monthlyUsed"))
    return {
        "balance": round(left, 2),
        "total": round(total, 2),
        "currency": currency or used_currency or "USD",
        "monthly_limit_enabled": raw.get("monthlyChargeLimitEnabled") is True,
        "monthly_limit": round(limit_cents, 2),
        "monthly_used": round(used_cents, 2),
    }


def fetch_user_info(token):
    """GET /me, не критично, глотаем ошибки."""
    try:
        raw = api_get(API_BASE_URL.rstrip("/") + "/me", token)
        if isinstance(raw, dict) and raw.get("user_id"):
            return {
                "user_id": raw.get("user_id"),
                "nickname": raw.get("nickname") or "",
                "user_level_name": raw.get("user_level_name") or "",
            }
    except Exception:
        pass
    return None


def main():
    try:
        token = get_access_token()
        raw = api_get(API_BASE_URL.rstrip("/") + "/usages", token)
        if not isinstance(raw, dict):
            raise RuntimeError("Неожиданный формат ответа /usages")
        usages = raw.get("usages")
        if not isinstance(usages, dict):
            usages = {}
        result = {
            "ok": True,
            "user": fetch_user_info(token),
            "five_hour": usage_entry(usages.get("limit_5h")),
            "seven_day": usage_entry(usages.get("limit_7d")),
            "month_total": usage_entry(usages.get("limit_month_total")),
            "month_code": usage_entry(usages.get("limit_month_code")),
            "booster": parse_booster(raw.get("boosterWallet")),
        }
        json.dump(result, sys.stdout, ensure_ascii=False)
        print()
        sys.exit(0)
    except (FileNotFoundError, KeyError) as e:
        eprint(str(e))
        json.dump({"ok": False, "error": str(e)}, sys.stdout, ensure_ascii=False)
        print()
        sys.exit(1)
    except RuntimeError as e:
        eprint(str(e))
        json.dump({"ok": False, "error": str(e)}, sys.stdout, ensure_ascii=False)
        print()
        sys.exit(1)
    except urllib.error.URLError as e:
        eprint(f"Network error: {e.reason}")
        json.dump({"ok": False, "error": f"Сеть: {e.reason}"}, sys.stdout, ensure_ascii=False)
        print()
        sys.exit(1)
    except Exception as e:
        eprint(f"Unexpected: {e}")
        json.dump({"ok": False, "error": str(e)}, sys.stdout, ensure_ascii=False)
        print()
        sys.exit(1)


if __name__ == "__main__":
    main()
