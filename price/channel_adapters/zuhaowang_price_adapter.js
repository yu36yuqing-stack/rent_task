'use strict';

const { resolvePackageRatios } = require('../channel_package_ratio');

const capability = Object.freeze({
    channel: 'zuhaowang',
    label: '租号王',
    enabled: true,
    package_keys: ['hour', 'p24', 'p72', 'p168'],
    package_labels: { hour: '时租', p24: '1天（24小时）', p72: '3天（72小时）', p168: '7天（168小时）' },
    default_ratios: { hour: 1, p24: 4.5, p72: 13.5, p168: 31.5 }
});

function roundMoney(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
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
        hour: roundMoney(info.hourPrice ?? info.hour_price ?? info.obtainPrice),
        p24: roundMoney(info.p24Price ?? info.p24_price),
        p72: roundMoney(info.p72Price ?? info.p72_price),
        p168: roundMoney(info.p168Price ?? info.p168_price)
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
    const hour = roundMoney(hourPrice);
    return {
        hour,
        p24: roundMoney(hour * Number(ratios.p24 || 0)),
        p72: roundMoney(hour * Number(ratios.p72 || 0)),
        p168: roundMoney(hour * Number(ratios.p168 || 0))
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
    return keys.every((key) => roundMoney(left[key]) === roundMoney(right[key]));
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
    buildPriceSet,
    buildTierPrices,
    samePriceSet,
    resolveTierPrices,
    publish,
    shouldForcePublish,
    verification_note: '发布前读取租赁模板，并按商品实际支持的租赁方式回读验证'
};
