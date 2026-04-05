'use strict';

const { normalizeGameProfile } = require('../common/game_profile');
const { DEFAULT_UHAOZU_PRICING_CONFIG } = require('./price_uhaozu');
const { getUserPriceRule, upsertUserPriceRule } = require('../database/user_price_rule_db');

const PRICE_MODE_PAYBACK_PERIOD = 'payback_period';
const PRICE_CHANNEL_UHAOZU = 'uhaozu';

function roundTo(value, digits = 2) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Number(n.toFixed(digits));
}

function toPositiveOrFallback(value, fallback) {
    if (value === undefined || value === null || String(value).trim() === '') return fallback;
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return fallback;
    return n;
}

function toNonNegativeOrFallback(value, fallback) {
    if (value === undefined || value === null || String(value).trim() === '') return fallback;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return fallback;
    return n;
}

function normalizePricingAccountCosts(input, fallback = {}) {
    const hasInputObject = Boolean(input) && typeof input === 'object' && !Array.isArray(input);
    const hasFallbackObject = Boolean(fallback) && typeof fallback === 'object' && !Array.isArray(fallback);
    const candidate = hasInputObject ? input : (hasFallbackObject ? fallback : {});
    const out = {};
    for (const [rawKey, rawValue] of Object.entries(candidate)) {
        const key = String(rawKey || '').trim();
        if (!key) continue;
        const amount = Number(rawValue);
        if (!Number.isFinite(amount) || amount < 0) continue;
        out[key] = roundTo(amount, 2);
    }
    return out;
}

function normalizeUhaozuPricingConfig(input = {}, fallback = {}) {
    const defaults = {
        ...DEFAULT_UHAOZU_PRICING_CONFIG,
        ...(fallback && typeof fallback === 'object' ? fallback : {})
    };
    return {
        payback_days: toPositiveOrFallback(input.payback_days, defaults.payback_days),
        avg_daily_rent_hours: toPositiveOrFallback(input.avg_daily_rent_hours, defaults.avg_daily_rent_hours),
        platform_fee_rate: toNonNegativeOrFallback(input.platform_fee_rate, defaults.platform_fee_rate),
        withdrawal_fee_rate: toNonNegativeOrFallback(input.withdrawal_fee_rate, defaults.withdrawal_fee_rate),
        price_step: toPositiveOrFallback(input.price_step, defaults.price_step),
        deposit: toNonNegativeOrFallback(input.deposit, defaults.deposit),
        pricing_account_costs: normalizePricingAccountCosts(input.pricing_account_costs, defaults.pricing_account_costs)
    };
}

async function getUhaozuPricingConfigByUser(userId, options = {}) {
    const game = normalizeGameProfile('', options.game_name || 'WZRY');
    const saved = await getUserPriceRule(userId, {
        channel: PRICE_CHANNEL_UHAOZU,
        game_id: game.game_id,
        mode: PRICE_MODE_PAYBACK_PERIOD
    });
    const savedDetail = saved && saved.rule_detail && typeof saved.rule_detail === 'object'
        ? saved.rule_detail
        : {};
    return {
        game_id: game.game_id,
        game_name: game.game_name,
        channel: PRICE_CHANNEL_UHAOZU,
        mode: PRICE_MODE_PAYBACK_PERIOD,
        config: normalizeUhaozuPricingConfig(options, savedDetail),
        saved_rule: saved
    };
}

async function saveUhaozuPricingConfigByUser(userId, input = {}, opts = {}) {
    const game = normalizeGameProfile('', input.game_name || 'WZRY');
    const merged = await getUhaozuPricingConfigByUser(userId, { game_name: game.game_name });
    const config = normalizeUhaozuPricingConfig(input, merged.config);
    const saved = await upsertUserPriceRule(userId, {
        channel: PRICE_CHANNEL_UHAOZU,
        game_id: game.game_id,
        game_name: game.game_name,
        mode: PRICE_MODE_PAYBACK_PERIOD,
        rule_detail: config
    }, {
        desc: String(opts.desc || 'set by price h5').trim()
    });
    return {
        channel: PRICE_CHANNEL_UHAOZU,
        mode: PRICE_MODE_PAYBACK_PERIOD,
        game_id: game.game_id,
        game_name: game.game_name,
        config,
        saved_rule: saved
    };
}

async function saveUhaozuPricingAccountCostByUser(userId, input = {}, opts = {}) {
    const uid = Number(userId || 0);
    const game = normalizeGameProfile('', input.game_name || 'WZRY');
    const gameAccount = String(input.game_account || '').trim();
    const totalCostAmount = Number(input.total_cost_amount);
    if (!uid) throw new Error('user_id 不合法');
    if (!gameAccount) throw new Error('game_account 不能为空');
    if (!Number.isFinite(totalCostAmount) || totalCostAmount < 0) throw new Error('total_cost_amount 不合法');

    const merged = await getUhaozuPricingConfigByUser(uid, { game_name: game.game_name });
    const nextPricingAccountCosts = normalizePricingAccountCosts({
        ...(merged.config && merged.config.pricing_account_costs ? merged.config.pricing_account_costs : {}),
        [gameAccount]: totalCostAmount
    }, merged.config && merged.config.pricing_account_costs);
    const config = normalizeUhaozuPricingConfig({
        ...merged.config,
        pricing_account_costs: nextPricingAccountCosts
    }, merged.config);
    const saved = await upsertUserPriceRule(uid, {
        channel: PRICE_CHANNEL_UHAOZU,
        game_id: game.game_id,
        game_name: game.game_name,
        mode: PRICE_MODE_PAYBACK_PERIOD,
        rule_detail: config
    }, {
        desc: String(opts.desc || `set pricing account cost ${gameAccount}`).trim()
    });
    return {
        channel: PRICE_CHANNEL_UHAOZU,
        mode: PRICE_MODE_PAYBACK_PERIOD,
        game_id: game.game_id,
        game_name: game.game_name,
        game_account: gameAccount,
        total_cost_amount: roundTo(totalCostAmount, 2),
        config,
        saved_rule: saved
    };
}

module.exports = {
    PRICE_MODE_PAYBACK_PERIOD,
    PRICE_CHANNEL_UHAOZU,
    normalizeUhaozuPricingConfig,
    normalizePricingAccountCosts,
    getUhaozuPricingConfigByUser,
    saveUhaozuPricingConfigByUser,
    saveUhaozuPricingAccountCostByUser
};
