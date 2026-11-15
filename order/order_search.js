'use strict';

const { listOrderSearchAccountNames } = require('../database/order_search_account_db');
const { resolveDisplayNameByRow } = require('../product/display_name');

const MAX_ORDER_SEARCH_LENGTH = 64;
const QUICK_FILTERS = new Set(['today', 'last24h', 'last7', 'last30']);

function normalizeOrderSearchKeyword(value) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string' || Array.from(value.trim()).length > MAX_ORDER_SEARCH_LENGTH
        || /[\u0000-\u001f\u007f]/.test(value.trim())) {
        throw Object.assign(new Error(`搜索关键词最多${MAX_ORDER_SEARCH_LENGTH}个字符，且不能包含控制字符`), {
            code: 'ORDER_SEARCH_INVALID', statusCode: 400
        });
    }
    return value.trim();
}

function normalizeOrderListQuickFilter(value) {
    const filter = String(value || 'today').trim().toLowerCase();
    return QUICK_FILTERS.has(filter) ? filter : 'today';
}

async function buildOrderSearchPredicate(userId, value, options = {}) {
    const keyword = normalizeOrderSearchKeyword(value);
    if (!keyword) return { keyword, sql: '', params: [] };
    const names = await (options.listAccountNames || listOrderSearchAccountNames)(userId);
    const folded = keyword.toLowerCase();
    const tuples = new Map();
    for (const row of names) {
        const account = String(row.game_account || '').trim();
        const gameId = String(row.game_id || '').trim();
        if (!account || !gameId) continue;
        const display = resolveDisplayNameByRow({
            account_remark: row.account_remark,
            channel_prd_info: { uuzuhao: { remark: row.uuzuhao_remark } }
        }, account);
        // The card helper falls back to the account identifier when no name exists.
        // That fallback is not an alias: partial QQ numbers must not become names.
        const aliases = [display, String(row.account_remark || '')].filter(name => name.trim() !== account);
        if (aliases.some(name => name.toLowerCase().includes(folded))) {
            tuples.set(JSON.stringify([gameId, account]), [gameId, account]);
        }
    }
    // One JSON parameter keeps the complete candidate set without hitting SQLite's
    // bound-variable limit. Order names stay searchable after an account is deleted.
    const pattern = `%${keyword.replace(/[\\%_]/g, '\\$&')}%`;
    return {
        keyword,
        sql: `(game_account = ? OR (TRIM(COALESCE(role_name,''))<>TRIM(COALESCE(game_account,''))
            AND COALESCE(role_name,'') LIKE ? ESCAPE '\\')
            OR (game_id,game_account) IN (
                SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?)
            ))`,
        params: [keyword, pattern, JSON.stringify([...tuples.values()])]
    };
}

module.exports = {
    MAX_ORDER_SEARCH_LENGTH, normalizeOrderSearchKeyword, normalizeOrderListQuickFilter,
    buildOrderSearchPredicate
};
