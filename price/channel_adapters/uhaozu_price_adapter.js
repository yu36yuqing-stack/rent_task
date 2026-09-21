'use strict';

const { resolvePackageRatios } = require('../channel_package_ratio');

const capability = Object.freeze({
    channel: 'uhaozu',
    label: 'U号租',
    enabled: true,
    package_keys: ['hour', 'night', 'day', 'week'],
    package_labels: { hour: '时租', night: '包夜', day: '包天', week: '包周' },
    default_ratios: { hour: 1, night: 4, day: 6, week: 35 }
});

function roundMoney(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

function channelInfo(accountRow = {}) {
    const all = accountRow.channel_prd_info && typeof accountRow.channel_prd_info === 'object'
        ? accountRow.channel_prd_info
        : {};
    return all.uhaozu && typeof all.uhaozu === 'object' ? all.uhaozu : {};
}

function productId(accountRow = {}) {
    const info = channelInfo(accountRow);
    return String(info.prd_id || info.goods_id || '').trim();
}

function isAvailable(accountRow = {}) {
    return Boolean(productId(accountRow));
}

function pickCurrentPriceSet(accountRow = {}) {
    const info = channelInfo(accountRow);
    const prices = {
        hour: roundMoney(info.rentalByHour ?? info.rental_by_hour),
        night: roundMoney(info.rentalByNight ?? info.rental_by_night),
        day: roundMoney(info.rentalByDay ?? info.rental_by_day),
        week: roundMoney(info.rentalByWeek ?? info.rental_by_week)
    };
    return {
        goods_id: productId(accountRow),
        prices,
        complete: Object.values(prices).every((value) => value > 0),
        comparable_keys: capability.package_keys.slice()
    };
}

function buildRatios(prices = {}) {
    const hour = Number(prices.hour || 0);
    const ratio = (value) => hour > 0 && Number(value) > 0 ? Number((Number(value) / hour).toFixed(4)) : 0;
    return {
        hour: hour > 0 ? 1 : 0,
        night: ratio(prices.night),
        day: ratio(prices.day),
        week: ratio(prices.week)
    };
}

function buildTierPrices(hourPrices = [], baselinePrices = {}) {
    const ratios = buildRatios(baselinePrices);
    return hourPrices.slice(0, 4).map((value, index) => {
        const hour = roundMoney(value);
        const derive = (key) => ratios[key] > 0 ? roundMoney(hour * ratios[key]) : 0;
        return {
            tier: index + 1,
            prices: {
                hour,
                night: derive('night'),
                day: derive('day'),
                week: derive('week')
            }
        };
    });
}

function buildTierPricesByRatios(hourPrices = [], ratios = {}) {
    return hourPrices.slice(0, 4).map((value, index) => {
        const hour = roundMoney(value);
        const derive = (key) => Number(ratios[key] || 0) > 0 ? roundMoney(hour * Number(ratios[key])) : 0;
        return {
            tier: index + 1,
            prices: {
                hour,
                night: derive('night'),
                day: derive('day'),
                week: derive('week')
            }
        };
    });
}

function samePriceSet(left = {}, right = {}) {
    return capability.package_keys.every((key) => roundMoney(left[key]) === roundMoney(right[key]));
}

async function resolveTierPrices(context = {}) {
    const { user_id: userId, rule } = context;
    const ratioConfig = await resolvePackageRatios(userId, capability);
    const tiers = buildTierPricesByRatios(rule.prices, ratioConfig.ratios);
    const ready = Boolean(
        tiers.length === 4
        && tiers.every((item) => Object.values(item.prices).every((value) => Number(value) > 0))
    );
    return {
        ready,
        error: ready ? '' : 'U号租套餐倍率配置不完整',
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
    const { publishUhaozuAccountPriceSetByUser } = require('../price_publish_service');
    return publishUhaozuAccountPriceSetByUser(userId, input, options);
}

function shouldForcePublish(triggerSource) {
    return ['rule_saved', 'package_ratio_saved'].includes(String(triggerSource || '').trim());
}

module.exports = {
    ...capability,
    capability,
    isAvailable,
    productId,
    pickCurrentPriceSet,
    buildRatios,
    buildTierPrices,
    buildTierPricesByRatios,
    samePriceSet,
    resolveTierPrices,
    publish,
    shouldForcePublish,
    verification_note: '全部套餐价格均已回读验证'
};
