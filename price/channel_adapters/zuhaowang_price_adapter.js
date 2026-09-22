'use strict';

const { resolvePackageRatios } = require('../channel_package_ratio');

const packagePriceRules = Object.freeze({
    hour: Object.freeze({ decimals: 2, rounding: 'round' }),
    p24: Object.freeze({ decimals: 1, rounding: 'truncate' }),
    p72: Object.freeze({ decimals: 1, rounding: 'truncate' }),
    p168: Object.freeze({ decimals: 1, rounding: 'truncate' })
});

const capability = Object.freeze({
    channel: 'zuhaowang',
    label: '租号王',
    enabled: true,
    package_keys: ['hour', 'p24', 'p72', 'p168'],
    package_labels: { hour: '时租', p24: '1天（24小时）', p72: '3天（72小时）', p168: '7天（168小时）' },
    default_ratios: { hour: 1, p24: 4.5, p72: 13.5, p168: 31.5 },
    price_rules: packagePriceRules
});

function roundMoney(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

function truncateMoney(value, decimals = 1) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    const digits = Math.max(0, Math.min(4, Number(decimals || 0)));
    const factor = 10 ** digits;
    const scaled = Number((n * factor).toFixed(8));
    return Number((Math.trunc(scaled) / factor).toFixed(digits));
}

function normalizePackagePrice(key, value) {
    const rule = packagePriceRules[String(key || '')] || packagePriceRules.hour;
    return rule.rounding === 'truncate' ? truncateMoney(value, rule.decimals) : roundMoney(value);
}

function channelInfo(accountRow = {}) {
    const all = accountRow.channel_prd_info && typeof accountRow.channel_prd_info === 'object'
        ? accountRow.channel_prd_info
        : {};
    return all.zuhaowang && typeof all.zuhaowang === 'object' ? all.zuhaowang : {};
}

function productId(accountRow = {}) {
    const info = channelInfo(accountRow);
    return String(info.prd_id || info.data_id || '').trim();
}

function isAvailable(accountRow = {}) {
    return Boolean(productId(accountRow));
}

function pickCurrentPriceSet(accountRow = {}) {
    const info = channelInfo(accountRow);
    const mode = String(info.rent_mode || '').trim();
    const prices = {
        hour: normalizePackagePrice('hour', info.hourPrice ?? info.hour_price ?? info.obtainPrice),
        p24: normalizePackagePrice('p24', info.p24Price ?? info.p24_price),
        p72: normalizePackagePrice('p72', info.p72Price ?? info.p72_price),
        p168: normalizePackagePrice('p168', info.p168Price ?? info.p168_price)
    };
    const comparableKeys = mode === 'day_only'
        ? ['p24', 'p72', 'p168']
        : (mode === 'hour_only' ? ['hour'] : capability.package_keys.slice());
    return {
        goods_id: productId(accountRow),
        prices,
        complete: comparableKeys.every((key) => prices[key] > 0),
        comparable_keys: comparableKeys,
        rent_mode: mode
    };
}

function buildPriceSet(hourPrice, ratios = capability.default_ratios) {
    const hour = normalizePackagePrice('hour', hourPrice);
    return {
        hour,
        p24: normalizePackagePrice('p24', hour * Number(ratios.p24 || 0)),
        p72: normalizePackagePrice('p72', hour * Number(ratios.p72 || 0)),
        p168: normalizePackagePrice('p168', hour * Number(ratios.p168 || 0))
    };
}

function buildTierPrices(hourPrices = [], ratios = capability.default_ratios) {
    return hourPrices.slice(0, 4).map((value, index) => ({
        tier: index + 1,
        prices: buildPriceSet(value, ratios)
    }));
}

function samePriceSet(left = {}, right = {}) {
    const rightKeys = capability.package_keys.filter((key) => Number(right[key] || 0) > 0);
    const keys = rightKeys.length ? rightKeys : capability.package_keys;
    return keys.every((key) => normalizePackagePrice(key, left[key]) === normalizePackagePrice(key, right[key]));
}

async function resolveTierPrices(context = {}) {
    const ratioConfig = await resolvePackageRatios(context.user_id, capability);
    const tiers = buildTierPrices(context.rule && context.rule.prices || [], ratioConfig.ratios);
    const ready = tiers.length === 4
        && tiers.every((item) => capability.package_keys.every((key) => Number(item.prices[key] || 0) > 0));
    return {
        ready,
        error: ready ? '' : '租号王套餐倍率配置不完整',
        reason: ready ? '' : 'ratio_unavailable',
        tiers,
        baseline: {
            ratios: ratioConfig.ratios,
            version: ratioConfig.version,
            modify_date: ratioConfig.modify_date
        },
        baseline_status: ratioConfig.source,
        baseline_version: ratioConfig.version
    };
}

async function publish(userId, input = {}, options = {}) {
    const { publishZuhaowangAccountPriceSetByUser } = require('../price_publish_service');
    return publishZuhaowangAccountPriceSetByUser(userId, input, options);
}

function shouldForcePublish() {
    return true;
}

module.exports = {
    ...capability,
    capability,
    isAvailable,
    productId,
    pickCurrentPriceSet,
    normalizePackagePrice,
    buildPriceSet,
    buildTierPrices,
    samePriceSet,
    resolveTierPrices,
    publish,
    shouldForcePublish,
    verification_note: '发布前读取租赁模板，并按商品实际支持的租赁方式回读验证'
};
