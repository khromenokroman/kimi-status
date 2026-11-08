// Kimi Code Limits Indicator для GNOME Shell 48+
// Показывает процент использования лимитов Kimi Code в панели,
// при клике раскрывается меню с деталями.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const SCRIPT_PATH = GLib.build_filenamev([
    GLib.get_user_config_dir(),
    'kimi-status',
    'kimi_usage.py'
]);
const PYTHON_BIN = '/usr/bin/python3';
const REFRESH_INTERVAL_SECONDS = 300;
const TMP_FILE = '/tmp/kimi-status-usage.json';

function parseIsoUtc(ts) {
    if (!ts)
        return null;
    try {
        const dt = new Date(ts);
        if (isNaN(dt.getTime()))
            return null;
        return dt.getTime() / 1000.0;
    } catch {
        return null;
    }
}

function formatCountdown(resetsAt) {
    const epoch = parseIsoUtc(resetsAt);
    if (epoch === null)
        return '';
    const remaining = Math.max(0, Math.floor(epoch - Date.now() / 1000.0));
    if (remaining <= 0)
        return 'сейчас';
    const d = Math.floor(remaining / 86400);
    const h = Math.floor((remaining % 86400) / 3600);
    const m = Math.floor((remaining % 3600) / 60);
    const s = remaining % 60;
    if (d > 0)
        return `${d}д ${h}ч`;
    if (h > 0)
        return `${h}ч ${m}м`;
    if (m > 0)
        return `${m}м ${s}с`;
    return `${s}с`;
}

function formatLimitLine(label, entry) {
    if (!entry || entry.utilization === null || entry.utilization === undefined)
        return '';
    const pct = Math.round(entry.utilization);
    const countdown = formatCountdown(entry.resets_at);
    const cd = countdown ? `, сброс через ${countdown}` : '';
    return `${label}: ${pct}%${cd}`;
}

function formatPanelLabel(data) {
    // Основной лимит: 5ч окно, если нет то месячное
    const parts = [];
    if (data.five_hour && data.five_hour.utilization !== null)
        parts.push(`5ч: ${Math.round(data.five_hour.utilization)}%`);
    if (data.seven_day && data.seven_day.utilization !== null)
        parts.push(`7д: ${Math.round(data.seven_day.utilization)}%`);
    if (parts.length === 0 && data.month_total && data.month_total.utilization !== null)
        parts.push(`мес: ${Math.round(data.month_total.utilization)}%`);
    return parts.join(' | ') || 'Kimi';
}

function readResultFile() {
    try {
        const f = Gio.File.new_for_path(TMP_FILE);
        const [ok, content] = f.load_contents(null);
        if (!ok)
            return null;
        return new TextDecoder().decode(content);
    } catch {
        return null;
    }
}

class KimiStatusIndicator {
    constructor() {
        this._button = new PanelMenu.Button(0.5, 'Kimi Code Limits');

        // Создаём box с иконкой и лейблом
        this._box = new St.BoxLayout({
            x_expand: true,
            y_expand: true,
            vertical: false,
        });

        // Иконка (таймер) - как у батареи
        this._icon = new St.Icon({
            icon_name: 'alarm',
            icon_size: 16,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._box.add_child(this._icon);

        this._label = new St.Label({
            text: 'Kimi',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._box.add_child(this._label);

        this._button.add_child(this._box);

        this._menu = this._button.menu;
        this._buildMenu();

        this._addToPanel();

        this._refreshing = false;
        this._lastData = null;
        this._lastUpdate = null;
        this._timer = null;
        this._start();
    }

    _addToPanel() {
        let box = 'right';

        // Пытаемся вставить слева от индикатора клавиатуры (языка)
        try {
            const keyboard = Main.panel.statusArea['keyboard'];
            if (keyboard) {
                const container = keyboard.container;
                const parent = container.get_parent();
                if (parent) {
                    const siblings = [];
                    for (let c = parent.get_first_child(); c; c = c.get_next_sibling())
                        siblings.push(c);
                    const idx = siblings.indexOf(container);
                    if (idx >= 0) {
                        parent.insert_child_at_index(this._button.container, idx);
                        box = null; // уже добавили вручную
                    }
                }
            }
        } catch {
            // fallback: стандартное добавление
        }

        if (box !== null) {
            Main.panel.addToStatusArea('kimiStatus', this._button);
        } else {
            // Ручное добавление: регистрируем в statusArea
            Main.panel.statusArea['kimiStatus'] = this._button;
            const destroyId = this._button.connect('destroy', emitter => {
                delete Main.panel.statusArea['kimiStatus'];
                emitter.disconnect(destroyId);
            });
            this._button.connect('menu-set', Main.panel._onMenuSet.bind(Main.panel));
            Main.panel._onMenuSet(this._button);
        }
    }

    _buildMenu() {
        this._menu.removeAll();

        const headerItem = new PopupMenu.PopupMenuItem('Kimi Code');
        this._menu.addMenuItem(headerItem);

        const line1Item = new PopupMenu.PopupMenuItem('загрузка…');
        this._line1 = line1Item.label;
        this._menu.addMenuItem(line1Item);

        const line2Item = new PopupMenu.PopupMenuItem('');
        this._line2 = line2Item.label;
        this._menu.addMenuItem(line2Item);

        const line3Item = new PopupMenu.PopupMenuItem('');
        this._line3 = line3Item.label;
        this._menu.addMenuItem(line3Item);

        const boosterItem = new PopupMenu.PopupMenuItem('');
        this._boosterLine = boosterItem.label;
        this._menu.addMenuItem(boosterItem);

        const timeItem = new PopupMenu.PopupMenuItem('');
        this._timeLine = timeItem.label;
        this._menu.addMenuItem(timeItem);

        const planItem = new PopupMenu.PopupMenuItem('');
        this._planLine = planItem.label;
        this._menu.addMenuItem(planItem);

        const intervalItem = new PopupMenu.PopupMenuItem(
            `Автообновление: каждые ${REFRESH_INTERVAL_SECONDS / 60} мин`
        );
        this._menu.addMenuItem(intervalItem);

        const sep = new PopupMenu.PopupSeparatorMenuItem();
        this._menu.addMenuItem(sep);

        const linkItem = new PopupMenu.PopupMenuItem('Открыть страницу лимитов');
        linkItem.connect('activate', () => {
            const url = 'https://www.kimi.com/code';
            const ctx = global.create_app_launch_context(0, -1);
            Gio.AppInfo.launch_default_for_uri(url, ctx);
        });
        this._menu.addMenuItem(linkItem);
    }

    _start() {
        this._refresh();
        this._timer = GLib.timeout_add_seconds(
            GLib.PRIORITY_DEFAULT,
            REFRESH_INTERVAL_SECONDS,
            () => {
                this._refresh();
                return GLib.SOURCE_CONTINUE;
            }
        );
    }

    _refresh() {
        if (this._refreshing)
            return;
        this._refreshing = true;

        this._line1.set_text('загрузка…');
        this._line2.set_text('');
        this._line3.set_text('');

        const cmd = `${PYTHON_BIN} ${SCRIPT_PATH} > ${TMP_FILE} 2>&1`;
        const argv = ['/bin/sh', '-c', cmd];

        try {
            const [success, pid] = GLib.spawn_async(
                null, argv, null,
                GLib.SpawnFlags.SEARCH_PATH |
                GLib.SpawnFlags.STDOUT_TO_DEV_NULL |
                GLib.SpawnFlags.STDERR_TO_DEV_NULL,
                null
            );

            if (success) {
                GLib.child_watch_add(
                    GLib.PRIORITY_DEFAULT,
                    pid,
                    (child, status) => {
                        this._refreshing = false;
                        const raw = readResultFile();
                        if (raw === null) {
                            this._applyError('Не удалось прочитать результат');
                            return;
                        }
                        let data;
                        try {
                            data = JSON.parse(raw);
                        } catch (e) {
                            this._applyError(raw.slice(0, 200));
                            return;
                        }
                        this._applyData(data);
                    }
                );
            } else {
                this._refreshing = false;
                this._applyError('spawn_async: не удалось запустить python3');
            }
        } catch (e) {
            this._refreshing = false;
            this._applyError(String(e));
        }
    }

    _applyError(error) {
        // При ошибке показываем последние успешные данные, если они есть
        if (this._lastData) {
            this._applyData(this._lastData);
        } else {
            this._label.set_text('Kimi');
            this._line1.set_text('Ошибка');
            this._line2.set_text(error.slice(0, 200));
            this._line3.set_text('');
            this._timeLine.set_text('Время обновления: нет данных');
            this._planLine.set_text('Тариф: неизвестен');
        }
    }

    _applyData(data) {
        if (!data || !data.ok) {
            this._applyError((data && data.error) || 'неизвестная ошибка');
            return;
        }

        // Сохраняем успешные данные
        this._lastData = data;
        this._lastUpdate = new Date();

        // Текст на панели: "5ч: 2% | мес: 23%"
        this._label.set_text(formatPanelLabel(data));

        // Меню: детали
        const line1 = formatLimitLine('5ч окно', data.five_hour);
        const line2 = formatLimitLine('7д окно', data.seven_day);
        const line3 = formatLimitLine('Месяц (code)', data.month_code);

        // Собираем непустые строки
        const lines = [line1, line2, line3].filter(l => l !== '');
        this._line1.set_text(lines[0] || 'Нет активных лимитов');
        this._line2.set_text(lines[1] || '');
        this._line3.set_text(lines[2] || '');

        // Бустеры (опционально)
        if (data.booster && data.booster.balance > 0) {
            let b = `Бустеры: ${data.booster.balance} / ${data.booster.total} ${data.booster.currency}`;
            if (data.booster.monthly_limit_enabled)
                b += ` (лимит ${data.booster.monthly_used}/${data.booster.monthly_limit})`;
            this._boosterLine.set_text(b);
        } else {
            this._boosterLine.set_text('');
        }

        // Время последнего обновления
        if (this._lastUpdate) {
            this._timeLine.set_text(
                `Обновлено: ${this._lastUpdate.toLocaleTimeString('ru-RU', {hour: '2-digit', minute: '2-digit', second: '2-digit'})}`
            );
        } else {
            this._timeLine.set_text('Время обновления: нет данных');
        }

        // Тариф
        const user = data.user;
        if (user && user.user_level_name) {
            let plan = `Тариф: ${user.user_level_name}`;
            if (user.nickname)
                plan += ` (${user.nickname})`;
            this._planLine.set_text(plan);
        } else {
            this._planLine.set_text('Тариф: неизвестен');
        }
    }

    destroy() {
        if (this._timer)
            GLib.source_remove(this._timer);
        this._timer = null;
        this._refreshing = false;

        this._menu.removeAll();
        this._menu.destroy();
        this._button.destroy();
        this._box.destroy();
        this._icon.destroy();
        this._label.destroy();
    }
}

export default class KimiStatusExtension extends Extension {
    constructor(...args) {
        super(...args);
        this._indicator = null;
    }

    enable() {
        this._indicator = new KimiStatusIndicator();
    }

    disable() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
    }
}
