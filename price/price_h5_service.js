'use strict';

const { listUserGameAccounts } = require('../database/user_game_account_db');
const { normalizeGameProfile } = require('../common/game_profile');
const { resolveDisplayNameByRow } = require('../product/display_name');
const {
    calculateBatchUhaozuPaybackPeriodPrice
} = require('./price_uhaozu');
const {
    normalizeUhaozuPricingConfig,
    getUhaozuPricingConfigByUser,
    saveUhaozuPricingConfigByUser
} = require('./price_rule_service');

function roundTo(value, digits = 2) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Number(n.toFixed(digits));
}

async function listAllAccountsByUser(userId) {
    const out = [];
    let page = 1;
    const pageSize = 200;
    for (;;) {
        const one = await listUserGameAccounts(userId, page, pageSize);
        const list = Array.isArray(one && one.list) ? one.list : [];
        out.push(...list);
        if (list.length < pageSize || out.length >= Number(one && one.total || 0)) break;
        page += 1;
    }
    return out;
}

function normalizeUhaozuPricingOptions(options = {}, fallback = {}) {
    const game = normalizeGameProfile('', options.game_name || fallback.game_name || 'WZRY');
    return {
        game_name: game.game_name,
        ...normalizeUhaozuPricingConfig(options, fallback)
    };
}

function pickCurrentUhaozuPrice(row = {}) {
    const info = row && row.channel_prd_info && row.channel_prd_info.uhaozu && typeof row.channel_prd_info.uhaozu === 'object'
        ? row.channel_prd_info.uhaozu
        : {};
    const val = Number(info.rentalByHour ?? info.rental_by_hour ?? 0);
    return Number.isFinite(val) && val > 0 ? roundTo(val, 2) : 0;
}

async function getUhaozuPricingDashboardByUser(userId, options = {}) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    const saved = await getUhaozuPricingConfigByUser(uid, {
        game_name: options.game_name || 'WZRY'
    });
    const normalized = normalizeUhaozuPricingOptions({
        ...saved.config,
        ...(options && typeof options === 'object' ? options : {}),
        game_name: saved.game_name
    }, saved.config);
    const pricingAccountCosts = normalized && normalized.pricing_account_costs && typeof normalized.pricing_account_costs === 'object'
        ? normalized.pricing_account_costs
        : {};
    const allRows = await listAllAccountsByUser(uid);
    const scopedRows = allRows.filter((row) => {
        return String((row && row.game_name) || '').trim() === normalized.game_name;
    });

    const pricingRows = scopedRows.map((row) => ({
        game_account: String(row.game_account || '').trim(),
        account_remark: String(row.account_remark || '').trim(),
        total_cost_amount: Object.prototype.hasOwnProperty.call(pricingAccountCosts, String(row.game_account || '').trim())
            ? Number(pricingAccountCosts[String(row.game_account || '').trim()] || 0)
            : Number(row.total_cost_amount || 0)
    }));

    const batch = calculateBatchUhaozuPaybackPeriodPrice(pricingRows, normalized)
        .map((result) => {
            const matched = scopedRows.find((row) => String(row.game_account || '').trim() === String(result.game_account || '').trim()) || {};
            const matchedGameAccount = String(result.game_account || '').trim();
            const hasPricingCostOverride = Object.prototype.hasOwnProperty.call(pricingAccountCosts, matchedGameAccount);
            const baseTotalCostAmount = roundTo(Number(matched.total_cost_amount || 0), 2);
            const pricingTotalCostAmount = hasPricingCostOverride
                ? roundTo(Number(pricingAccountCosts[matchedGameAccount] || 0), 2)
                : roundTo(Number(matched.total_cost_amount || result.input.total_cost_amount || 0), 2);
            return {
                ...result,
                game_name: normalized.game_name,
                display_name: resolveDisplayNameByRow(matched, result.game_account),
                role_name: String(matched.account_remark || '').trim() || String(result.account_remark || '').trim() || String(result.game_account || '').trim(),
                current_listing_hourly_price: pickCurrentUhaozuPrice(matched),
                total_cost_amount: pricingTotalCostAmount,
                base_total_cost_amount: baseTotalCostAmount,
                pricing_cost_overridden: hasPricingCostOverride
            };
        })
        .sort((a, b) => {
            const bySuggested = Number(b.suggested_listing_hourly_price || 0) - Number(a.suggested_listing_hourly_price || 0);
            if (bySuggested !== 0) return bySuggested;
            return Number(b.total_cost_amount || 0) - Number(a.total_cost_amount || 0);
        });

    const summary = batch.reduce((acc, row) => {
        acc.account_count += 1;
        if (Number(row.total_cost_amount || 0) <= 0) acc.zero_cost_count += 1;
        acc.total_cost_amount += Number(row.total_cost_amount || 0);
        acc.avg_suggested_listing_hourly_price += Number(row.suggested_listing_hourly_price || 0);
        return acc;
    }, {
        account_count: 0,
        zero_cost_count: 0,
        total_cost_amount: 0,
        avg_suggested_listing_hourly_price: 0
    });

    if (summary.account_count > 0) {
        summary.avg_suggested_listing_hourly_price = roundTo(summary.avg_suggested_listing_hourly_price / summary.account_count, 2);
    }
    summary.total_cost_amount = roundTo(summary.total_cost_amount, 2);

    return {
        channel: 'uhaozu',
        mode: 'payback_period',
        game_name: normalized.game_name,
        config: normalized,
        summary,
        list: batch
    };
}

async function saveUhaozuPricingDashboardConfigByUser(userId, options = {}) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    return saveUhaozuPricingConfigByUser(uid, options, {
        desc: 'set by h5 pricing'
    });
}

module.exports = {
    normalizeUhaozuPricingOptions,
    getUhaozuPricingDashboardByUser,
    saveUhaozuPricingDashboardConfigByUser
};
