'use strict';

const { normalizePackagePrice } = require('./channel_adapters/zuhaowang_price_adapter');
const { listLatestSuccessfulPriceSnapshotsByUser } = require('../database/price_publish_log_db');

const PRICE_KEYS = { hour: 'hourPrice', p24: 'p24Price', p72: 'p72Price', p168: 'p168Price' };

function positive(value) {
    if (typeof value !== 'number' && typeof value !== 'string') return 0;
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : 0;
}

function actualHour(info) {
    return positive(info.hourPrice) || positive(info.hour_price) || positive(info.obtainPrice);
}

function getZuhaowangDisplayHourPrice(info = {}) {
    const price = info.rent_mode === 'day_only' ? positive(info.hour_basis) || actualHour(info) : actualHour(info);
    return price ? normalizePackagePrice('hour', price) : 0;
}

function buildConfirmedZuhaowangPriceSnapshot(info, goodsId, normalized, targetPrices) {
    const sameProduct = String(info.prd_id || info.data_id || '') === String(goodsId);
    const snapshot = { ...info, prd_id: String(goodsId), rent_mode: normalized.rent_mode,
        price_template_type: String(normalized.account_info.priceTemplateType),
        hour_basis: normalizePackagePrice('hour', targetPrices.hour) };
    delete snapshot.hour_price;
    delete snapshot.obtainPrice;
    for (const [key, field] of Object.entries(PRICE_KEYS)) snapshot[field] = normalizePackagePrice(key, normalized.prices[key]);
    // A disabled hourly quote is not the basis used to verify the active day packages.
    if (normalized.rent_mode === 'day_only') snapshot.hourPrice = sameProduct ? actualHour(info) : 0;
    return snapshot;
}

function recoverFromLog(account, log) {
    const info = account.channel_prd_info.zuhaowang;
    const goodsId = String(info.prd_id || info.data_id || '');
    if (!log || Number(log.user_id) !== Number(account.user_id) || log.channel !== 'zuhaowang'
        || String(log.game_account) !== String(account.game_account) || log.game_name !== account.game_name
        || String(log.goods_id) !== goodsId || Number(log.is_deleted || 0) || log.publish_status !== 'success'
        || !log.response_data || log.response_data.verification_status !== 'full') return null;
    const after = log.after_data || {};
    const target = log.request_data && log.request_data.target_prices;
    const prices = after.prices;
    const mode = after.rent_mode;
    if (!target || !prices || !['day_only', 'hour_only', 'hour_and_day'].includes(mode)
        || (info.rent_mode && info.rent_mode !== mode) || !positive(target.hour)
        || normalizePackagePrice('hour', target.hour) <= 0) return null;
    const keys = mode === 'day_only' ? ['p24', 'p72', 'p168'] : (mode === 'hour_only' ? ['hour'] : Object.keys(PRICE_KEYS));
    for (const key of keys) {
        const stored = key === 'hour' ? actualHour(info) : positive(info[PRICE_KEYS[key]]);
        const actual = normalizePackagePrice(key, prices[key]);
        const expected = normalizePackagePrice(key, target[key]);
        if (!positive(prices[key]) || !positive(target[key])
            || actual <= 0 || expected <= 0 || actual !== expected
            || (stored && normalizePackagePrice(key, stored) !== actual)) return null;
    }
    const restored = buildConfirmedZuhaowangPriceSnapshot(info, goodsId, {
        rent_mode: mode, prices, account_info: { priceTemplateType: '1' }
    }, target);
    if (actualHour(info)) restored.hourPrice = actualHour(info);
    return restored;
}

function recoveryCandidates(userId, accounts) {
    const uid = Number(userId);
    if (!Number.isInteger(uid) || uid <= 0) throw new Error('user_id invalid');
    return accounts.filter((row) => Number(row.user_id) === uid && !Number(row.is_deleted || 0)
        && row.asset_status !== 'sold' && row.channel_prd_info && row.channel_prd_info.zuhaowang)
        .filter((row) => {
            const info = row.channel_prd_info.zuhaowang;
            return Boolean(info.prd_id || info.data_id)
                && (info.rent_mode === 'day_only' ? !positive(info.hour_basis) : !actualHour(info));
        });
}

async function recoverZuhaowangPriceSnapshotsByUser(userId, accounts, options = {}) {
    const candidates = recoveryCandidates(userId, accounts);
    const uid = Number(userId);
    if (!candidates.length) return {};
    let logs;
    try {
        logs = await (options.load_logs || listLatestSuccessfulPriceSnapshotsByUser)(uid, 'zuhaowang');
    } catch (error) {
        console.warn(`[ZHWPriceSnapshot] user_id=${uid} stage=history error_code=${error.code || 'READ_FAILED'}`);
        return {};
    }
    const key = (row) => JSON.stringify([row.game_name, row.game_account, String(row.goods_id)]);
    const byProduct = new Map(logs.map((log) => [key(log), log]));
    const recovered = {};
    for (const account of candidates) {
        const info = account.channel_prd_info.zuhaowang;
        const log = byProduct.get(key({ ...account, goods_id: info.prd_id || info.data_id }));
        const snapshot = recoverFromLog(account, log);
        if (snapshot) recovered[`${account.game_id}::${account.game_account}`] = snapshot;
    }
    if (Object.keys(recovered).length) console.log(`[ZHWPriceSnapshot] user_id=${uid} stage=history recovered=${Object.keys(recovered).length}`);
    return recovered;
}

async function recoverZuhaowangPriceSnapshotsFromTemplates(userId, accounts, runtimes, options = {}) {
    const candidates = recoveryCandidates(userId, accounts);
    const uid = Number(userId);
    const confirmed = new Map();
    for (const runtime of runtimes) {
        if (Number(runtime.user_id) !== uid || runtime.channel !== 'zuhaowang' || Number(runtime.is_deleted || 0)
            || !Number.isInteger(runtime.applied_tier) || runtime.applied_tier < 1 || runtime.applied_tier > 4) continue;
        let signature;
        try { signature = JSON.parse(runtime.applied_price_signature); } catch (_) { continue; }
        if (!signature || signature.tier !== runtime.applied_tier || !signature.prices
            || Object.keys(PRICE_KEYS).some((key) => !positive(signature.prices[key])
                || normalizePackagePrice(key, signature.prices[key]) <= 0)) continue;
        confirmed.set(`${runtime.game_id}::${runtime.game_account}`, signature.prices);
    }
    const pending = candidates.filter((row) => confirmed.has(`${row.game_id}::${row.game_account}`));
    if (!pending.length) return {};
    const { _internals: internal } = require('./price_publish_service');
    let auth;
    try {
        auth = await (options.get_auth || internal.getZuhaowangAuthPayloadByUser)(uid);
    } catch (error) {
        console.warn(`[ZHWPriceSnapshot] user_id=${uid} stage=query_auth error_code=${error.code || 'READ_FAILED'}`);
        return {};
    }
    const query = options.get_template || require('../zuhaowang/zuhaowang_price_api').getPriceTemplate;
    const recovered = {};
    for (const row of pending) {
        const key = `${row.game_id}::${row.game_account}`;
        const info = row.channel_prd_info.zuhaowang;
        const goodsId = String(info.prd_id || info.data_id);
        try {
            const normalized = internal.normalizeZuhaowangTemplate(await query(goodsId, auth, { user_id: uid }));
            const target = confirmed.get(key);
            if (!internal.sameZuhaowangActivePriceSet(target, normalized.prices, normalized.rent_mode)) continue;
            recovered[key] = buildConfirmedZuhaowangPriceSnapshot(info, goodsId, normalized, target);
        } catch (error) {
            console.warn(`[ZHWPriceSnapshot] user_id=${uid} stage=query account=${row.game_account} error_code=${error.code || 'READ_FAILED'}`);
        }
    }
    return recovered;
}

module.exports = { getZuhaowangDisplayHourPrice, buildConfirmedZuhaowangPriceSnapshot,
    recoverZuhaowangPriceSnapshotsByUser, recoverZuhaowangPriceSnapshotsFromTemplates, _internals: { recoverFromLog } };
