'use strict';

const { listUserGameAccounts } = require('../database/user_game_account_db');
const { listBusinessDayFinishedOrderCountByAccounts } = require('../database/order_db');
const {
    listAccountPriceLadderRules,
    getAccountPriceLadderRule,
    upsertAccountPriceLadderRule,
    clearAccountPriceLadderConfiguration
} = require('../database/account_price_ladder_rule_db');
const {
    getAccountChannelPriceBaseline,
    saveAccountChannelPriceBaseline
} = require('../database/account_channel_price_baseline_db');
const { listPricePublishItemLogsByAccount } = require('../database/price_publish_log_db');
const {
    getAccountPriceLadderRuntime,
    listAccountPriceLadderRuntimesByUser
} = require('../database/account_price_ladder_runtime_db');
const {
    getPriceLadderFeatureConfig,
    setPriceLadderFeatureEnabled
} = require('../database/price_ladder_feature_config_db');
const { normalizeGameProfile } = require('../common/game_profile');
const { resolveDisplayNameByRow } = require('../product/display_name');

const CHANNEL_CAPABILITIES = [
    {
        channel: 'uhaozu',
        label: 'U号租',
        enabled: true,
        package_keys: ['hour', 'night', 'day', 'week'],
        package_labels: { hour: '时租', night: '包夜', day: '包天', week: '包周' }
    },
    {
        channel: 'zuhaowang',
        label: '租号玩',
        enabled: false,
        package_keys: ['hour', 'day'],
        package_labels: { hour: '时租', day: '日租' }
    },
    {
        channel: 'uuzuhao',
        label: '悠悠租号',
        enabled: false,
        package_keys: [],
        package_labels: {}
    }
];

function roundMoney(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

function pickCurrentUhaozuPrice(row = {}) {
    return pickUhaozuPriceSet(row).prices.hour;
}

function pickUhaozuPriceSet(row = {}) {
    const channelInfo = row && row.channel_prd_info && typeof row.channel_prd_info === 'object'
        ? row.channel_prd_info.uhaozu
        : null;
    const info = channelInfo && typeof channelInfo === 'object' ? channelInfo : {};
    const prices = {
        hour: roundMoney(info.rentalByHour ?? info.rental_by_hour),
        night: roundMoney(info.rentalByNight ?? info.rental_by_night),
        day: roundMoney(info.rentalByDay ?? info.rental_by_day),
        week: roundMoney(info.rentalByWeek ?? info.rental_by_week)
    };
    return {
        goods_id: String(info.prd_id || info.goods_id || '').trim(),
        prices,
        complete: Object.values(prices).every((value) => value > 0)
    };
}

function buildUhaozuRatios(prices = {}) {
    const hour = Number(prices.hour || 0);
    const ratio = (value) => hour > 0 && Number(value) > 0 ? Number((Number(value) / hour).toFixed(4)) : 0;
    return {
        hour: hour > 0 ? 1 : 0,
        night: ratio(prices.night),
        day: ratio(prices.day),
        week: ratio(prices.week)
    };
}

function buildUhaozuTierPrices(hourPrices = [], baselinePrices = {}) {
    const ratios = buildUhaozuRatios(baselinePrices);
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
    return ['hour', 'night', 'day', 'week'].every((key) => roundMoney(left[key]) === roundMoney(right[key]));
}

function sanitizePublishLog(row = {}) {
    return {
        id: Number(row.id || 0),
        batch_id: String(row.batch_id || '').trim(),
        publish_status: String(row.publish_status || '').trim(),
        fail_message: String(row.fail_message || '').trim().slice(0, 500),
        target_prices: {
            hour: roundMoney(row.price_target_hour),
            night: roundMoney(row.price_target_night),
            day: roundMoney(row.price_target_day),
            week: roundMoney(row.price_target_week)
        },
        remote_prices: {
            hour: roundMoney(row.price_after_hour),
            night: roundMoney(row.price_after_night),
            day: roundMoney(row.price_after_day),
            week: roundMoney(row.price_after_week)
        },
        create_date: String(row.create_date || '').trim()
    };
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

function isAvailableAccount(row = {}) {
    return Number(row.is_deleted || 0) === 0
        && String(row.asset_status || 'active').trim().toLowerCase() !== 'sold';
}

function normalizePrices(prices) {
    if (!Array.isArray(prices) || prices.length !== 4) {
        throw new Error('请填写第 1 至第 4 单的价格');
    }
    const normalized = prices.map(roundMoney);
    if (normalized.some((value) => !Number.isFinite(value) || value <= 0)) {
        throw new Error('四档价格必须是大于 0 的数字');
    }
    return normalized;
}

async function getPriceLadderDashboardByUser(userId, options = {}) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    const game = normalizeGameProfile(options.game_id, options.game_name || 'WZRY');
    const allAccounts = await listAllAccountsByUser(uid);
    const accounts = allAccounts.filter((row) => (
        isAvailableAccount(row)
        && String(row.game_id || '').trim() === game.game_id
    ));
    const [rules, finishedCounts, runtimes, feature] = await Promise.all([
        listAccountPriceLadderRules(uid, game.game_id),
        listBusinessDayFinishedOrderCountByAccounts(uid, accounts.map((row) => ({
            game_id: game.game_id,
            game_account: row.game_account
        }))),
        listAccountPriceLadderRuntimesByUser(uid),
        getPriceLadderFeatureConfig(uid)
    ]);
    const ruleMap = new Map(rules.map((rule) => [rule.game_account, rule]));
    const runtimeMap = new Map(runtimes
        .filter((runtime) => runtime.game_id === game.game_id && runtime.channel === 'uhaozu')
        .map((runtime) => [runtime.game_account, runtime]));
    const list = accounts.map((row) => {
        const account = String(row.game_account || '').trim();
        const rule = ruleMap.get(account) || null;
        const runtime = runtimeMap.get(account) || null;
        const currentPrice = pickCurrentUhaozuPrice(row);
        const completedCount = Number(finishedCounts[`${game.game_id}::${account}`] || 0);
        return {
            game_id: game.game_id,
            game_name: game.game_name,
            game_account: account,
            display_name: resolveDisplayNameByRow(row, account),
            current_uhaozu_price: currentPrice,
            today_order_count: completedCount,
            current_tier: runtime && runtime.applied_tier
                ? Number(runtime.applied_tier)
                : Math.min(4, Math.max(1, completedCount + 1)),
            ladder_status: runtime ? runtime.status : '',
            prices: rule ? rule.prices : ['', '', '', ''],
            configured: Boolean(rule),
            version: rule ? rule.version : 0,
            copied_from_game_account: rule ? rule.copied_from_game_account : '',
            modify_date: rule ? rule.modify_date : ''
        };
    });
    return {
        game_id: game.game_id,
        game_name: game.game_name,
        count_window: '06:00～次日06:00',
        channel_scope: 'global',
        effective_channel: 'uhaozu',
        feature: {
            enabled: feature.enabled,
            reconcile_required: feature.reconcile_required,
            version: feature.version
        },
        list
    };
}

async function savePriceLadderRuleByUser(userId, input = {}) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    const game = normalizeGameProfile(input.game_id, input.game_name || 'WZRY');
    const account = String(input.game_account || '').trim();
    if (!account) throw new Error('game_account 不能为空');
    const allAccounts = await listAllAccountsByUser(uid);
    const target = allAccounts.find((row) => (
        isAvailableAccount(row)
        && String(row.game_id || '').trim() === game.game_id
        && String(row.game_account || '').trim() === account
    ));
    if (!target) throw new Error('账号不存在、已出售或不属于当前游戏');

    if (String(input.action || '').trim().toLowerCase() === 'clear') {
        return clearAccountPriceLadderConfiguration(uid, {
            game_id: game.game_id,
            game_account: account
        }, {
            expected_version: input.expected_version,
            desc: 'cleared by h5 account price ladder'
        });
    }

    const prices = normalizePrices(input.prices);

    const copiedFrom = String(input.copied_from_game_account || '').trim();
    if (copiedFrom) {
        if (copiedFrom === account) throw new Error('不能从当前账号复制配置');
        const sourceAccount = allAccounts.find((row) => (
            isAvailableAccount(row)
            && String(row.game_id || '').trim() === game.game_id
            && String(row.game_account || '').trim() === copiedFrom
        ));
        const sourceRule = sourceAccount
            ? await getAccountPriceLadderRule(uid, game.game_id, copiedFrom)
            : null;
        if (!sourceRule) throw new Error('复制来源没有可用的已保存配置');
    }

    const saved = await upsertAccountPriceLadderRule(uid, {
        game_id: game.game_id,
        game_name: game.game_name,
        game_account: account,
        prices,
        copied_from_game_account: copiedFrom
    }, {
        expected_version: input.expected_version,
        desc: 'saved by h5 account price ladder'
    });
    const current = pickUhaozuPriceSet(target);
    const existingBaseline = await getAccountChannelPriceBaseline(uid, game.game_id, account, 'uhaozu');
    let baselineCreated = false;
    if (!existingBaseline && current.complete) {
        await saveAccountChannelPriceBaseline(uid, {
            game_id: game.game_id,
            game_name: game.game_name,
            game_account: account,
            channel: 'uhaozu',
            goods_id: current.goods_id,
            prices: current.prices
        }, {
            desc: 'captured when price ladder was enabled'
        });
        baselineCreated = true;
    }
    const feature = await getPriceLadderFeatureConfig(uid);
    let runtime = null;
    if (feature.enabled) {
        const { initializePriceLadderRuntimeOnRuleSave } = require('./price_ladder_reconcile_service');
        runtime = await initializePriceLadderRuntimeOnRuleSave(uid, saved);
    }
    return {
        ...saved,
        baseline_created: baselineCreated,
        baseline_ready: Boolean(existingBaseline || baselineCreated),
        runtime
    };
}

async function getPriceLadderChannelResultByUser(userId, options = {}) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    const game = normalizeGameProfile(options.game_id, options.game_name || 'WZRY');
    const account = String(options.game_account || '').trim();
    if (!account) throw new Error('game_account 不能为空');
    const allAccounts = await listAllAccountsByUser(uid);
    const target = allAccounts.find((row) => (
        isAvailableAccount(row)
        && String(row.game_id || '').trim() === game.game_id
        && String(row.game_account || '').trim() === account
    ));
    if (!target) throw new Error('账号不存在、已出售或不属于当前游戏');

    const [rule, storedBaseline, finishedCounts, errorLogs, runtime] = await Promise.all([
        getAccountPriceLadderRule(uid, game.game_id, account),
        getAccountChannelPriceBaseline(uid, game.game_id, account, 'uhaozu'),
        listBusinessDayFinishedOrderCountByAccounts(uid, [{ game_id: game.game_id, game_account: account }]),
        listPricePublishItemLogsByAccount(uid, {
            channel: 'uhaozu',
            game_account: account,
            game_name: game.game_name,
            publish_status: 'fail',
            limit: 20
        }),
        getAccountPriceLadderRuntime(uid, game.game_id, account, 'uhaozu')
    ]);
    const remote = pickUhaozuPriceSet(target);
    const baseline = storedBaseline || (remote.complete ? {
        prices: remote.prices,
        goods_id: remote.goods_id,
        version: 0,
        source_sync_time: '',
        modify_date: ''
    } : null);
    const hourPrices = rule ? rule.prices : [];
    const tiers = baseline && rule ? buildUhaozuTierPrices(hourPrices, baseline.prices) : [];
    const orderCount = Number(finishedCounts[`${game.game_id}::${account}`] || 0);
    const currentTier = runtime && runtime.applied_tier
        ? Number(runtime.applied_tier)
        : Math.min(4, Math.max(1, orderCount + 1));
    const active = tiers.find((item) => item.tier === currentTier) || null;
    let applyStatus = 'unavailable';
    const remoteMatchesTarget = Boolean(active && remote.complete && samePriceSet(active.prices, remote.prices));
    if (runtime && ['pending', 'blocked', 'failed'].includes(runtime.status)) applyStatus = runtime.status;
    else if (active && remote.complete) applyStatus = remoteMatchesTarget ? 'effective' : 'manual';

    return {
        game_id: game.game_id,
        game_name: game.game_name,
        game_account: account,
        display_name: resolveDisplayNameByRow(target, account),
        current_order_count: orderCount,
        current_tier: currentTier,
        channels: CHANNEL_CAPABILITIES,
        selected_channel: 'uhaozu',
        channel_result: {
            channel: 'uhaozu',
            label: 'U号租',
            enabled: true,
            goods_id: remote.goods_id,
            baseline_status: storedBaseline ? 'saved' : (baseline ? 'preview' : 'unavailable'),
            baseline: baseline ? {
                prices: baseline.prices,
                ratios: buildUhaozuRatios(baseline.prices),
                version: Number(baseline.version || 0),
                source_sync_time: String(baseline.source_sync_time || baseline.modify_date || '').trim()
            } : null,
            remote_current: remote.prices,
            remote_complete: remote.complete,
            tiers,
            apply_status: applyStatus,
            remote_matches_target: remoteMatchesTarget,
            runtime: runtime ? {
                status: runtime.status,
                desired_tier: runtime.desired_tier,
                applied_tier: runtime.applied_tier,
                last_error: runtime.last_error,
                modify_date: runtime.modify_date
            } : null,
            error_logs: errorLogs.map(sanitizePublishLog)
        }
    };
}

async function setPriceLadderFeatureByUser(userId, input = {}) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    if (typeof input.enabled !== 'boolean') throw new Error('enabled 必须是布尔值');
    return setPriceLadderFeatureEnabled(uid, input.enabled, {
        expected_version: input.expected_version,
        desc: input.enabled ? 'enabled by h5 price ladder' : 'disabled by h5 price ladder'
    });
}

module.exports = {
    getPriceLadderDashboardByUser,
    savePriceLadderRuleByUser,
    setPriceLadderFeatureByUser,
    getPriceLadderChannelResultByUser,
    _internal: {
        roundMoney,
        pickCurrentUhaozuPrice,
        pickUhaozuPriceSet,
        buildUhaozuRatios,
        buildUhaozuTierPrices,
        samePriceSet,
        sanitizePublishLog,
        listAllAccountsByUser,
        isAvailableAccount,
        normalizePrices,
        CHANNEL_CAPABILITIES
    }
};
