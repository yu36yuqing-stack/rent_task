'use strict';

const { randomUUID } = require('crypto');
const {
    _internal: { businessDateText, isFinishedPriceLadderStatus }
} = require('../database/order_db');
const {
    getAccountPriceLadderRule,
    listAccountPriceLadderRulesByUser
} = require('../database/account_price_ladder_rule_db');
const {
    getAccountPriceLadderRuntime,
    listAccountPriceLadderRuntimesByUser,
    upsertAccountPriceLadderRuntime
} = require('../database/account_price_ladder_runtime_db');
const { listPaidCountByAccounts } = require('../order/service/order_query_service');
const { listUserPlatformAuth } = require('../database/user_platform_auth_db');
const {
    getPriceLadderFeatureConfig,
    markPriceLadderFeatureReconciled
} = require('../database/price_ladder_feature_config_db');
const { listUserGameAccounts } = require('../database/user_game_account_db');
const {
    getPriceChannelAdapter,
    listEnabledPriceChannelAdapters
} = require('./channel_adapters/channel_price_registry');

const CHANNEL = 'uhaozu';
const RETRY_DELAY_MINUTES = 30;

function tierByCompletedCount(count) {
    return Math.min(4, Math.max(1, Math.floor(Number(count || 0)) + 1));
}

function businessDateForOrder(order = {}) {
    const text = String(order.start_time || '').trim();
    if (!text) return '';
    const date = new Date(text.replace(' ', 'T'));
    return Number.isNaN(date.getTime()) ? '' : businessDateText(6, date);
}

function accountCandidate(order, delta, orderNo) {
    if (!order || !isFinishedPriceLadderStatus(order.order_status)) return null;
    const gameId = String(order.game_id || '').trim();
    const gameAccount = String(order.game_account || '').trim();
    const businessDate = businessDateForOrder(order);
    if (!gameId || !gameAccount || !businessDate) return null;
    return {
        game_id: gameId,
        game_name: String(order.game_name || '').trim(),
        game_account: gameAccount,
        business_date: businessDate,
        delta: Number(delta || 0),
        order_no: String(orderNo || '').trim()
    };
}

function buildPriceLadderCandidatesFromOrderWrite(order = {}, orderWrite = {}) {
    if (!orderWrite || orderWrite.price_ladder_relevant_changed !== true) return [];
    const out = [];
    const previous = accountCandidate(orderWrite.previous_order, -1, order.order_no);
    const current = accountCandidate(orderWrite.current_order || order, 1, order.order_no);
    if (previous) out.push(previous);
    if (current) out.push(current);
    return mergePriceLadderCandidates(out);
}

function mergePriceLadderCandidates(candidates = []) {
    const map = new Map();
    for (const item of Array.isArray(candidates) ? candidates : []) {
        const gameId = String(item && item.game_id || '').trim();
        const account = String(item && item.game_account || '').trim();
        const day = String(item && item.business_date || '').slice(0, 10);
        if (!gameId || !account || !day) continue;
        const key = `${day}::${gameId}::${account}`;
        const old = map.get(key) || {
            game_id: gameId,
            game_name: String(item.game_name || '').trim(),
            game_account: account,
            business_date: day,
            delta: 0,
            order_nos: []
        };
        old.delta += Number(item.delta || 0);
        if (item.order_no && !old.order_nos.includes(String(item.order_no))) old.order_nos.push(String(item.order_no));
        if (!old.game_name && item.game_name) old.game_name = String(item.game_name).trim();
        map.set(key, old);
    }
    return Array.from(map.values()).filter((item) => item.delta !== 0);
}

function priceSignature(tier, prices = {}, ruleVersion = 0, baselineVersion = 0) {
    const normalizedPrices = Object.fromEntries(Object.keys(prices || {}).sort().map((key) => [
        key,
        Number(Number(prices[key] || 0).toFixed(2))
    ]));
    return JSON.stringify({
        tier: Number(tier || 0),
        prices: normalizedPrices,
        rule_version: Number(ruleVersion || 0),
        baseline_version: Number(baselineVersion || 0)
    });
}

function retryAtText(nowValue = new Date(), delayMinutes = RETRY_DELAY_MINUTES) {
    const date = nowValue instanceof Date ? new Date(nowValue.getTime()) : new Date(nowValue);
    date.setMinutes(date.getMinutes() + Number(delayMinutes || 0));
    const p = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

function isRetryDue(runtime = {}, nowValue = new Date()) {
    const text = String(runtime.next_retry_at || '').trim();
    if (!text) return true;
    const due = new Date(text.replace(' ', 'T'));
    const now = nowValue instanceof Date ? nowValue : new Date(nowValue);
    return Number.isNaN(due.getTime()) || due.getTime() <= now.getTime();
}

async function listAllAccountsByUser(userId) {
    const out = [];
    let page = 1;
    for (;;) {
        const result = await listUserGameAccounts(userId, page, 200);
        const rows = Array.isArray(result && result.list) ? result.list : [];
        out.push(...rows);
        if (rows.length < 200 || out.length >= Number(result && result.total || 0)) break;
        page += 1;
    }
    return out;
}

function accountKey(gameId, gameAccount) {
    return `${String(gameId || '').trim()}::${String(gameAccount || '').trim()}`;
}

function applicableAdapters(accountRow = {}) {
    if (!accountRow || String(accountRow.asset_status || '').toLowerCase() === 'sold' || Number(accountRow.is_deleted || 0)) return [];
    return listEnabledPriceChannelAdapters(accountRow);
}

async function initializePriceLadderRuntimeOnRuleSave(userId, rule, options = {}) {
    const uid = Number(userId || 0);
    if (!uid || !rule) return null;
    const day = businessDateText(6, options.now || new Date());
    const key = { game_id: rule.game_id, game_account: rule.game_account };
    const counts = await listPaidCountByAccounts(uid, [key], { mode: 'rolling_24h', now: options.now });
    const count = Number(counts[`${rule.game_id}::${rule.game_account}`] || 0);
    const tier = tierByCompletedCount(count);
    const rows = options.account_row ? [options.account_row] : await listAllAccountsByUser(uid);
    const accountRow = rows.find((row) => accountKey(row.game_id, row.game_account) === accountKey(rule.game_id, rule.game_account));
    if (!accountRow) return null;
    const requestedChannels = new Set((Array.isArray(options.channels) ? options.channels : [])
        .map((channel) => String(channel || '').trim()).filter(Boolean));
    const runtimes = [];
    for (const adapter of applicableAdapters(accountRow).filter((item) => (
        requestedChannels.size === 0 || requestedChannels.has(item.channel)
    ))) {
        const current = await getAccountPriceLadderRuntime(uid, rule.game_id, rule.game_account, adapter.channel);
        runtimes.push(await upsertAccountPriceLadderRuntime(uid, {
            game_id: rule.game_id,
            game_name: rule.game_name,
            game_account: rule.game_account,
            channel: adapter.channel,
            business_date: day,
            completed_order_count: count,
            desired_tier: tier,
            applied_tier: current ? current.applied_tier : 0,
            pending_count_delta: 0,
            rule_version: rule.version,
            status: 'pending',
            trigger_source: String(options.trigger_source || 'rule_saved').trim() || 'rule_saved',
            last_error: '',
            retry_count: 0,
            next_retry_at: ''
        }, { desc: `queue ladder runtime after rule save: ${adapter.channel}` }));
    }
    return runtimes.find((runtime) => runtime.channel === CHANNEL) || runtimes[0] || null;
}

async function enqueueFeatureActivationReconcile(userId, options = {}) {
    const uid = Number(userId || 0);
    const rules = await listAccountPriceLadderRulesByUser(uid);
    const accountRows = await listAllAccountsByUser(uid);
    const accountMap = new Map(accountRows.map((row) => [accountKey(row.game_id, row.game_account), row]));
    let queued = 0;
    let initialized = 0;
    for (const rule of rules) {
        const accountRow = accountMap.get(accountKey(rule.game_id, rule.game_account));
        for (const adapter of applicableAdapters(accountRow)) {
            const runtime = await getAccountPriceLadderRuntime(uid, rule.game_id, rule.game_account, adapter.channel);
            if (!runtime) {
                await initializePriceLadderRuntimeOnRuleSave(uid, rule, {
                    ...options,
                    account_row: accountRow,
                    channels: [adapter.channel],
                    trigger_source: 'feature_enabled_reconcile'
                });
                initialized += 1;
                continue;
            }
            await upsertAccountPriceLadderRuntime(uid, {
                ...runtime,
                pending_count_delta: 0,
                rule_version: rule.version,
                status: 'pending',
                trigger_source: 'feature_enabled_reconcile',
                last_error: '',
                next_retry_at: ''
            }, { desc: `queued after price ladder feature enabled: ${adapter.channel}` });
            queued += 1;
        }
    }
    return { scanned: rules.length, queued, initialized };
}

async function enqueueMissingPriceLadderChannelRuntimes(userId, options = {}) {
    const uid = Number(userId || 0);
    const rules = await listAccountPriceLadderRulesByUser(uid);
    if (rules.length === 0) return { scanned: 0, initialized: 0 };
    const accountRows = await listAllAccountsByUser(uid);
    const accountMap = new Map(accountRows.map((row) => [accountKey(row.game_id, row.game_account), row]));
    let initialized = 0;
    for (const rule of rules) {
        const accountRow = accountMap.get(accountKey(rule.game_id, rule.game_account));
        for (const adapter of applicableAdapters(accountRow)) {
            const runtime = await getAccountPriceLadderRuntime(uid, rule.game_id, rule.game_account, adapter.channel);
            if (runtime) continue;
            await initializePriceLadderRuntimeOnRuleSave(uid, rule, {
                ...options,
                account_row: accountRow,
                channels: [adapter.channel],
                trigger_source: 'channel_enabled_reconcile'
            });
            initialized += 1;
        }
    }
    return { scanned: rules.length, initialized };
}

async function enqueueChannelPackageRatioChange(userId, channel, options = {}) {
    const uid = Number(userId || 0);
    const channelName = String(channel || '').trim();
    if (!uid) throw new Error('user_id 不合法');
    if (!channelName || !getPriceChannelAdapter(channelName)) throw new Error(`不支持的调价渠道: ${channelName || '-'}`);
    const rules = await listAccountPriceLadderRulesByUser(uid);
    if (rules.length === 0) return { scanned: 0, queued: 0 };
    const accountRows = await listAllAccountsByUser(uid);
    const accountMap = new Map(accountRows.map((row) => [accountKey(row.game_id, row.game_account), row]));
    let queued = 0;
    for (const rule of rules) {
        const accountRow = accountMap.get(accountKey(rule.game_id, rule.game_account));
        const adapter = getPriceChannelAdapter(channelName);
        if (!accountRow || !adapter || !adapter.isAvailable(accountRow)) continue;
        await initializePriceLadderRuntimeOnRuleSave(uid, rule, {
            ...options,
            account_row: accountRow,
            channels: [channelName],
            trigger_source: String(options.trigger_source || 'package_ratio_saved').trim() || 'package_ratio_saved'
        });
        queued += 1;
    }
    return { scanned: rules.length, queued };
}

async function getPriceLadderApplyBlock(userId, accountRow = {}) {
    void userId;
    void accountRow;
    return { blocked: false, reason: '' };
}

function safeLogMessage(value) {
    return String(value || '')
        .replace(/\bBearer\s+\S+/gi, 'Bearer [REDACTED]')
        .replace(/((?:token|app_secret|password|authorization)\s*["']?\s*[:=]\s*["']?)[^"'\s,;}]+/gi, '$1[REDACTED]')
        .slice(0, 400);
}

function dailyCalculationLog(adapter, rule, resolved, desired) {
    try {
        const key = adapter.channel === 'uhaozu' ? 'day' : 'p24';
        const { ratios, daily_policy: policy } = resolved.baseline;
        const build = adapter.buildTierPricesByRatios || adapter.buildTierPrices;
        const base = build([rule.prices[0]], ratios)[0].prices;
        const factor = policy.mode === 'decrease' ? policy.factors[desired.tier - 1] : 1;
        return {
            mode: policy.mode, daily_price_key: key,
            first_tier_hour_price: base.hour, target_tier_hour_price: desired.prices.hour,
            daily_ratio: ratios[key], base_daily_price: base[key],
            calculation_base: policy.mode === 'follow' ? 'target_tier_hour' : 'first_tier_daily',
            factor, target_daily_price: desired.prices[key]
        };
    } catch (_) {
        return null;
    }
}

function publishVerificationLog(adapter, published, targetPrices) {
    const unknown = { verification_status: 'unknown', verified_price_keys: [], readback_prices: {} };
    try {
        if (!published || !published.ok) return { ...unknown, verification_status: 'failed' };
        const prices = published.prices || {};
        const keys = adapter.channel === 'uuzuhao' ? ['hour']
            : adapter.channel === 'zuhaowang' && published.rent_mode === 'day_only' ? ['p24', 'p72', 'p168']
                : adapter.channel === 'zuhaowang' && published.rent_mode === 'hour_only' ? ['hour'] : adapter.package_keys;
        const uFields = { hour: 'rentalByHour', night: 'rentalByNight', day: 'rentalByDay', week: 'rentalByWeek' };
        const readback = {};
        for (const key of keys) {
            const value = prices[adapter.channel === 'uhaozu' ? uFields[key] : key];
            if (typeof value === 'number' && Number.isFinite(value) && value > 0) readback[key] = value;
        }
        const matched = keys.filter(key => Object.hasOwn(readback, key) && readback[key] === targetPrices[key]);
        // Only compare returned facts. The YY publisher returns target packages, not package readback.
        const complete = matched.length === keys.length && keys.length > 0;
        const partial = published.verification_status === 'partial' || adapter.channel === 'uuzuhao';
        return {
            verification_status: complete ? (partial ? 'partial' : 'full') : 'unknown',
            verified_price_keys: matched, readback_prices: readback
        };
    } catch (_) {
        return unknown;
    }
}

function writePriceLadderLog(logger, event, data) {
    try {
        const method = data.status === 'failed' || data.status === 'error' || data.status === 'partial_failed' ? 'warn' : 'log';
        const writer = logger[method] || logger.log;
        writer.call(logger, `[PriceLadder][${event}] ${JSON.stringify(data)}`);
    } catch (_) {
        // Observability must not change a confirmed pricing result or its retry policy.
    }
}

async function observePriceLadderReconciliation(userId, options, execute) {
    const startedAt = Date.now();
    const now = options.now || new Date();
    const end = new Date(now).getTime();
    const logger = options.logger || console;
    const context = {
        user_id: Number(userId || 0),
        trace_id: String(options.trace_id || options.trigger_task_id || randomUUID()),
        count_mode: 'rolling_24h',
        window_start: Number.isFinite(end) ? new Date(end - 24 * 3600 * 1000).toISOString() : '',
        window_end: Number.isFinite(end) ? new Date(end).toISOString() : '',
        allow_apply: options.allow_apply !== false
    };
    const accounts = new Set();
    let attempted = 0;
    let skipped = 0;
    let retryWaiting = 0;
    const observe = (event, data) => {
        accounts.add(`${data.game_id}::${data.game_account}`);
        if (event === 'apply_start') attempted += 1;
        if (data.status === 'skipped') skipped += 1;
        if (data.reason === 'retry_not_due') retryWaiting += 1;
        if (data.status === 'unchanged' && !data.publish_attempted) return;
        writePriceLadderLog(logger, event, { ...context, ...data });
    };
    writePriceLadderLog(logger, 'start', context);
    try {
        const output = await execute({ ...options, now }, observe);
        const result = output.reconciliation || output;
        writePriceLadderLog(logger, 'summary', {
            ...context,
            status: result.failed > 0 ? 'partial_failed' : (result.pending > 0 ? 'pending' : 'ok'),
            scanned_channels: result.scanned,
            scanned_accounts: accounts.size,
            attempted,
            applied: result.applied,
            unchanged: result.unchanged,
            failed: result.failed,
            pending: result.pending,
            skipped,
            retry_waiting: retryWaiting,
            error_code: result.failed > 0 ? 'CHANNEL_RECONCILE_FAILED' : '',
            duration_ms: Date.now() - startedAt
        });
        return output;
    } catch (error) {
        writePriceLadderLog(logger, 'summary', {
            ...context, status: 'error', scanned_channels: null, attempted,
            error_code: 'RECONCILE_ERROR', error_message: safeLogMessage(error && error.message || error),
            duration_ms: Date.now() - startedAt
        });
        throw error;
    }
}

async function reconcilePendingPriceLaddersByUser(userId, options = {}) {
    return observePriceLadderReconciliation(userId, options, (effectiveOptions, observe) => (
        executePriceLadderReconciliation(userId, effectiveOptions, observe)
    ));
}

async function executePriceLadderReconciliation(userId, options, observe) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    const now = options.now || new Date();
    const day = businessDateText(6, now);
    const allowApply = options.allow_apply !== false;
    const accountKeys = new Set((Array.isArray(options.accounts) ? options.accounts : [])
        .map((item) => `${String(item && item.game_id || '').trim()}::${String(item && item.game_account || '').trim()}`)
        .filter((key) => key !== '::'));
    const runtimes = (await listAccountPriceLadderRuntimesByUser(uid)).filter((row) => (
        accountKeys.size === 0 || accountKeys.has(`${row.game_id}::${row.game_account}`)
    ));
    if (runtimes.length === 0) return { scanned: 0, applied: 0, unchanged: 0, blocked: 0, failed: 0, pending: 0, list: [] };

    const accountRows = await listAllAccountsByUser(uid);
    const accountMap = new Map(accountRows.map((row) => [`${String(row.game_id || '').trim()}::${String(row.game_account || '').trim()}`, row]));
    // A failed/incomplete sync is not a zero-order snapshot: never publish from it.
    const counts = allowApply ? await listPaidCountByAccounts(uid, runtimes.map((row) => ({
        game_id: row.game_id,
        game_account: row.game_account
    })), { mode: 'rolling_24h', now }) : null;
    const disabledChannels = new Set((await listUserPlatformAuth(uid))
        .filter((row) => row.channel_enabled === false).map((row) => row.platform));
    const featureGuard = options.feature_guard || getPriceLadderFeatureConfig;
    const summary = { scanned: runtimes.length, applied: 0, unchanged: 0, blocked: 0, failed: 0, pending: 0, list: [] };
    const recordResult = (runtime, result, extra = {}) => {
        summary.list.push(result);
        const count = counts ? Number(counts[`${runtime.game_id}::${runtime.game_account}`] || 0) : null;
        observe('result', {
            game_id: runtime.game_id,
            game_account: runtime.game_account,
            channel: runtime.channel,
            count_24h: count,
            count_snapshot_valid: counts !== null,
            from_tier: Number(runtime.applied_tier || 0),
            to_tier: counts ? tierByCompletedCount(count) : Number(runtime.desired_tier || 0),
            trigger_source: runtime.trigger_source,
            retry_count: runtime.retry_count,
            next_retry_at: runtime.next_retry_at,
            status: result.status,
            reason: result.reason || '',
            batch_id: result.batch_id || '',
            ...extra
        });
    };

    for (const runtime of runtimes) {
        const key = `${runtime.game_id}::${runtime.game_account}`;
        const rule = await getAccountPriceLadderRule(uid, runtime.game_id, runtime.game_account);
        const accountRow = accountMap.get(key);
        const adapter = getPriceChannelAdapter(runtime.channel);
        if (disabledChannels.has(runtime.channel) || (accountRow && adapter && !applicableAdapters(accountRow).includes(adapter))) {
            recordResult(runtime, { game_account: runtime.game_account, channel: runtime.channel, status: 'skipped', reason: 'channel_unavailable' });
            continue;
        }
        if (!allowApply) {
            await upsertAccountPriceLadderRuntime(uid, {
                ...runtime,
                status: runtime.status === 'failed' ? 'failed' : 'pending',
                last_error: runtime.status === 'failed' ? runtime.last_error : '授权渠道订单同步不完整'
            }, { desc: 'price ladder waits for complete order sync' });
            summary.pending += 1;
            recordResult(runtime, { game_account: runtime.game_account, channel: runtime.channel, status: 'pending', reason: 'order_sync_incomplete' });
            continue;
        }
        const count = Number(counts[key] || 0);
        const desiredTier = tierByCompletedCount(count);
        const runtimeTrigger = runtime.status === 'applied' ? 'rolling_24h_reconcile' : String(runtime.trigger_source || '').trim();
        const appliedTier = Number(runtime.applied_tier || 0);
        // Refresh targets even while a failed channel is waiting for its retry slot.
        runtime.business_date = day;
        runtime.completed_order_count = count;
        runtime.desired_tier = desiredTier;
        runtime.pending_count_delta = 0;
        runtime.trigger_source = runtimeTrigger || 'rolling_24h_reconcile';
        if (!isRetryDue(runtime, now)) {
            await upsertAccountPriceLadderRuntime(uid, runtime, { desc: 'refresh rolling target while retry waits' });
            summary.pending += 1;
            recordResult(runtime, { game_account: runtime.game_account, channel: runtime.channel, status: 'pending', reason: 'retry_not_due', tier: desiredTier }, { error_message: safeLogMessage(runtime.last_error) });
            continue;
        }
        if (!rule || !accountRow || !adapter) {
            const missingMessage = !rule ? '阶梯规则不存在' : (!accountRow ? '账号不存在' : `不支持的调价渠道: ${runtime.channel}`);
            await upsertAccountPriceLadderRuntime(uid, {
                ...runtime,
                completed_order_count: count,
                desired_tier: desiredTier,
                applied_tier: appliedTier,
                pending_count_delta: 0,
                status: 'failed',
                last_error: missingMessage,
                retry_count: runtime.retry_count + 1,
                next_retry_at: retryAtText(now)
            }, { desc: 'price ladder reconcile missing data' });
            summary.failed += 1;
            recordResult(runtime, {
                game_account: runtime.game_account,
                channel: runtime.channel,
                status: 'failed',
                reason: !rule ? 'rule_missing' : (!accountRow ? 'account_missing' : 'channel_unsupported')
            }, { error_message: safeLogMessage(missingMessage), next_retry_at: retryAtText(now), retry_count: runtime.retry_count + 1 });
            continue;
        }

        let resolved;
        try {
            resolved = await adapter.resolveTierPrices({
                user_id: uid, rule, account_row: accountRow, allow_preview: false
            });
        } catch (error) {
            resolved = { ready: false, error: String(error && error.message || error) };
        }
        const baselineVersion = Number(resolved.baseline_version || 0);
        const tiers = Array.isArray(resolved.tiers) ? resolved.tiers : [];
        const desired = tiers.find((item) => item.tier === desiredTier) || null;
        const signature = desired ? priceSignature(desiredTier, desired.prices, rule.version, baselineVersion) : '';
        const verifyRemote = ['rule_saved', 'package_ratio_saved', 'feature_enabled_reconcile', 'channel_enabled_reconcile'].includes(runtimeTrigger)
            || Number(runtime.rule_version || 0) !== Number(rule.version || 0)
            || Number(runtime.baseline_version || 0) !== baselineVersion;
        if (desiredTier === appliedTier && !verifyRemote) {
            await upsertAccountPriceLadderRuntime(uid, {
                ...runtime,
                business_date: day,
                completed_order_count: count,
                desired_tier: desiredTier,
                applied_tier: appliedTier,
                pending_count_delta: 0,
                rule_version: rule.version,
                baseline_version: baselineVersion,
                desired_price_signature: signature,
                status: 'applied',
                last_error: '',
                retry_count: 0,
                next_retry_at: ''
            }, { desc: 'price ladder unchanged; preserve channel manual price' });
            summary.unchanged += 1;
            recordResult(runtime, { game_account: runtime.game_account, channel: runtime.channel, status: 'unchanged', tier: desiredTier });
            continue;
        }
        if (!resolved.ready || !desired || Object.values(desired.prices).some((value) => Number(value || 0) <= 0)) {
            const message = String(resolved.error || '渠道套餐价格计算失败');
            await upsertAccountPriceLadderRuntime(uid, {
                ...runtime,
                completed_order_count: count,
                desired_tier: desiredTier,
                applied_tier: appliedTier,
                pending_count_delta: 0,
                status: 'failed',
                baseline_version: baselineVersion,
                last_error: message,
                retry_count: runtime.retry_count + 1,
                next_retry_at: retryAtText(now)
            }, { desc: `price ladder target unavailable: ${runtime.channel}` });
            summary.failed += 1;
            recordResult(runtime, {
                game_account: runtime.game_account,
                channel: runtime.channel,
                status: 'failed',
                reason: resolved.reason || 'target_unavailable'
            }, { error_message: safeLogMessage(message), next_retry_at: retryAtText(now), retry_count: runtime.retry_count + 1 });
            continue;
        }
        const latestFeature = await featureGuard(uid);
        if (!latestFeature || latestFeature.enabled !== true) {
            summary.pending += 1;
            recordResult(runtime, { game_account: runtime.game_account, channel: runtime.channel, status: 'pending', reason: 'feature_disabled' });
            continue;
        }
        const latestRule = await getAccountPriceLadderRule(uid, runtime.game_id, runtime.game_account);
        if (!latestRule || Number(latestRule.version || 0) !== Number(rule.version || 0)) {
            summary.pending += 1;
            recordResult(runtime, {
                game_account: runtime.game_account,
                channel: runtime.channel,
                status: 'pending',
                reason: latestRule ? 'rule_changed' : 'rule_cleared'
            });
            continue;
        }

        let published;
        try {
            const publisher = options.publishers && options.publishers[runtime.channel]
                ? options.publishers[runtime.channel]
                : (options.publisher || adapter.publish);
            observe('apply_start', {
                game_id: runtime.game_id, game_account: runtime.game_account, channel: runtime.channel,
                status: 'applying', count_24h: count, from_tier: appliedTier, to_tier: desiredTier,
                trigger_source: runtime.trigger_source, retry_count: runtime.retry_count,
                target_prices: desired.prices,
                daily_policy: resolved.baseline && resolved.baseline.daily_policy,
                daily_calculation: dailyCalculationLog(adapter, rule, resolved, desired),
                rule_version: Number(rule.version || 0), baseline_version: baselineVersion
            });
            published = await publisher(uid, {
                game_id: runtime.game_id,
                game_name: rule.game_name,
                game_account: runtime.game_account,
                goods_id: adapter.productId(accountRow),
                tier: desiredTier,
                prices: desired.prices,
                trigger_source: runtime.trigger_source || 'price_ladder',
                force_publish: adapter.shouldForcePublish(runtimeTrigger)
            });
        } catch (error) {
            published = { ok: false, message: String(error && error.message ? error.message : error) };
        }
        const verification = publishVerificationLog(adapter, published, desired.prices);
        if (published && published.ok) {
            await upsertAccountPriceLadderRuntime(uid, {
                ...runtime,
                business_date: day,
                completed_order_count: count,
                desired_tier: desiredTier,
                applied_tier: desiredTier,
                pending_count_delta: 0,
                rule_version: rule.version,
                baseline_version: baselineVersion,
                desired_price_signature: signature,
                applied_price_signature: signature,
                status: 'applied',
                last_error: '',
                retry_count: 0,
                next_retry_at: '',
                last_apply_date: new Date(now).toISOString()
            }, { desc: `price ladder applied to ${runtime.channel}` });
            if (published.changed === false) {
                summary.unchanged += 1;
                recordResult(runtime, { game_account: runtime.game_account, channel: runtime.channel, status: 'unchanged', tier: desiredTier }, {
                    ...verification, publish_attempted: true, confirmed_tier: desiredTier, batch_id: published.batch_id || '', retry_count: 0, next_retry_at: ''
                });
            } else {
                summary.applied += 1;
                recordResult(runtime, {
                    game_account: runtime.game_account,
                    channel: runtime.channel,
                    status: 'applied',
                    tier: desiredTier,
                    batch_id: published.batch_id || ''
                }, { ...verification, publish_attempted: true, confirmed_tier: desiredTier, retry_count: 0, next_retry_at: '' });
            }
        } else {
            const message = String(published && published.message || '价格发布失败');
            await upsertAccountPriceLadderRuntime(uid, {
                ...runtime,
                completed_order_count: count,
                desired_tier: desiredTier,
                applied_tier: appliedTier,
                pending_count_delta: 0,
                rule_version: rule.version,
                baseline_version: baselineVersion,
                desired_price_signature: signature,
                status: 'failed',
                last_error: message,
                retry_count: runtime.retry_count + 1,
                next_retry_at: retryAtText(now)
            }, { desc: 'price ladder publish failed' });
            summary.failed += 1;
            recordResult(runtime, { game_account: runtime.game_account, channel: runtime.channel, status: 'failed', reason: message }, {
                reason: 'publish_failed', publish_attempted: true, error_message: safeLogMessage(message),
                ...verification, batch_id: published && published.batch_id || '',
                error_code: safeLogMessage(published && published.error_detail && published.error_detail.code),
                error_stage: safeLogMessage(published && published.error_detail && published.error_detail.stage),
                next_retry_at: retryAtText(now), retry_count: runtime.retry_count + 1
            });
        }
    }
    return summary;
}

async function reconcilePriceLadderAfterOrderSync(userId, candidates = [], options = {}) {
    return observePriceLadderReconciliation(userId, options, async (effectiveOptions, observe) => {
        const channelBootstrap = await enqueueMissingPriceLadderChannelRuntimes(userId, effectiveOptions);
        const activation = options.activation_reconcile
            ? await enqueueFeatureActivationReconcile(userId, effectiveOptions)
            : { scanned: 0, queued: 0, initialized: 0 };
        // Candidates are retained at the order boundary for compatibility, not as a gate.
        void candidates;
        const reconciliation = await executePriceLadderReconciliation(userId, effectiveOptions, observe);
        let activationMarked = false;
        if (options.activation_reconcile && Number(options.feature_version || 0) > 0) {
            activationMarked = await markPriceLadderFeatureReconciled(userId, options.feature_version);
        }
        return { channel_bootstrap: channelBootstrap, count_mode: 'rolling_24h', activation, activation_marked: activationMarked, reconciliation };
    });
}

module.exports = {
    buildPriceLadderCandidatesFromOrderWrite,
    mergePriceLadderCandidates,
    initializePriceLadderRuntimeOnRuleSave,
    enqueueFeatureActivationReconcile,
    enqueueMissingPriceLadderChannelRuntimes,
    enqueueChannelPackageRatioChange,
    getPriceLadderApplyBlock,
    reconcilePendingPriceLaddersByUser,
    reconcilePriceLadderAfterOrderSync,
    _internal: {
        tierByCompletedCount,
        businessDateForOrder,
        accountCandidate,
        priceSignature,
        retryAtText,
        isRetryDue,
        listAllAccountsByUser,
        dailyCalculationLog,
        publishVerificationLog,
        CHANNEL
    }
};
