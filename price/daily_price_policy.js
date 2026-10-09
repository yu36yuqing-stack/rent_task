'use strict';

const DEFAULT_FACTORS = Object.freeze([1, 1, 0.95, 0.9]);
const UUZUHAO_SHORT_PACKAGE_KEYS = Object.freeze(['p2', 'p3', 'p5', 'p7', 'p9', 'p10']);

function policyError(message) {
    const error = new Error(message);
    error.code = 'DAILY_PRICE_POLICY_INVALID';
    return error;
}

function normalizeDailyPolicy(value) {
    const input = value === undefined || value === null ? {} : value;
    if (typeof input !== 'object' || Array.isArray(input)) throw policyError('日租策略必须是对象');
    const mode = input.mode === undefined ? 'follow' : input.mode;
    if (!['follow', 'flat', 'decrease'].includes(mode)) throw policyError('不支持的日租模式');
    const factors = mode === 'flat' ? [1, 1, 1, 1] : (input.factors === undefined ? [...DEFAULT_FACTORS] : input.factors);
    if (!Array.isArray(factors) || factors.length !== 4) throw policyError('日租系数必须包含四档');
    const normalized = factors.map((factor) => {
        if (typeof factor !== 'number' || !Number.isFinite(factor) || factor <= 0 || factor > 1) {
            throw policyError('日租系数必须大于0且不超过100%');
        }
        return Number(factor.toFixed(4));
    });
    if (normalized.some((factor, i) => factor <= 0 || (i > 0 && factor > normalized[i - 1]))) {
        throw policyError('日租系数必须大于0且不超过100%，后续各档不得递增');
    }
    return { mode, factors: normalized };
}

function applyDailyPolicy(tiers, capability, input, normalizePrice) {
    const policy = normalizeDailyPolicy(input);
    if (policy.mode === 'follow') return tiers;
    const key = capability.channel === 'uhaozu' ? 'day' : 'p24';
    if (tiers.length !== 4 || !Number.isFinite(tiers[0].prices[key]) || tiers[0].prices[key] <= 0) {
        throw policyError('日租基准价或四档数据不完整');
    }
    const base = tiers[0].prices[key];
    const dayIndex = capability.package_keys.indexOf(key);
    return tiers.map((item, i) => {
        const daily = normalizePrice(key, base * policy.factors[i]);
        if (!Number.isFinite(daily) || daily <= 0) throw policyError('日租价按渠道精度处理后必须大于0');
        const prices = { ...item.prices, [key]: daily };
        if (capability.channel === 'uhaozu' && policy.mode === 'decrease') {
            prices.night = normalizePrice('night', tiers[0].prices.night * policy.factors[i]);
        }
        if (capability.channel === 'uuzuhao' && policy.mode === 'decrease') {
            for (const shortKey of UUZUHAO_SHORT_PACKAGE_KEYS) {
                prices[shortKey] = normalizePrice(shortKey, tiers[0].prices[shortKey] * policy.factors[i]);
            }
        }
        // Keep the existing daily-package ordering check after applying all related discounts.
        for (const [index, other] of capability.package_keys.entries()) {
            if (index === dayIndex) continue;
            const price = prices[other];
            if (!Number.isFinite(price) || price <= 0) throw policyError('套餐价格必须大于0');
            if ((index < dayIndex && price > daily) || (index > dayIndex && price < daily)) {
                throw policyError(`第${item.tier}档${capability.package_labels[key]}价格与${capability.package_labels[other]}总价冲突，请调整倍率或日租系数`);
            }
        }
        return { ...item, prices };
    });
}

module.exports = { DEFAULT_FACTORS, UUZUHAO_SHORT_PACKAGE_KEYS, normalizeDailyPolicy, applyDailyPolicy };
