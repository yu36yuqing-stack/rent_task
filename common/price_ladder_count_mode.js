'use strict';

const DAY_MS = 24 * 3600 * 1000;
const BEIJING_OFFSET_MS = 8 * 3600 * 1000;

function normalizePriceLadderCountMode(value) {
    const mode = String(value == null ? '' : value).trim() || 'rolling_24h';
    if (mode !== 'rolling_24h' && mode !== 'business_day') {
        const error = new Error('阶梯计数周期不合法');
        error.code = 'PRICE_LADDER_COUNT_MODE_INVALID';
        throw error;
    }
    return mode;
}

function resolvePriceLadderCountWindow(mode, now = new Date()) {
    const countMode = normalizePriceLadderCountMode(mode);
    const input = typeof now === 'string' && /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(now)
        ? `${now.replace(' ', 'T')}+08:00` : now;
    const timestamp = new Date(input).getTime();
    if (!Number.isFinite(timestamp)) throw new Error('now 不合法');
    // Order timestamps have second precision and are stored in Beijing local time.
    const end = Math.floor(timestamp / 1000) * 1000;
    const local = new Date(end + BEIJING_OFFSET_MS);
    let businessStart = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), 6) - BEIJING_OFFSET_MS;
    if (end < businessStart) businessStart -= DAY_MS;
    const start = countMode === 'rolling_24h' ? end - DAY_MS : businessStart;
    const text = value => new Date(value + BEIJING_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
    return {
        count_mode: countMode,
        count_window: countMode === 'rolling_24h' ? '近24小时' : '每日06:00切日',
        window_start: new Date(start).toISOString(),
        window_end: new Date(end).toISOString(),
        query_start: text(start),
        query_end: text(end),
        business_date: text(businessStart).slice(0, 10)
    };
}

module.exports = { normalizePriceLadderCountMode, resolvePriceLadderCountWindow };
