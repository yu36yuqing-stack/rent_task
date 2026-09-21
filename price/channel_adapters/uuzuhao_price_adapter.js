'use strict';

const { _internals: uuzuhaoInternal } = require('../../uuzuhao/uuzuhao_api');

const capability = Object.freeze({
    channel: 'uuzuhao',
    label: '悠悠租号',
    enabled: true,
    package_keys: ['hour', 'p2', 'p3', 'p5', 'p7', 'p9', 'p10', 'p24', 'p168'],
    package_labels: {
        hour: '时租',
        p2: '2小时',
        p3: '3小时',
        p5: '5小时',
        p7: '7小时',
        p9: '9小时',
        p10: '10小时',
        p24: '24小时',
        p168: '168小时'
    }
});

const API_TO_PRICE_KEY = Object.freeze({
    p2Price: 'p2',
    p3Price: 'p3',
    p5Price: 'p5',
    p7Price: 'p7',
    p9Price: 'p9',
    p10Price: 'p10',
    p24Price: 'p24',
    p168Price: 'p168'
});

function roundMoney(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

function channelInfo(accountRow = {}) {
    const all = accountRow.channel_prd_info && typeof accountRow.channel_prd_info === 'object'
        ? accountRow.channel_prd_info
        : {};
    return all.uuzuhao && typeof all.uuzuhao === 'object' ? all.uuzuhao : {};
}

function productId(accountRow = {}) {
    const info = channelInfo(accountRow);
    return String(info.prd_id || info.product_id || '').trim();
}

function isAvailable(accountRow = {}) {
    return Boolean(productId(accountRow));
}

function buildPriceSet(hourPrice) {
    const payload = uuzuhaoInternal.buildModifyPricePayload('price-preview', { hourPrice });
    const prices = { hour: roundMoney(payload.hourPrice) };
    for (const [field, key] of Object.entries(API_TO_PRICE_KEY)) prices[key] = roundMoney(payload[field]);
    return prices;
}

function buildTierPrices(hourPrices = []) {
    return hourPrices.slice(0, 4).map((value, index) => ({
        tier: index + 1,
        prices: buildPriceSet(value)
    }));
}

function pickCurrentPriceSet(accountRow = {}) {
    const info = channelInfo(accountRow);
    const hour = roundMoney(info.hourPrice ?? info.hour_price ?? info.rentalByHour ?? info.rental_by_hour);
    return {
        goods_id: productId(accountRow),
        prices: { hour },
        complete: hour > 0,
        comparable_keys: ['hour'],
        min_rent_hour: Number(info.minRentHour ?? info.min_rent_hour ?? 0) || 0
    };
}

function samePriceSet(left = {}, right = {}) {
    return roundMoney(left.hour) === roundMoney(right.hour);
}

async function resolveTierPrices(context = {}) {
    const tiers = buildTierPrices(context.rule && context.rule.prices || []);
    const ready = tiers.length === 4
        && tiers.every((item) => capability.package_keys.every((key) => Number(item.prices[key] || 0) > 0));
    return {
        ready,
        error: ready ? '' : '悠悠租号阶梯套餐价格计算失败',
        reason: ready ? '' : 'package_calculation_failed',
        tiers,
        baseline: null,
        baseline_status: 'formula',
        baseline_version: 0
    };
}

async function publish(userId, input = {}, options = {}) {
    const { publishUuzuhaoAccountPriceSetByUser } = require('../price_publish_service');
    return publishUuzuhaoAccountPriceSetByUser(userId, input, options);
}

function shouldForcePublish(triggerSource) {
    void triggerSource;
    // 核心状态机只在换档、校准或重试时调用；悠悠套餐不可回读，因此每次都提交完整套餐。
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
    verification_note: '时租价已回读验证，套餐价以平台成功响应为准',
    _internal: { API_TO_PRICE_KEY }
};
