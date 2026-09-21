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
const uhaozuAdapter = require('./channel_adapters/uhaozu_price_adapter');
const {
    getPriceChannelAdapter,
    listPriceChannelCapabilities
} = require('./channel_adapters/channel_price_registry');

const CHANNEL_CAPABILITIES = listPriceChannelCapabilities();

function roundMoney(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Number(n.toFixed(2)) : 0;
}

function pickCurrentUhaozuPrice(row = {}) {
    return pickUhaozuPriceSet(row).prices.hour;
}

function pickUhaozuPriceSet(row = {}) {
    return uhaozuAdapter.pickCurrentPriceSet(row);
}

function buildUhaozuRatios(prices = {}) {
    return uhaozuAdapter.buildRatios(prices);
}

function buildUhaozuTierPrices(hourPrices = [], baselinePrices = {}) {
    return uhaozuAdapter.buildTierPrices(hourPrices, baselinePrices);
}

function samePriceSet(left = {}, right = {}) {
    return uhaozuAdapter.samePriceSet(left, right);
}

function canonicalPricesFromLogData(data = {}, fallback = {}) {
    if (data && data.prices && typeof data.prices === 'object') return data.prices;
    if (data && data.target_prices && typeof data.target_prices === 'object') return data.target_prices;
    return fallback;
}

function sanitizePublishLog(row = {}) {
    const fixedBefore = {
        hour: roundMoney(row.price_before_hour),
        night: roundMoney(row.price_before_night),
        day: roundMoney(row.price_before_day),
        week: roundMoney(row.price_before_week)
    };
    const fixedTarget = {
        hour: roundMoney(row.price_target_hour),
        night: roundMoney(row.price_target_night),
        day: roundMoney(row.price_target_day),
        week: roundMoney(row.price_target_week)
    };
    const fixedAfter = {
        hour: roundMoney(row.price_after_hour),
        night: roundMoney(row.price_after_night),
        day: roundMoney(row.price_after_day),
        week: roundMoney(row.price_after_week)
    };
    return {
        id: Number(row.id || 0),
        batch_id: String(row.batch_id || '').trim(),
        publish_status: String(row.publish_status || '').trim(),
        trigger_source: String(row.trigger_source || '').trim(),
        fail_message: String(row.fail_message || '').trim().slice(0, 500),
        error_detail: row.response_data && typeof row.response_data === 'object'
            ? row.response_data
            : null,
        before_prices: canonicalPricesFromLogData(row.before_data, fixedBefore),
        target_prices: canonicalPricesFromLogData(row.request_data, fixedTarget),
        remote_prices: canonicalPricesFromLogData(row.after_data, fixedAfter),
        verification_status: String(row.response_data && row.response_data.verification_status || '').trim(),
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
    const runtimeMap = new Map();
    for (const runtime of runtimes.filter((item) => item.game_id === game.game_id)) {
        const current = runtimeMap.get(runtime.game_account);
        if (!current || runtime.channel === 'uhaozu') runtimeMap.set(runtime.game_account, runtime);
    }
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
        effective_channels: CHANNEL_CAPABILITIES.filter((item) => item.enabled).map((item) => item.channel),
        feature: {
            enabled: feature.enabled,
            reconcile_required: feature.reconcile_required,
            version: feature.version
        },
        list
    };
}

async function savePriceLadderRuleByUser(userId, input = {}, options = {}) {
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
    let publishResult = null;
    if (feature.enabled) {
        const {
            initializePriceLadderRuntimeOnRuleSave,
            reconcilePendingPriceLaddersByUser
        } = require('./price_ladder_reconcile_service');
        runtime = await initializePriceLadderRuntimeOnRuleSave(uid, saved, {
            now: options.now,
            account_row: target,
            trigger_source: 'rule_saved'
        });
        publishResult = await reconcilePendingPriceLaddersByUser(uid, {
            now: options.now,
            allow_apply: true,
            publisher: options.publisher,
            publishers: options.publishers,
            feature_guard: options.feature_guard,
            accounts: [{ game_id: game.game_id, game_account: account }]
        });
        runtime = await getAccountPriceLadderRuntime(uid, game.game_id, account, 'uhaozu')
            || await getAccountPriceLadderRuntime(uid, game.game_id, account, 'uuzuhao');
    }
    return {
        ...saved,
        baseline_created: baselineCreated,
        baseline_ready: Boolean(existingBaseline || baselineCreated),
        runtime,
        publish_result: publishResult
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

    const [rule, finishedCounts] = await Promise.all([
        getAccountPriceLadderRule(uid, game.game_id, account),
        listBusinessDayFinishedOrderCountByAccounts(uid, [{ game_id: game.game_id, game_account: account }])
    ]);
    const orderCount = Number(finishedCounts[`${game.game_id}::${account}`] || 0);
    const channelResults = {};
    for (const capability of CHANNEL_CAPABILITIES) {
        const adapter = getPriceChannelAdapter(capability.channel);
        if (!adapter) {
            channelResults[capability.channel] = {
                ...capability,
                available: false,
                tiers: [],
                adjustment_logs: [],
                apply_status: 'unavailable'
            };
            continue;
        }
        const available = adapter.isAvailable(target);
        const [runtime, adjustmentLogs, resolved] = await Promise.all([
            getAccountPriceLadderRuntime(uid, game.game_id, account, capability.channel),
            listPricePublishItemLogsByAccount(uid, {
                channel: capability.channel,
                game_account: account,
                game_name: game.game_name,
                limit: 20
            }),
            rule ? adapter.resolveTierPrices({
                user_id: uid,
                rule,
                account_row: target,
                allow_preview: true
            }) : Promise.resolve({ tiers: [], baseline: null, baseline_status: 'unavailable' })
        ]);
        const remote = adapter.pickCurrentPriceSet(target);
        const tiers = Array.isArray(resolved.tiers) ? resolved.tiers : [];
        const currentTier = runtime && runtime.applied_tier
            ? Number(runtime.applied_tier)
            : Math.min(4, Math.max(1, orderCount + 1));
        const active = tiers.find((item) => item.tier === currentTier) || null;
        const remoteMatchesTarget = Boolean(active && remote.complete && adapter.samePriceSet(active.prices, remote.prices));
        let applyStatus = 'unavailable';
        if (runtime && ['pending', 'blocked', 'failed'].includes(runtime.status)) applyStatus = runtime.status;
        else if (active && remote.complete) {
            applyStatus = remoteMatchesTarget && remote.comparable_keys.length < capability.package_keys.length
                ? 'effective_partial'
                : (remoteMatchesTarget ? 'effective' : 'manual');
        }
        const baseline = resolved.baseline || null;
        channelResults[capability.channel] = {
            ...capability,
            available,
            goods_id: remote.goods_id,
            baseline_status: resolved.baseline_status || 'unavailable',
            baseline: baseline ? {
                prices: baseline.prices,
                ratios: capability.channel === 'uhaozu' ? buildUhaozuRatios(baseline.prices) : null,
                version: Number(baseline.version || 0),
                source_sync_time: String(baseline.source_sync_time || baseline.modify_date || '').trim()
            } : null,
            remote_current: remote.prices,
            remote_complete: remote.complete,
            remote_comparable_keys: remote.comparable_keys || [],
            min_rent_hour: Number(remote.min_rent_hour || 0),
            tiers,
            current_tier: currentTier,
            apply_status: applyStatus,
            remote_matches_target: remoteMatchesTarget,
            verification_note: adapter.verification_note,
            runtime: runtime ? {
                status: runtime.status,
                desired_tier: runtime.desired_tier,
                applied_tier: runtime.applied_tier,
                last_error: runtime.last_error,
                modify_date: runtime.modify_date
            } : null,
            adjustment_logs: adjustmentLogs.map(sanitizePublishLog)
        };
    }
    const requestedChannel = String(options.channel || 'uhaozu').trim();
    const selectedChannel = channelResults[requestedChannel] ? requestedChannel : 'uhaozu';
    const selectedResult = channelResults[selectedChannel];

    return {
        game_id: game.game_id,
        game_name: game.game_name,
        game_account: account,
        display_name: resolveDisplayNameByRow(target, account),
        current_order_count: orderCount,
        current_tier: Number(selectedResult && selectedResult.current_tier || Math.min(4, Math.max(1, orderCount + 1))),
        channels: CHANNEL_CAPABILITIES.map((item) => ({
            ...item,
            available: Boolean(channelResults[item.channel] && channelResults[item.channel].available)
        })),
        selected_channel: selectedChannel,
        channel_result: selectedResult,
        channel_results: channelResults
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
