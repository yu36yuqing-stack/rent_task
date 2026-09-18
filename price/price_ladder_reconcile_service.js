'use strict';

const {
    listBusinessDayFinishedOrderCountByAccounts,
    listRentingOrderWindowByAccounts,
    _internal: { businessDateText, isFinishedPriceLadderStatus }
} = require('../database/order_db');
const {
    getAccountPriceLadderRule,
    listAccountPriceLadderRulesByUser
} = require('../database/account_price_ladder_rule_db');
const {
    getAccountChannelPriceBaseline
} = require('../database/account_channel_price_baseline_db');
const {
    getAccountPriceLadderRuntime,
    listAccountPriceLadderRuntimesByUser,
    upsertAccountPriceLadderRuntime
} = require('../database/account_price_ladder_runtime_db');
const {
    getPriceLadderJobBusinessDate,
    setPriceLadderJobBusinessDate
} = require('../database/price_ladder_job_state_db');
const {
    getPriceLadderFeatureConfig,
    markPriceLadderFeatureReconciled
} = require('../database/price_ladder_feature_config_db');
const { listBlacklistSourcesByUserAndAccounts } = require('../database/user_blacklist_source_db');
const { listUserGameAccounts } = require('../database/user_game_account_db');
const { normalizeOnePlatformStatus, isRestrictedLikeStatus } = require('../product/prod_channel_status');
const { publishUhaozuAccountPriceSetByUser } = require('./price_publish_service');
const { _internal: priceInternal } = require('./price_ladder_service');

const CHANNEL = 'uhaozu';
const DAILY_RESET_JOB_KEY = 'price_ladder_daily_reset';
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
    return JSON.stringify({
        tier: Number(tier || 0),
        hour: Number(Number(prices.hour || 0).toFixed(2)),
        night: Number(Number(prices.night || 0).toFixed(2)),
        day: Number(Number(prices.day || 0).toFixed(2)),
        week: Number(Number(prices.week || 0).toFixed(2)),
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

async function initializePriceLadderRuntimeOnRuleSave(userId, rule, options = {}) {
    const uid = Number(userId || 0);
    if (!uid || !rule) return null;
    const day = businessDateText(6, options.now || new Date());
    const key = { game_id: rule.game_id, game_account: rule.game_account };
    const counts = await listBusinessDayFinishedOrderCountByAccounts(uid, [key], day);
    const count = Number(counts[`${rule.game_id}::${rule.game_account}`] || 0);
    const tier = tierByCompletedCount(count);
    const current = await getAccountPriceLadderRuntime(uid, rule.game_id, rule.game_account, CHANNEL);
    return upsertAccountPriceLadderRuntime(uid, {
        game_id: rule.game_id,
        game_name: rule.game_name,
        game_account: rule.game_account,
        channel: CHANNEL,
        business_date: day,
        completed_order_count: count,
        desired_tier: current ? current.desired_tier : tier,
        applied_tier: current && current.applied_tier ? current.applied_tier : tier,
        pending_count_delta: current ? current.pending_count_delta : 0,
        rule_version: rule.version,
        status: current ? current.status : 'applied',
        trigger_source: current ? current.trigger_source : 'rule_initialized'
    }, { desc: 'initialize ladder runtime without changing channel price' });
}

async function enqueueDailyResetIfDue(userId, options = {}) {
    const uid = Number(userId || 0);
    const day = businessDateText(6, options.now || new Date());
    const lastDay = await getPriceLadderJobBusinessDate(uid, DAILY_RESET_JOB_KEY);
    if (lastDay === day) return { due: false, business_date: day, queued: 0 };
    const rules = await listAccountPriceLadderRulesByUser(uid);
    let queued = 0;
    for (const rule of rules) {
        const runtime = await getAccountPriceLadderRuntime(uid, rule.game_id, rule.game_account, CHANNEL);
        const appliedTier = runtime && runtime.applied_tier ? runtime.applied_tier : 1;
        await upsertAccountPriceLadderRuntime(uid, {
            game_id: rule.game_id,
            game_name: rule.game_name,
            game_account: rule.game_account,
            channel: CHANNEL,
            business_date: day,
            completed_order_count: 0,
            desired_tier: 1,
            applied_tier: appliedTier,
            pending_count_delta: 0,
            rule_version: rule.version,
            status: appliedTier === 1 ? 'applied' : 'pending',
            trigger_source: 'daily_reset',
            last_error: '',
            next_retry_at: ''
        }, { desc: '06:00 business day price ladder reset' });
        if (appliedTier !== 1) queued += 1;
    }
    await setPriceLadderJobBusinessDate(uid, DAILY_RESET_JOB_KEY, day, 'price ladder daily reset enqueued');
    return { due: true, business_date: day, queued };
}

async function enqueuePriceLadderCandidates(userId, candidates = [], options = {}) {
    const uid = Number(userId || 0);
    const day = businessDateText(6, options.now || new Date());
    const merged = mergePriceLadderCandidates(candidates).filter((item) => item.business_date === day);
    let queued = 0;
    for (const candidate of merged) {
        const rule = await getAccountPriceLadderRule(uid, candidate.game_id, candidate.game_account);
        if (!rule) continue;
        const runtime = await getAccountPriceLadderRuntime(uid, candidate.game_id, candidate.game_account, CHANNEL);
        await upsertAccountPriceLadderRuntime(uid, {
            game_id: candidate.game_id,
            game_name: rule.game_name || candidate.game_name,
            game_account: candidate.game_account,
            channel: CHANNEL,
            business_date: day,
            pending_count_delta: Number(runtime && runtime.pending_count_delta || 0) + Number(candidate.delta || 0),
            rule_version: rule.version,
            status: 'pending',
            trigger_source: 'order_finished_changed',
            last_order_no: candidate.order_nos.join(','),
            last_error: '',
            next_retry_at: ''
        }, { desc: 'queued by finished order contribution change' });
        queued += 1;
    }
    return { business_date: day, queued };
}

async function enqueueFeatureActivationReconcile(userId, options = {}) {
    const uid = Number(userId || 0);
    const rules = await listAccountPriceLadderRulesByUser(uid);
    let queued = 0;
    let initialized = 0;
    for (const rule of rules) {
        const runtime = await getAccountPriceLadderRuntime(uid, rule.game_id, rule.game_account, CHANNEL);
        if (!runtime) {
            await initializePriceLadderRuntimeOnRuleSave(uid, rule, options);
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
        }, { desc: 'queued after price ladder feature enabled' });
        queued += 1;
    }
    return { scanned: rules.length, queued, initialized };
}

async function getPriceLadderApplyBlock(userId, accountRow = {}) {
    const uid = Number(userId || 0);
    const key = {
        game_id: String(accountRow.game_id || '').trim(),
        game_name: String(accountRow.game_name || '').trim(),
        game_account: String(accountRow.game_account || '').trim()
    };
    const [blacklistRows, renting] = await Promise.all([
        listBlacklistSourcesByUserAndAccounts(uid, [key], { active_only: true }),
        listRentingOrderWindowByAccounts(uid, [key])
    ]);
    if (blacklistRows.length > 0) {
        return { blocked: true, reason: `blacklist:${String(blacklistRows[0].reason || blacklistRows[0].source || '').trim()}` };
    }
    if (renting[`${key.game_id}::${key.game_account}`]) return { blocked: true, reason: 'active_order' };
    const normalized = normalizeOnePlatformStatus('uhaozu', accountRow.channel_status, accountRow.channel_prd_info);
    if (normalized.code === 'renting' || isRestrictedLikeStatus(normalized.code)) {
        return { blocked: true, reason: `uhaozu_status:${normalized.code}` };
    }
    return { blocked: false, reason: '' };
}

async function reconcilePendingPriceLaddersByUser(userId, options = {}) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    const now = options.now || new Date();
    const day = businessDateText(6, now);
    const allowApply = options.allow_apply !== false;
    const runtimes = (await listAccountPriceLadderRuntimesByUser(uid, {
        statuses: ['pending', 'blocked', 'failed']
    })).filter((row) => row.business_date === day && (row.status !== 'failed' || isRetryDue(row, now)));
    if (runtimes.length === 0) return { scanned: 0, applied: 0, unchanged: 0, blocked: 0, failed: 0, pending: 0, list: [] };

    const accountRows = await listAllAccountsByUser(uid);
    const accountMap = new Map(accountRows.map((row) => [`${String(row.game_id || '').trim()}::${String(row.game_account || '').trim()}`, row]));
    const counts = await listBusinessDayFinishedOrderCountByAccounts(uid, runtimes.map((row) => ({
        game_id: row.game_id,
        game_account: row.game_account
    })), day);
    const publisher = options.publisher || publishUhaozuAccountPriceSetByUser;
    const featureGuard = options.feature_guard || getPriceLadderFeatureConfig;
    const summary = { scanned: runtimes.length, applied: 0, unchanged: 0, blocked: 0, failed: 0, pending: 0, list: [] };

    for (const runtime of runtimes) {
        const key = `${runtime.game_id}::${runtime.game_account}`;
        const rule = await getAccountPriceLadderRule(uid, runtime.game_id, runtime.game_account);
        const accountRow = accountMap.get(key);
        const count = Number(counts[key] || 0);
        const desiredTier = tierByCompletedCount(count);
        const inferredPreviousCount = Math.max(0, count - Number(runtime.pending_count_delta || 0));
        const appliedTier = runtime.applied_tier || tierByCompletedCount(inferredPreviousCount);
        if (!rule || !accountRow) {
            await upsertAccountPriceLadderRuntime(uid, {
                ...runtime,
                completed_order_count: count,
                desired_tier: desiredTier,
                applied_tier: appliedTier,
                pending_count_delta: 0,
                status: 'failed',
                last_error: !rule ? '阶梯规则不存在' : '账号不存在',
                retry_count: runtime.retry_count + 1,
                next_retry_at: retryAtText(now)
            }, { desc: 'price ladder reconcile missing data' });
            summary.failed += 1;
            summary.list.push({ game_account: runtime.game_account, status: 'failed', reason: !rule ? 'rule_missing' : 'account_missing' });
            continue;
        }

        const baseline = await getAccountChannelPriceBaseline(uid, runtime.game_id, runtime.game_account, CHANNEL);
        const tiers = baseline ? priceInternal.buildUhaozuTierPrices(rule.prices, baseline.prices) : [];
        const desired = tiers.find((item) => item.tier === desiredTier) || null;
        const signature = desired ? priceSignature(desiredTier, desired.prices, rule.version, baseline.version) : '';
        if (desiredTier === appliedTier) {
            await upsertAccountPriceLadderRuntime(uid, {
                ...runtime,
                business_date: day,
                completed_order_count: count,
                desired_tier: desiredTier,
                applied_tier: appliedTier,
                pending_count_delta: 0,
                rule_version: rule.version,
                baseline_version: baseline ? baseline.version : runtime.baseline_version,
                desired_price_signature: signature,
                status: 'applied',
                last_error: '',
                retry_count: 0,
                next_retry_at: ''
            }, { desc: 'price ladder unchanged; preserve channel manual price' });
            summary.unchanged += 1;
            summary.list.push({ game_account: runtime.game_account, status: 'unchanged', tier: desiredTier });
            continue;
        }
        if (!allowApply) {
            await upsertAccountPriceLadderRuntime(uid, {
                ...runtime,
                completed_order_count: count,
                desired_tier: desiredTier,
                applied_tier: appliedTier,
                desired_price_signature: signature,
                status: 'pending',
                last_error: '授权渠道订单同步不完整'
            }, { desc: 'price ladder waits for complete order sync' });
            summary.pending += 1;
            summary.list.push({ game_account: runtime.game_account, status: 'pending', reason: 'order_sync_incomplete' });
            continue;
        }
        if (!baseline || !desired || Object.values(desired.prices).some((value) => Number(value || 0) <= 0)) {
            await upsertAccountPriceLadderRuntime(uid, {
                ...runtime,
                completed_order_count: count,
                desired_tier: desiredTier,
                applied_tier: appliedTier,
                pending_count_delta: 0,
                status: 'failed',
                last_error: 'U号租套餐价格基准不完整',
                retry_count: runtime.retry_count + 1,
                next_retry_at: retryAtText(now)
            }, { desc: 'price ladder baseline unavailable' });
            summary.failed += 1;
            summary.list.push({ game_account: runtime.game_account, status: 'failed', reason: 'baseline_unavailable' });
            continue;
        }
        const block = await getPriceLadderApplyBlock(uid, accountRow);
        if (block.blocked) {
            await upsertAccountPriceLadderRuntime(uid, {
                ...runtime,
                completed_order_count: count,
                desired_tier: desiredTier,
                applied_tier: appliedTier,
                pending_count_delta: 0,
                rule_version: rule.version,
                baseline_version: baseline.version,
                desired_price_signature: signature,
                status: 'blocked',
                last_error: block.reason,
                next_retry_at: ''
            }, { desc: 'price ladder blocked by shelf safety gate' });
            summary.blocked += 1;
            summary.list.push({ game_account: runtime.game_account, status: 'blocked', reason: block.reason });
            continue;
        }

        const latestFeature = await featureGuard(uid);
        if (!latestFeature || latestFeature.enabled !== true) {
            summary.pending += 1;
            summary.list.push({ game_account: runtime.game_account, status: 'pending', reason: 'feature_disabled' });
            continue;
        }
        const latestRule = await getAccountPriceLadderRule(uid, runtime.game_id, runtime.game_account);
        if (!latestRule || Number(latestRule.version || 0) !== Number(rule.version || 0)) {
            summary.pending += 1;
            summary.list.push({
                game_account: runtime.game_account,
                status: 'pending',
                reason: latestRule ? 'rule_changed' : 'rule_cleared'
            });
            continue;
        }

        let published;
        try {
            published = await publisher(uid, {
                game_id: runtime.game_id,
                game_name: rule.game_name,
                game_account: runtime.game_account,
                goods_id: baseline.goods_id,
                tier: desiredTier,
                prices: desired.prices,
                trigger_source: runtime.trigger_source || 'price_ladder'
            });
        } catch (error) {
            published = { ok: false, message: String(error && error.message ? error.message : error) };
        }
        if (published && published.ok) {
            await upsertAccountPriceLadderRuntime(uid, {
                ...runtime,
                business_date: day,
                completed_order_count: count,
                desired_tier: desiredTier,
                applied_tier: desiredTier,
                pending_count_delta: 0,
                rule_version: rule.version,
                baseline_version: baseline.version,
                desired_price_signature: signature,
                applied_price_signature: signature,
                status: 'applied',
                last_error: '',
                retry_count: 0,
                next_retry_at: '',
                last_apply_date: new Date(now).toISOString()
            }, { desc: 'price ladder applied to uhaozu' });
            summary.applied += 1;
            summary.list.push({ game_account: runtime.game_account, status: 'applied', tier: desiredTier, batch_id: published.batch_id || '' });
        } else {
            const message = String(published && published.message || '价格发布失败');
            await upsertAccountPriceLadderRuntime(uid, {
                ...runtime,
                completed_order_count: count,
                desired_tier: desiredTier,
                applied_tier: appliedTier,
                pending_count_delta: 0,
                rule_version: rule.version,
                baseline_version: baseline.version,
                desired_price_signature: signature,
                status: 'failed',
                last_error: message,
                retry_count: runtime.retry_count + 1,
                next_retry_at: retryAtText(now)
            }, { desc: 'price ladder publish failed' });
            summary.failed += 1;
            summary.list.push({ game_account: runtime.game_account, status: 'failed', reason: message });
        }
    }
    return summary;
}

async function reconcilePriceLadderAfterOrderSync(userId, candidates = [], options = {}) {
    const reset = await enqueueDailyResetIfDue(userId, options);
    const activation = options.activation_reconcile
        ? await enqueueFeatureActivationReconcile(userId, options)
        : { scanned: 0, queued: 0, initialized: 0 };
    const queued = await enqueuePriceLadderCandidates(userId, candidates, options);
    const reconciliation = await reconcilePendingPriceLaddersByUser(userId, options);
    let activationMarked = false;
    if (options.activation_reconcile && Number(options.feature_version || 0) > 0) {
        activationMarked = await markPriceLadderFeatureReconciled(userId, options.feature_version);
    }
    return { reset, activation, activation_marked: activationMarked, queued, reconciliation };
}

module.exports = {
    buildPriceLadderCandidatesFromOrderWrite,
    mergePriceLadderCandidates,
    initializePriceLadderRuntimeOnRuleSave,
    enqueueDailyResetIfDue,
    enqueuePriceLadderCandidates,
    enqueueFeatureActivationReconcile,
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
        CHANNEL,
        DAILY_RESET_JOB_KEY
    }
};
