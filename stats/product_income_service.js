'use strict';

const { normalizeGameProfile } = require('../common/game_profile');
const { listOwnedProductIncomeAccounts, listProductIncomeRows } = require('../database/product_income_db');
const { buildHistoricalIncomeTotals } = require('./historical_income');

async function getProductIncomeSummaries(userId, accounts, options = {}) {
    const result = {};
    const groups = new Map();
    const uid = Number(userId);
    for (const row of Array.isArray(accounts) ? accounts : []) {
        if (!row || (!row.game_id && !row.game_name)) continue;
        const account = String(row.game_account || '').trim();
        if (!account) continue;
        const game = normalizeGameProfile(row.game_id, row.game_name);
        const key = `${game.game_id}::${account}`;
        result[key] = { amount: null, status: 'unavailable' };
        const group = groups.get(game.game_id) || { ...game, accounts: new Set() };
        group.accounts.add(account);
        groups.set(game.game_id, group);
    }
    if (!Number.isSafeInteger(uid) || uid <= 0) return result;
    const now = options.now instanceof Date ? options.now : new Date();
    if (!Number.isFinite(now.getTime())) return result;
    // Same natural-date target as the statistics dashboard's currentDateText.
    const target = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    await Promise.all(Array.from(groups.values()).map(async (game) => {
        try {
            const owned = await listOwnedProductIncomeAccounts(uid, game.game_id, game.game_name, [...game.accounts]);
            const configured = new Set(owned.filter((row) => Number.isFinite(Number(row.purchase_price))
                && Number(Number(row.purchase_price).toFixed(2)) > 0
                && /^\d{4}-\d{2}-\d{2}$/.test(String(row.purchase_date || '').slice(0, 10)))
                .map((row) => String(row.game_account).trim()));
            if (!configured.size) return;
            const { snapshotRows, dailyRows } = await listProductIncomeRows(uid, game.game_name, [...configured], target);
            const totals = buildHistoricalIncomeTotals(configured, snapshotRows, dailyRows, { strict: true });
            for (const [account, amount] of totals) {
                if (amount !== null) result[`${game.game_id}::${account}`] = { amount, status: 'ready' };
            }
        } catch (_) {
            // A missing table, unavailable store or corrupt batch only affects
            // this game's optional display; never turn a failed read into zero.
        }
    }));
    return result;
}

module.exports = { getProductIncomeSummaries };
