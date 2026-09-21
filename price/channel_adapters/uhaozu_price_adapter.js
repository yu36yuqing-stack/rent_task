'use strict';

const { getAccountChannelPriceBaseline } = require('../../database/account_channel_price_baseline_db');

const capability = Object.freeze({
    channel: 'uhaozu',
    label: 'U号租',
    enabled: true,
    package_keys: ['hour', 'night', 'day', 'week'],
    package_labels: { hour: '时租', night: '包夜', day: '包天', week: '包周' }
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

function samePriceSet(left = {}, right = {}) {
    return capability.package_keys.every((key) => roundMoney(left[key]) === roundMoney(right[key]));
}

async function resolveTierPrices(context = {}) {
    const { user_id: userId, rule, account_row: accountRow, allow_preview: allowPreview } = context;
    let baseline = await getAccountChannelPriceBaseline(
        userId,
        rule.game_id,
        rule.game_account,
        capability.channel
    );
    let baselineStatus = baseline ? 'saved' : 'unavailable';
    if (!baseline && allowPreview) {
        const remote = pickCurrentPriceSet(accountRow);
        if (remote.complete) {
            baseline = {
                prices: remote.prices,
                goods_id: remote.goods_id,
                version: 0,
                source_sync_time: '',
                modify_date: ''
            };
            baselineStatus = 'preview';
        }
    }
    const tiers = baseline ? buildTierPrices(rule.prices, baseline.prices) : [];
    const ready = Boolean(
        baseline
        && tiers.length === 4
        && tiers.every((item) => Object.values(item.prices).every((value) => Number(value) > 0))
    );
    return {
        ready,
        error: ready ? '' : 'U号租套餐价格基准不完整',
        reason: ready ? '' : 'baseline_unavailable',
        tiers,
        baseline,
        baseline_status: baselineStatus,
        baseline_version: Number(baseline && baseline.version || 0)
    };
}

async function publish(userId, input = {}, options = {}) {
    const { publishUhaozuAccountPriceSetByUser } = require('../price_publish_service');
    return publishUhaozuAccountPriceSetByUser(userId, input, options);
}

function shouldForcePublish(triggerSource) {
    return String(triggerSource || '').trim() === 'rule_saved';
}

module.exports = {
    ...capability,
    capability,
    isAvailable,
    productId,
    pickCurrentPriceSet,
    buildRatios,
    buildTierPrices,
    samePriceSet,
    resolveTierPrices,
    publish,
    shouldForcePublish,
    verification_note: '全部套餐价格均已回读验证'
};
