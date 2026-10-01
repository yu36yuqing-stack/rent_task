#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-price-rolling-'));
for (const name of ['MAIN', 'ORDER', 'PRICE', 'RUNTIME']) {
    process.env[name + '_DB_FILE_PATH'] = path.join(tempDir, name + '.db');
}
process.env.ORDER_COUNT_TRACE = 'false';

const { upsertUserGameAccount } = require('../database/user_game_account_db');
const { upsertOrder, listRolling24hPaidOrderCountByAccounts } = require('../database/order_db');
const { listPaidCountByAccounts } = require('../order/service/order_query_service');
const { setPriceLadderFeatureEnabled, getPriceLadderFeatureConfig } = require('../database/price_ladder_feature_config_db');
const { getAccountPriceLadderRuntime, upsertAccountPriceLadderRuntime } = require('../database/account_price_ladder_runtime_db');
const { upsertAccountPriceLadderRule, getAccountPriceLadderRule } = require('../database/account_price_ladder_rule_db');
const { openDatabase, openOrderDatabase } = require('../database/sqlite_client');
const { initUserPlatformAuthDb } = require('../database/user_platform_auth_db');
const { getPriceChannelAdapter } = require('../price/channel_adapters/channel_price_registry');
const { savePriceLadderRuleByUser, getPriceLadderDashboardByUser, getPriceLadderChannelResultByUser } = require('../price/price_ladder_service');
const {
    reconcilePriceLadderAfterOrderSync, reconcilePendingPriceLaddersByUser,
    initializePriceLadderRuntimeOnRuleSave, enqueueFeatureActivationReconcile,
    enqueueChannelPackageRatioChange, getPriceLadderApplyBlock,
    buildPriceLadderCandidatesFromOrderWrite, mergePriceLadderCandidates, _internal
} = require('../price/price_ladder_reconcile_service');

const UID = 8;
const GAME = '2';
const ACCOUNT = 'rolling-account';
const clock = (day, time) => new Date('2026-09-' + day + 'T' + time);
const key = (account = ACCOUNT) => ({ game_id: GAME, game_account: account });
const calls = [];
const logs = [];
function captureLog(level, line) {
    const match = String(line).match(/^\[PriceLadder\]\[([^\]]+)\] (.*)$/);
    assert(match, 'structured PriceLadder log expected');
    logs.push({ level, event: match[1], ...JSON.parse(match[2]) });
}
const logger = { log: line => captureLog('log', line), warn: line => captureLog('warn', line) };
const lastSummary = () => logs.filter(row => row.event === 'summary').at(-1);
let mode = 'success';
const publisher = async (_uid, input) => {
    calls.push(input);
    if (mode === 'throw') throw new Error('network timeout');
    if (mode === 'fail') return { ok: false, message: 'range error' };
    return { ok: true, changed: mode !== 'unchanged', batch_id: 'batch-' + calls.length };
};
const runtime = (account = ACCOUNT, channel = 'uhaozu') => getAccountPriceLadderRuntime(UID, GAME, account, channel);
const reconcile = (now, extra = {}) => reconcilePriceLadderAfterOrderSync(UID, [], { now, publisher, logger, ...extra });
async function account(name = ACCOUNT, channels = ['uhaozu']) {
    const info = {
        uhaozu: { prd_id: 'u-' + name, rentalByHour: 2, rentalByNight: 8, rentalByDay: 12, rentalByWeek: 70 },
        uuzuhao: { prd_id: 'y-' + name, hourPrice: 2, minRentHour: 2 },
        zuhaowang: { prd_id: 'z-' + name, rent_mode: 'hour_only', hourPrice: 2 }
    };
    return upsertUserGameAccount({
        user_id: UID, ...key(name), game_name: '和平精英',
        channel_prd_info: Object.fromEntries(channels.map(c => [c, info[c]]))
    });
}
async function order(no, start, status = '租赁中', amount = 0, extra = {}) {
    return upsertOrder({
        user_id: UID, ...key(), game_name: '和平精英', channel: 'uhaozu',
        order_no: no, start_time: start, end_time: start, order_status: status,
        rec_amount: amount, order_amount: 10, ...extra
    });
}
async function sql(db, text, params = []) {
    try { await new Promise((resolve, reject) => db.run(text, params, err => err ? reject(err) : resolve())); }
    finally { await new Promise(resolve => db.close(resolve)); }
}
async function save(name = ACCOUNT, now = clock('29', '06:00:00'), extra = {}) {
    return savePriceLadderRuleByUser(UID, {
        ...key(name), game_name: '和平精英', prices: [2, 3, 4, 5], expected_version: 0
    }, { now, publisher, logger, ...extra });
}
async function main() {
    await setPriceLadderFeatureEnabled(UID, true, { expected_version: 0 });
    await account();
    const saved = await save();
    assert.strictEqual(saved.publish_result.applied, 1);
    assert.strictEqual((await runtime()).applied_tier, 1);
    calls.length = 0;
    const initialLogStart = logs.length;
    const initial = await reconcile(clock('29', '06:05:00'));
    assert.strictEqual(initial.reconciliation.unchanged, 1);
    assert.strictEqual(calls.length, 0, 'saving trigger must not republish every round');
    assert.deepStrictEqual(logs.slice(initialLogStart).map(row => row.event), ['start', 'summary'], 'same-tier normal decisions do not spam per-account logs');
    assert.strictEqual(lastSummary().unchanged, 1);
    assert.strictEqual(lastSummary().attempted, 0);
    const brokenLogger = { log() { throw new Error('log sink unavailable'); }, warn() { throw new Error('log sink unavailable'); } };
    assert.strictEqual((await reconcile(clock('29', '06:05:00'), { logger: brokenLogger })).reconciliation.unchanged, 1);

    // Eligibility and window boundaries share the notification query, including account/game/user isolation.
    await order('active', '2026-09-29 06:30:00');
    await order('settling', '2026-09-29 07:30:00', '结算中');
    await order('paid', '2026-09-29 08:30:00', '部分完成', 8, { channel: 'uuzuhao' });
    await order('cancelled', '2026-09-29 08:00:00', '已取消');
    await order('unpaid-finished', '2026-09-29 08:00:00', '已完成');
    await order('expired', '2026-09-28 08:59:59');
    await order('upper-exclusive', '2026-09-29 09:00:00', '出租中');
    await order('future', '2026-09-30 10:00:00');
    await order('other-user', '2026-09-29 08:00:00', '已完成', 8, { user_id: 9 });
    await order('other-game', '2026-09-29 08:00:00', '已完成', 8, { game_id: '1' });
    await order('other-account', '2026-09-29 08:00:00', '已完成', 8, { game_account: 'other' });
    await order('deleted', '2026-09-29 08:00:00', '已完成', 8);
    await sql(openOrderDatabase(), 'UPDATE "order" SET is_deleted=1 WHERE order_no=?', ['deleted']);
    const now = clock('29', '09:00:00');
    const counts = await listPaidCountByAccounts(UID, [key()], { mode: 'rolling_24h', now });
    assert.strictEqual(counts[GAME + '::' + ACCOUNT], 3);
    assert.deepStrictEqual(counts, await listRolling24hPaidOrderCountByAccounts(UID, [key()], { now }));
    await assert.rejects(() => listPaidCountByAccounts(UID, [key()], { mode: 'rolling_24h', now: 'bad' }), /now/);
    assert.deepStrictEqual(await listRolling24hPaidOrderCountByAccounts(UID, [], { now }), {});
    await assert.rejects(() => reconcilePendingPriceLaddersByUser(0), /user_id/);

    const rise = await reconcile(now);
    assert.strictEqual(rise.reconciliation.applied, 1);
    assert.strictEqual(calls.at(-1).tier, 4);
    assert.strictEqual(calls.at(-1).trigger_source, 'rolling_24h_reconcile');
    const riseSummary = lastSummary();
    const riseLogs = logs.filter(row => row.trace_id === riseSummary.trace_id);
    assert.deepStrictEqual(riseLogs.map(row => row.event), ['start', 'apply_start', 'result', 'summary']);
    assert.strictEqual(riseLogs[1].count_24h, 3);
    assert.strictEqual(riseLogs[1].from_tier, 1);
    assert.strictEqual(riseLogs[1].to_tier, 4);
    assert.strictEqual(riseLogs[2].confirmed_tier, 4);
    assert.strictEqual(riseLogs[2].batch_id, calls.at(-1) ? 'batch-' + calls.length : '');
    assert.strictEqual(riseSummary.scanned_accounts, 1);
    assert.strictEqual(riseSummary.scanned_channels, 1);
    assert.strictEqual(riseSummary.applied, 1);
    assert.strictEqual(riseSummary.failed, 0);
    assert(riseSummary.duration_ms >= 0);
    assert.strictEqual(new Date(riseSummary.window_end).getTime() - new Date(riseSummary.window_start).getTime(), 24 * 3600 * 1000);
    const cappedCalls = calls.length;
    await reconcile(clock('29', '09:05:00'));
    assert.strictEqual((await runtime()).completed_order_count, 4);
    assert.strictEqual(calls.length, cappedCalls);

    const beforeQueryFailure = await runtime();
    const beforeQueryFailureCalls = calls.length;
    await upsertUserGameAccount({ user_id: 21, ...key('bootstrap-failure'), game_name: '和平精英', channel_prd_info: { uhaozu: { prd_id: 'bootstrap-goods' } } });
    await upsertAccountPriceLadderRule(21, { ...key('bootstrap-failure'), game_name: '和平精英', prices: [2,3,4,5] }, { expected_version: 0 });
    await sql(openOrderDatabase(), 'ALTER TABLE "order" RENAME TO unavailable_order');
    try {
        await assert.rejects(() => reconcilePendingPriceLaddersByUser(UID, { now, publisher, logger, trace_id: 'query-failure' }), /no such table/);
        assert.strictEqual(calls.length, beforeQueryFailureCalls);
        assert.deepStrictEqual(await runtime(), beforeQueryFailure, 'failed count query preserves the confirmed snapshot');
        assert.strictEqual(lastSummary().trace_id, 'query-failure');
        assert.strictEqual(lastSummary().status, 'error');
        assert.strictEqual(lastSummary().error_code, 'RECONCILE_ERROR');
        assert.strictEqual(lastSummary().scanned_channels, null, 'failed scan must not be reported as an empty successful scan');
        await assert.rejects(() => reconcilePriceLadderAfterOrderSync(21, [], { now, publisher, logger, trace_id: 'bootstrap-failure' }), /no such table/);
        assert.strictEqual(lastSummary().trace_id, 'bootstrap-failure');
        assert.strictEqual(lastSummary().status, 'error');
        assert.strictEqual(lastSummary().attempted, 0);
        assert.strictEqual(calls.length, beforeQueryFailureCalls);
    } finally {
        await sql(openOrderDatabase(), 'ALTER TABLE unavailable_order RENAME TO "order"');
    }

    // An applied record from an old day and no order delta still converges every round.
    await upsertAccountPriceLadderRuntime(UID, { ...(await runtime()), business_date: '2026-01-01', applied_tier: 1 });
    assert.strictEqual((await reconcile(now)).reconciliation.applied, 1);
    assert.strictEqual((await runtime()).applied_tier, 4);
    await upsertAccountPriceLadderRuntime(UID, { ...(await runtime()), rule_version: 0 });
    assert.strictEqual((await reconcile(now)).reconciliation.applied, 1, 'same tier but changed rule version is reapplied');
    assert.strictEqual((await reconcile(clock('30', '06:01:00'))).reconciliation.unchanged, 1);
    assert.strictEqual((await runtime()).applied_tier, 4, '06:00 is not a reset');

    const boundary = await listPaidCountByAccounts(UID, [key()], { mode: 'rolling_24h', now: clock('30', '06:30:00') });
    assert.strictEqual(boundary[GAME + '::' + ACCOUNT], 4, 'lower bound is inclusive');
    await reconcile(clock('30', '07:30:01'));
    assert.strictEqual((await runtime()).applied_tier, 3);
    await reconcile(clock('30', '08:30:01'));
    assert.strictEqual((await runtime()).applied_tier, 2);
    await reconcile(clock('30', '09:00:01'));
    assert.strictEqual((await runtime()).applied_tier, 1, 'expiration downshifts without a new order');

    await order('new', '2026-09-30 09:10:00');
    const beforeIncomplete = await runtime();
    const incompleteCalls = calls.length;
    await reconcile(clock('30', '09:11:00'), { allow_apply: false });
    assert.strictEqual(lastSummary().pending, 1);
    assert.strictEqual(logs.at(-2).reason, 'order_sync_incomplete');
    assert.strictEqual(logs.at(-2).count_24h, null);
    assert.strictEqual(logs.at(-2).count_snapshot_valid, false);
    assert.strictEqual(calls.length, incompleteCalls);
    assert.strictEqual((await runtime()).applied_tier, beforeIncomplete.applied_tier);
    assert.strictEqual((await runtime()).desired_tier, beforeIncomplete.desired_tier);
    mode = 'fail';
    assert.strictEqual((await reconcile(clock('30', '09:12:00'))).reconciliation.failed, 1);
    assert.strictEqual(lastSummary().status, 'partial_failed');
    assert.strictEqual(logs.at(-2).level, 'warn');
    assert.strictEqual(logs.at(-2).error_message, 'range error');
    assert.strictEqual(logs.at(-2).next_retry_at, '2026-09-30 09:42:00');
    assert.strictEqual((await runtime()).applied_tier, 1);
    await reconcile(clock('30', '09:12:30'), { allow_apply: false });
    assert.strictEqual((await runtime()).status, 'failed');
    assert.strictEqual((await runtime()).last_error, 'range error', 'incomplete sync retains the channel failure evidence');
    await order('new2', '2026-09-30 09:13:00', '已完成', 8);
    const retryCalls = calls.length;
    const waiting = await reconcile(clock('30', '09:14:00'));
    assert.strictEqual(waiting.reconciliation.list[0].reason, 'retry_not_due');
    assert.strictEqual(lastSummary().retry_waiting, 1);
    assert.strictEqual(lastSummary().attempted, 0);
    assert.strictEqual(logs.at(-2).to_tier, 3);
    assert.strictEqual(logs.at(-2).error_message, 'range error');
    assert.strictEqual((await runtime()).desired_tier, 3);
    assert.strictEqual((await runtime()).last_error, 'range error');
    assert.strictEqual((await runtime()).next_retry_at, '2026-09-30 09:42:00');
    assert.strictEqual(calls.length, retryCalls);
    mode = 'throw';
    assert.strictEqual((await reconcile(clock('30', '09:42:00'))).reconciliation.failed, 1);
    assert.strictEqual((await runtime()).last_error, 'network timeout');
    mode = 'unchanged';
    assert.strictEqual((await reconcile(clock('30', '10:12:00'))).reconciliation.unchanged, 1);
    assert.strictEqual(logs.at(-2).publish_attempted, true, 'publisher-confirmed no-op is observable even when no write is needed');
    assert.strictEqual(lastSummary().attempted, 1);
    assert.strictEqual((await runtime()).applied_tier, 4); // future row now entered the window
    assert.strictEqual((await runtime()).retry_count, 0);
    mode = 'success';

    const dashboard = await getPriceLadderDashboardByUser(UID, { game_id: GAME, now: clock('30', '09:14:00') });
    assert.strictEqual(dashboard.count_window, '近24小时');
    assert.strictEqual(dashboard.list[0].today_order_count, 2);
    assert.strictEqual(dashboard.list[0].desired_tier, 3);
    assert.strictEqual(dashboard.list[0].current_tier, 4);
    const view = await getPriceLadderChannelResultByUser(UID, { ...key(), now: clock('30', '09:14:00') });
    assert.strictEqual(view.desired_tier, 3);
    assert.strictEqual(view.channel_result.current_tier, 4);
    assert.strictEqual(view.channel_result.apply_status, 'manual');

    // Three independent channels; resolver failure and publish failure cannot stop another channel.
    const multi = 'three-channels';
    await account(multi, ['uhaozu', 'zuhaowang', 'uuzuhao']);
    const savedMulti = await save(multi, clock('30', '10:15:00'));
    assert.strictEqual(savedMulti.publish_result.applied, 3);
    await order('multi-paid', '2026-09-30 10:16:00', '已完成', 8, { game_account: multi });
    const zhw = getPriceChannelAdapter('zuhaowang');
    const originalResolver = zhw.resolveTierPrices;
    zhw.resolveTierPrices = async () => { throw new Error('resolver failed'); };
    const split = await reconcile(clock('30', '10:17:00'), {
        trace_id: 'multi-split',
        accounts: [key(multi)],
        publishers: { uuzuhao: async () => ({ ok: false, message: 'y failed' }) }
    });
    zhw.resolveTierPrices = originalResolver;
    assert.strictEqual(split.reconciliation.applied, 1);
    assert.strictEqual(split.reconciliation.failed, 2);
    assert.strictEqual(lastSummary().trace_id, 'multi-split');
    assert.strictEqual(lastSummary().attempted, 2);
    assert.strictEqual(lastSummary().failed, 2);
    assert.strictEqual(lastSummary().scanned_accounts, 1);
    assert.strictEqual(lastSummary().scanned_channels, 3);
    assert.strictEqual((await runtime(multi)).applied_tier, 2);
    assert.strictEqual((await runtime(multi, 'zuhaowang')).applied_tier, 1);
    assert.strictEqual((await runtime(multi, 'uuzuhao')).applied_tier, 1);
    await order('multi-paid2', '2026-09-30 10:18:00', '已完成', 8, { game_account: multi });
    await reconcile(clock('30', '10:19:00'), { accounts: [key(multi)] });
    assert.strictEqual((await runtime(multi, 'zuhaowang')).desired_tier, 3);
    const beforeRetry = calls.length;
    const recovered = await reconcile(clock('30', '10:47:00'), { accounts: [key(multi)] });
    assert.strictEqual(recovered.reconciliation.applied, 2);
    assert.strictEqual(calls.length - beforeRetry, 2, 'successful channel is not retried');
    assert(calls.slice(-2).every(c => c.tier === 3));

    // Explicitly disabled channel never invokes its publisher or emits a failure.
    await initUserPlatformAuthDb();
    await sql(openDatabase(), "INSERT INTO user_platform_auth (user_id,platform,auth_type,auth_payload,channel_enabled) VALUES (?,?,'test','{}',0)", [UID, 'zuhaowang']);
    await upsertAccountPriceLadderRuntime(UID, { ...(await runtime(multi, 'zuhaowang')), applied_tier: 1 });
    const skipped = await reconcile(clock('30', '10:48:00'), { accounts: [key(multi)] });
    assert(skipped.reconciliation.list.some(c => c.reason === 'channel_unavailable'));
    assert.strictEqual(skipped.reconciliation.failed, 0);
    assert.strictEqual(lastSummary().skipped, 1);
    assert.strictEqual(logs.at(-2).reason, 'channel_unavailable');
    await sql(openDatabase(), 'DELETE FROM user_platform_auth WHERE user_id=?', [UID]);

    // Preserve feature/clear guards and explicit ratio-change reapplication.
    const rule = await getAccountPriceLadderRule(UID, GAME, ACCOUNT);
    await upsertAccountPriceLadderRuntime(UID, { ...(await runtime()), applied_tier: 1, next_retry_at: '' });
    const guard = await reconcilePendingPriceLaddersByUser(UID, { now: clock('30', '11:00:00'), publisher, accounts: [key()], feature_guard: async () => ({ enabled: false }) });
    assert.strictEqual(guard.list[0].reason, 'feature_disabled');
    const cleared = await reconcilePendingPriceLaddersByUser(UID, {
        now: clock('30', '11:00:00'), publisher, accounts: [key()],
        feature_guard: async () => {
            await savePriceLadderRuleByUser(UID, { ...key(), action: 'clear', expected_version: rule.version });
            return { enabled: true };
        }
    });
    assert.strictEqual(cleared.list[0].reason, 'rule_cleared');
    const queued = await enqueueChannelPackageRatioChange(UID, 'uhaozu', { now: clock('30', '11:00:00') });
    assert.strictEqual(queued.queued, 1);
    assert.strictEqual((await reconcile(clock('30', '11:00:00'), { accounts: [key(multi)] })).reconciliation.applied, 2);
    assert.strictEqual((await runtime(multi, 'zuhaowang')).applied_tier, 3, 're-enabled channel converges normally');
    const activation = await enqueueFeatureActivationReconcile(UID, { now: clock('30', '11:01:00') });
    assert.strictEqual(activation.queued, 3);
    const feature = await getPriceLadderFeatureConfig(UID);
    assert.strictEqual((await reconcile(clock('30', '11:01:00'), { activation_reconcile: true, feature_version: feature.version })).activation_marked, true);
    await assert.rejects(() => enqueueChannelPackageRatioChange(0, 'uhaozu'), /user_id/);
    await assert.rejects(() => enqueueChannelPackageRatioChange(UID, 'bad'), /不支持/);
    assert.strictEqual(await initializePriceLadderRuntimeOnRuleSave(0, null), null);
    assert.strictEqual(await initializePriceLadderRuntimeOnRuleSave(UID, { ...key('missing'), version: 1 }, { now }), null);
    assert.strictEqual((await getPriceLadderApplyBlock(UID, {})).blocked, false);
    assert.strictEqual((await reconcilePendingPriceLaddersByUser(99)).scanned, 0);

    await upsertAccountPriceLadderRuntime(UID, { ...key('missing'), game_name: '和平精英', channel: 'uhaozu', status: 'pending' });
    const missing = await reconcilePendingPriceLaddersByUser(UID, { now: clock('30', '12:00:00'), publisher, accounts: [key('missing')] });
    assert.strictEqual(missing.list[0].reason, 'rule_missing');
    await upsertAccountPriceLadderRule(UID, { ...key('missing'), game_name: '和平精英', prices: [2,3,4,5] }, { expected_version: 0 });
    assert.strictEqual((await reconcilePendingPriceLaddersByUser(UID, { now: clock('30', '12:31:00'), publisher, accounts: [key('missing')] })).list[0].reason, 'account_missing');
    const adapter = getPriceChannelAdapter('uhaozu');
    const resolve = adapter.resolveTierPrices;
    adapter.resolveTierPrices = async () => ({ ready: true, baseline_version: 0, tiers: [{ tier: 3, prices: { hour: 0 } }] });
    await upsertAccountPriceLadderRuntime(UID, { ...(await runtime(multi)), applied_tier: 1, next_retry_at: '' });
    assert.strictEqual((await reconcilePendingPriceLaddersByUser(UID, { now: clock('30', '12:32:00'), publisher, accounts: [key(multi)] })).failed, 1);
    adapter.resolveTierPrices = resolve;

    // Log failure and credential redaction cannot change error storage or the business retry schedule.
    await upsertAccountPriceLadderRuntime(UID, { ...(await runtime(multi)), applied_tier: 1, next_retry_at: '' });
    const secretError = 'token=secret app_secret=hidden authorization=Bearer private';
    const redacted = await reconcile(clock('30', '13:03:00'), {
        accounts: [key(multi)], logger: { log: line => captureLog('log', line) },
        publisher: async () => ({ ok: false, message: secretError })
    });
    assert.strictEqual(redacted.reconciliation.failed, 1);
    assert.strictEqual((await runtime(multi)).last_error, secretError);
    assert(!logs.at(-2).error_message.includes('secret '));
    assert(!logs.at(-2).error_message.includes('hidden'));
    assert(!logs.at(-2).error_message.includes('private'));
    assert(logs.at(-2).error_message.includes('[REDACTED]'));
    assert.strictEqual((await reconcilePendingPriceLaddersByUser(99, { logger, trigger_task_id: 'task-empty' })).scanned, 0);
    assert.strictEqual(lastSummary().trace_id, 'task-empty');
    assert.strictEqual(lastSummary().scanned_channels, 0);
    assert.strictEqual(lastSummary().status, 'ok');
    await assert.rejects(() => reconcilePendingPriceLaddersByUser(UID, { now: 'bad', logger }), /now/);
    assert.strictEqual(lastSummary().status, 'error');
    assert.strictEqual(lastSummary().window_start, '');

    // Candidate metadata remains compatible, but no longer controls convergence.
    assert.deepStrictEqual(buildPriceLadderCandidatesFromOrderWrite({}, {}), []);
    const candidateOrder = { ...key(), start_time: '2026-09-29 08:00:00', order_status: '已完成', order_no: 'c' };
    assert.strictEqual(buildPriceLadderCandidatesFromOrderWrite(candidateOrder, { price_ladder_relevant_changed: true }).length, 1);
    assert.deepStrictEqual(buildPriceLadderCandidatesFromOrderWrite(candidateOrder, { price_ladder_relevant_changed: true, previous_order: candidateOrder }), []);
    assert.deepStrictEqual(mergePriceLadderCandidates(null), []);
    assert.deepStrictEqual(mergePriceLadderCandidates([{}]), []);
    assert.strictEqual(_internal.businessDateForOrder({}), '');
    assert.strictEqual(_internal.businessDateForOrder({ start_time: 'invalid' }), '');
    assert.strictEqual(_internal.accountCandidate({ order_status: '已完成' }, 1, 'x'), null);
    assert.strictEqual(_internal.tierByCompletedCount(-1), 1);
    assert.strictEqual(_internal.tierByCompletedCount(99), 4);
    assert.strictEqual(_internal.isRetryDue({ next_retry_at: 'invalid' }, now), true);
    assert.strictEqual(_internal.isRetryDue({}, now), true);
    assert(_internal.priceSignature(1, { hour: 2 }).includes('"tier":1'));
    console.log('[OK] price_ladder_reconcile_smoke_test rolling-window scenarios passed');
}
main().catch(error => { console.error('[FAIL] rolling reconcile:', error); process.exit(1); });
