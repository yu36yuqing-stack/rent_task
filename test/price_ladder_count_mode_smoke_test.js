#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-price-count-mode-flow-'));
for (const kind of ['MAIN', 'ORDER', 'PRICE', 'RUNTIME', 'STATS']) {
    process.env[`${kind}_DB_FILE_PATH`] = path.join(tempDir, `${kind}.db`);
}
process.env.TZ = 'Asia/Shanghai';
process.env.ORDER_COUNT_TRACE = 'false';

const { upsertUserGameAccount } = require('../database/user_game_account_db');
const { upsertOrder } = require('../database/order_db');
const { openOrderDatabase } = require('../database/sqlite_client');
const { getPriceLadderFeatureConfig, setPriceLadderFeatureEnabled } = require('../database/price_ladder_feature_config_db');
const { getAccountPriceLadderRuntime } = require('../database/account_price_ladder_runtime_db');
const { getPriceLadderCountContext, listPriceLadderOrderCounts } = require('../price/price_ladder_count_service');
const { normalizePriceLadderCountMode, resolvePriceLadderCountWindow } = require('../common/price_ladder_count_mode');
const {
    getPriceLadderDashboardByUser, getPriceLadderChannelResultByUser, savePriceLadderRuleByUser
} = require('../price/price_ladder_service');
const {
    reconcilePriceLadderAfterOrderSync, reconcilePendingPriceLaddersByUser
} = require('../price/price_ladder_reconcile_service');

const GAME = '2';
const CHANNELS = ['uhaozu', 'uuzuhao', 'zuhaowang'];
const calls = [];
const logs = [];
const at = value => new Date(`${value.replace(' ', 'T')}+08:00`);
const accountName = uid => `count-mode-${uid}`;
const key = uid => ({ game_id: GAME, game_account: accountName(uid) });
const logger = {
    log(line) { recordLog(line); },
    warn(line) { recordLog(line); }
};
function recordLog(line) {
    const match = String(line).match(/^\[PriceLadder\]\[([^\]]+)\] (.*)$/);
    assert(match, 'reconciliation emits structured logs');
    logs.push({ event: match[1], ...JSON.parse(match[2]) });
}
const publisher = async (uid, input) => {
    calls.push({ uid, ...input });
    return { ok: true, changed: true, batch_id: `count-mode-${calls.length}` };
};
async function configure(uid, countMode) {
    const current = await getPriceLadderFeatureConfig(uid);
    return setPriceLadderFeatureEnabled(uid, true, {
        count_mode: countMode, expected_version: current.version
    });
}
async function createAccount(uid, channels = CHANNELS) {
    const name = accountName(uid);
    const info = {
        uhaozu: { prd_id: `u-${name}`, rentalByHour: 2, rentalByNight: 8, rentalByDay: 12, rentalByWeek: 70 },
        uuzuhao: { prd_id: `y-${name}`, hourPrice: 2, minRentHour: 2 },
        zuhaowang: { prd_id: `z-${name}`, rent_mode: 'hour_only', hourPrice: 2 }
    };
    await upsertUserGameAccount({
        user_id: uid, ...key(uid), game_name: '和平精英',
        channel_prd_info: Object.fromEntries(channels.map(channel => [channel, info[channel]]))
    });
}
async function order(uid, id, start, extra = {}) {
    await upsertOrder({
        user_id: uid, ...key(uid), game_name: '和平精英', channel: 'uhaozu',
        order_no: `${uid}-${id}`, start_time: start, end_time: start,
        order_status: '租赁中', rec_amount: 0, order_amount: 10, ...extra
    });
}
async function count(uid, now) {
    const result = await listPriceLadderOrderCounts(uid, [key(uid)], { now: at(now) });
    return { ...result, value: Number(result.counts[`${GAME}::${accountName(uid)}`] || 0) };
}
async function save(uid, now, extra = {}) {
    return savePriceLadderRuleByUser(uid, {
        ...key(uid), game_name: '和平精英', prices: [2, 3, 4, 5], expected_version: 0
    }, { now: at(now), publisher, logger, ...extra });
}
async function reconcile(uid, now, extra = {}) {
    return reconcilePriceLadderAfterOrderSync(uid, [], { now: at(now), publisher, logger, ...extra });
}
async function runtimes(uid) {
    return Promise.all(CHANNELS.map(channel => getAccountPriceLadderRuntime(uid, GAME, accountName(uid), channel)));
}
async function assertTier(uid, tier, orderCount) {
    const rows = await runtimes(uid);
    assert.deepStrictEqual(rows.map(row => row.applied_tier), CHANNELS.map(() => tier));
    assert.deepStrictEqual(rows.map(row => row.desired_tier), CHANNELS.map(() => tier));
    if (orderCount !== undefined) {
        assert.deepStrictEqual(rows.map(row => row.completed_order_count), CHANNELS.map(() => orderCount));
    }
}
async function sql(text) {
    const db = openOrderDatabase();
    try {
        await new Promise((resolve, reject) => db.run(text, error => error ? reject(error) : resolve()));
    } finally {
        await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
    }
}
async function assertViews(uid, now, expectedMode, expectedCount) {
    const dashboard = await getPriceLadderDashboardByUser(uid, { game_id: GAME, now: at(now) });
    const detail = await getPriceLadderChannelResultByUser(uid, { ...key(uid), now: at(now) });
    const context = await getPriceLadderCountContext(uid, { now: at(now) });
    assert.strictEqual(dashboard.count_mode, expectedMode);
    assert.strictEqual(dashboard.feature.count_mode, expectedMode);
    assert.strictEqual(detail.count_mode, expectedMode);
    assert.strictEqual(dashboard.count_window, context.count_window);
    assert.strictEqual(detail.count_window, context.count_window);
    assert.strictEqual(dashboard.window_start, context.window_start);
    assert.strictEqual(detail.window_start, context.window_start);
    assert.strictEqual(dashboard.window_end, context.window_end);
    assert.strictEqual(detail.window_end, context.window_end);
    assert.strictEqual(dashboard.list[0].today_order_count, expectedCount);
    assert.strictEqual(detail.current_order_count, expectedCount);
    assert.strictEqual(dashboard.list[0].desired_tier, Math.min(4, expectedCount + 1));
    assert.strictEqual(detail.desired_tier, Math.min(4, expectedCount + 1));
    for (const channel of CHANNELS) {
        assert.strictEqual(detail.channel_results[channel].desired_tier, Math.min(4, expectedCount + 1));
    }
}

async function main() {
    assert.strictEqual(normalizePriceLadderCountMode(), 'rolling_24h');
    assert.strictEqual(normalizePriceLadderCountMode(' business_day '), 'business_day');
    assert.throws(() => normalizePriceLadderCountMode('midnight'), error => error.code === 'PRICE_LADDER_COUNT_MODE_INVALID');
    assert.throws(() => resolvePriceLadderCountWindow('business_day', 'invalid'), /now/);
    const explicitZone = resolvePriceLadderCountWindow('business_day', '2026-10-16T05:59:59+08:00');
    assert.deepStrictEqual(resolvePriceLadderCountWindow('business_day', '2026-10-16 05:59:59'), explicitZone);
    assert.deepStrictEqual(resolvePriceLadderCountWindow('business_day', '2026-10-16T05:59:59'), explicitZone);
    const defaultNow = resolvePriceLadderCountWindow('rolling_24h');
    assert.strictEqual(new Date(defaultNow.window_end).getTime() - new Date(defaultNow.window_start).getTime(), 86400000);
    await assert.rejects(getPriceLadderCountContext(0), /user_id/);

    // The selected mode reaches the shared query: lower bound inclusive, now/future exclusive.
    await configure(101, 'business_day');
    await order(101, 'before-lower', '2026-10-15 05:59:59');
    await order(101, 'lower', '2026-10-15 06:00:00');
    await order(101, 'before-reset', '2026-10-16 05:59:58');
    await order(101, 'at-reset', '2026-10-16 06:00:00');
    await order(101, 'after-reset', '2026-10-16 06:00:01');
    let result = await count(101, '2026-10-16 05:59:59');
    assert.strictEqual(result.value, 2);
    assert.strictEqual(result.window_start, '2026-10-14T22:00:00.000Z');
    assert.strictEqual((await count(101, '2026-10-16 06:00:00')).value, 0);
    assert.strictEqual((await count(101, '2026-10-16 06:00:01')).value, 1);
    assert.strictEqual((await count(101, '2026-10-16 06:00:02')).value, 2);
    await configure(101, 'rolling_24h');
    assert.strictEqual((await count(101, '2026-10-16 06:00:00')).value, 2, 'rolling mode does not reset at 06:00');
    const utcChild = JSON.parse(execFileSync(process.execPath, ['-e', `
        const { listPriceLadderOrderCounts } = require('./price/price_ladder_count_service');
        listPriceLadderOrderCounts(101, [{game_id:'2',game_account:'count-mode-101'}], {
            feature: {count_mode:'business_day'}, now:'2026-10-16 06:00:02'
        }).then(result => process.stdout.write(JSON.stringify(result)))
          .catch(error => { console.error(error); process.exitCode = 1; });
    `], { cwd: path.join(__dirname, '..'), env: { ...process.env, TZ: 'UTC' }, encoding: 'utf8' }));
    assert.strictEqual(utcChild.window_start, '2026-10-15T22:00:00.000Z');
    assert.strictEqual(utcChild.window_end, '2026-10-15T22:00:02.000Z');
    assert.strictEqual(utcChild.counts[`${GAME}::${accountName(101)}`], 2, 'SQL windows remain Beijing-local when the host is UTC');

    // A period beginning in the prior month/year uses the same Beijing boundary.
    await configure(102, 'business_day');
    await order(102, 'last-year-excluded', '2026-12-31 05:59:59');
    await order(102, 'last-year-lower', '2026-12-31 06:00:00');
    await order(102, 'this-year', '2027-01-01 06:00:00');
    result = await count(102, '2027-01-01 05:00:00');
    assert.strictEqual(result.value, 1);
    assert.strictEqual(result.query_start, '2026-12-31 06:00:00');
    assert.strictEqual((await count(102, '2027-01-01 06:00:00')).value, 0);
    assert.strictEqual((await count(102, '2027-01-01 06:00:01')).value, 1);
    const month = await getPriceLadderCountContext(102, { now: at('2026-11-01 01:00:00') });
    assert.strictEqual(month.query_start, '2026-10-31 06:00:00');

    // Rule-save initialization, dashboard, detail and all three publishers share one selected window.
    await configure(110, 'business_day');
    await createAccount(110);
    await order(110, 'previous-evening', '2026-10-15 21:00:00', { channel: 'uuzuhao' });
    await order(110, 'current-paid', '2026-10-16 10:00:00', { order_status: '部分完成', rec_amount: 8 });
    await order(110, 'cancelled', '2026-10-16 07:00:00', { order_status: '已取消' });
    await order(110, 'unpaid-finished', '2026-10-16 08:00:00', { order_status: '已完成' });
    await order(110, 'now-exclusive', '2026-10-16 12:00:00');
    const saved = await save(110, '2026-10-16 12:00:00');
    assert.strictEqual(saved.publish_result.applied, 3);
    assert.deepStrictEqual(calls.slice(-3).map(call => call.tier), [2, 2, 2]);
    await assertTier(110, 2, 1);
    await assertViews(110, '2026-10-16 12:00:00', 'business_day', 1);
    let feature = await getPriceLadderFeatureConfig(110);
    await reconcile(110, '2026-10-16 12:00:00', { activation_reconcile: true, feature_version: feature.version });
    assert.strictEqual((await getPriceLadderFeatureConfig(110)).reconcile_required, false);

    await configure(110, 'rolling_24h');
    result = await reconcile(110, '2026-10-16 12:00:00');
    assert.strictEqual(result.reconciliation.applied, 3);
    assert.strictEqual(result.count_mode, 'rolling_24h');
    await assertTier(110, 3, 2);
    await assertViews(110, '2026-10-16 12:00:00', 'rolling_24h', 2);
    await configure(110, 'business_day');
    result = await reconcile(110, '2026-10-16 12:00:00');
    assert.strictEqual(result.reconciliation.applied, 3);
    assert.strictEqual(result.count_mode, 'business_day');
    await assertTier(110, 2, 1);
    const summary = logs.filter(row => row.event === 'summary').at(-1);
    assert.strictEqual(summary.count_mode, 'business_day');
    assert.strictEqual(summary.window_start, '2026-10-15T22:00:00.000Z');
    assert.strictEqual(summary.window_end, '2026-10-16T04:00:00.000Z');

    // A normal successful sync after 06:00 downshifts without needing an extra reset task.
    await reconcile(110, '2026-10-17 06:00:00');
    await assertTier(110, 1, 0);
    await order(110, 'new-day-lower', '2026-10-17 06:00:00');
    await reconcile(110, '2026-10-17 06:00:01');
    await assertTier(110, 2, 1);

    // Changing only the selected window must preserve normal same-tier deduplication.
    await configure(111, 'business_day');
    await createAccount(111);
    await order(111, 'same-in-both', '2026-10-16 10:00:00', { order_status: '结算中' });
    await save(111, '2026-10-16 12:00:00');
    feature = await getPriceLadderFeatureConfig(111);
    await reconcile(111, '2026-10-16 12:00:00', { activation_reconcile: true, feature_version: feature.version });
    const beforeSameTier = calls.length;
    feature = await configure(111, 'rolling_24h');
    assert.strictEqual(feature.reconcile_reason, 'count_mode_changed');
    result = await reconcile(111, '2026-10-16 12:00:00', {
        activation_reconcile: true, feature_version: feature.version
    });
    assert.strictEqual(result.reconciliation.unchanged, 3);
    assert.strictEqual(calls.length, beforeSameTier);
    assert.strictEqual(result.activation.queued, 0, 'mode switching does not queue forced feature-activation publication');
    assert.strictEqual(result.activation_marked, true);
    assert.strictEqual((await getPriceLadderFeatureConfig(111)).reconcile_required, false);
    await assertTier(111, 2, 1);

    // Incomplete/failed order queries cannot turn a confirmed tier into zero orders.
    await order(110, 'new-day-second', '2026-10-17 06:00:30', { order_status: '出租中' });
    await configure(110, 'rolling_24h');
    feature = await configure(110, 'business_day');
    const beforeIncomplete = await runtimes(110);
    const beforeIncompleteCalls = calls.length;
    result = await reconcile(110, '2026-10-17 06:01:00', {
        allow_apply: false, activation_reconcile: true, feature_version: feature.version
    });
    assert.strictEqual(result.reconciliation.pending, 3);
    assert.strictEqual(result.activation_marked, false);
    assert.strictEqual((await getPriceLadderFeatureConfig(110)).reconcile_required, true);
    assert.strictEqual(calls.length, beforeIncompleteCalls);
    assert.deepStrictEqual((await runtimes(110)).map(row => row.applied_tier), beforeIncomplete.map(row => row.applied_tier));
    assert.deepStrictEqual((await runtimes(110)).map(row => row.desired_tier), beforeIncomplete.map(row => row.desired_tier));
    assert.deepStrictEqual((await runtimes(110)).map(row => row.completed_order_count), beforeIncomplete.map(row => row.completed_order_count));
    await sql('ALTER TABLE "order" RENAME TO unavailable_order');
    const beforeQueryFailure = await runtimes(110);
    try {
        await assert.rejects(reconcilePendingPriceLaddersByUser(110, {
            now: at('2026-10-17 06:01:00'), publisher, logger
        }), /no such table/);
        assert.strictEqual(calls.length, beforeIncompleteCalls);
        assert.deepStrictEqual(await runtimes(110), beforeQueryFailure);
    } finally {
        await sql('ALTER TABLE unavailable_order RENAME TO "order"');
    }
    result = await reconcile(110, '2026-10-17 06:01:00');
    assert.strictEqual(result.activation_marked, true);
    assert.strictEqual((await getPriceLadderFeatureConfig(110)).reconcile_required, false);
    await assertTier(110, 3, 2);

    // A mode switch after counting but before publication invalidates the old target.
    await configure(112, 'rolling_24h');
    await createAccount(112);
    await save(112, '2026-10-16 12:00:00');
    feature = await getPriceLadderFeatureConfig(112);
    await reconcile(112, '2026-10-16 12:00:00', { activation_reconcile: true, feature_version: feature.version });
    await order(112, 'only-rolling', '2026-10-15 21:00:00');
    const beforeRace = calls.length;
    let guardCalls = 0;
    result = await reconcile(112, '2026-10-16 12:00:00', {
        feature_guard: async () => {
            if (++guardCalls === 1) await configure(112, 'business_day');
            return getPriceLadderFeatureConfig(112);
        }
    });
    assert.strictEqual(calls.length, beforeRace, 'stale rolling count must never reach any channel');
    assert.strictEqual(result.reconciliation.pending, 3);
    assert(result.reconciliation.list.every(row => /changed/.test(row.reason)), 'configuration race is observable');
    assert.deepStrictEqual((await runtimes(112)).map(row => row.applied_tier), [1, 1, 1]);
    await reconcile(112, '2026-10-16 12:00:00');
    await assertTier(112, 1, 0);
    await assertViews(112, '2026-10-16 12:00:00', 'business_day', 0);

    // Toggle off/on without an explicit mode preserves the owner's selected period.
    feature = await getPriceLadderFeatureConfig(112);
    feature = await setPriceLadderFeatureEnabled(112, false, { expected_version: feature.version });
    assert.strictEqual(feature.count_mode, 'business_day');
    feature = await setPriceLadderFeatureEnabled(112, true, { expected_version: feature.version });
    assert.strictEqual(feature.count_mode, 'business_day');
    result = await reconcile(112, '2026-10-16 12:00:00', {
        activation_reconcile: true, feature_version: feature.version
    });
    assert.strictEqual(result.activation_marked, true);
    assert.strictEqual((await getPriceLadderFeatureConfig(112)).reconcile_required, false);
    await assertTier(112, 1, 0);

    // The real order-sync entry reads the current activation flag every round. A failed
    // first activation must keep its runtime retry slot without requeueing successful channels.
    await createAccount(113);
    await order(113, 'activation-order', '2026-10-16 10:00:00');
    assert.strictEqual((await save(113, '2026-10-16 12:00:00')).publish_result, null);
    await configure(113, 'business_day');
    const activationCalls = Object.fromEntries(CHANNELS.map(channel => [channel, 0]));
    const activationPublishers = Object.fromEntries(CHANNELS.map(channel => [channel, async () => {
        activationCalls[channel] += 1;
        if (channel === 'uuzuhao' && activationCalls[channel] === 1) {
            return { ok: false, message: 'activation rate limited' };
        }
        return { ok: true, changed: true };
    }]));
    const runFromFeatureFlag = async (now, extra = {}) => {
        const latest = await getPriceLadderFeatureConfig(113);
        return reconcile(113, now, {
            activation_reconcile: latest.reconcile_required,
            feature_version: latest.version,
            publishers: activationPublishers,
            ...extra
        });
    };
    result = await runFromFeatureFlag('2026-10-16 12:00:00', { allow_apply: false });
    assert.strictEqual(result.activation.queued, 0);
    assert.strictEqual(result.activation.initialized, 0);
    assert.strictEqual(result.activation_marked, false);
    assert.strictEqual(result.reconciliation.pending, 3);
    assert.deepStrictEqual(activationCalls, { uhaozu: 0, uuzuhao: 0, zuhaowang: 0 });
    assert.strictEqual((await getPriceLadderFeatureConfig(113)).reconcile_required, true);
    assert.deepStrictEqual((await runtimes(113)).map(row => row.applied_tier), [0, 0, 0]);

    result = await runFromFeatureFlag('2026-10-16 12:00:00');
    assert.strictEqual(result.reconciliation.applied, 2);
    assert.strictEqual(result.reconciliation.failed, 1);
    assert.strictEqual(result.activation_marked, true, 'ordinary activation completes its single calibration pass; failures remain in runtime');
    assert.strictEqual((await getPriceLadderFeatureConfig(113)).reconcile_required, false);
    assert.deepStrictEqual(activationCalls, { uhaozu: 1, uuzuhao: 1, zuhaowang: 1 });
    let failedActivation = await getAccountPriceLadderRuntime(113, GAME, accountName(113), 'uuzuhao');
    assert.strictEqual(failedActivation.status, 'failed');
    assert.strictEqual(failedActivation.next_retry_at, '2026-10-16 12:30:00');

    result = await runFromFeatureFlag('2026-10-16 12:05:00');
    assert.strictEqual(result.activation.queued, 0);
    assert.strictEqual(result.reconciliation.unchanged, 2);
    assert.strictEqual(result.reconciliation.pending, 1);
    assert.strictEqual(result.reconciliation.list.find(row => row.channel === 'uuzuhao').reason, 'retry_not_due');
    assert.deepStrictEqual(activationCalls, { uhaozu: 1, uuzuhao: 1, zuhaowang: 1 });
    failedActivation = await getAccountPriceLadderRuntime(113, GAME, accountName(113), 'uuzuhao');
    assert.strictEqual(failedActivation.next_retry_at, '2026-10-16 12:30:00');

    result = await runFromFeatureFlag('2026-10-16 12:30:00');
    assert.strictEqual(result.reconciliation.applied, 1);
    assert.strictEqual(result.reconciliation.unchanged, 2);
    assert.deepStrictEqual(activationCalls, { uhaozu: 1, uuzuhao: 2, zuhaowang: 1 });
    await assertTier(113, 2, 1);

    console.log('[OK] price_ladder_count_mode_smoke_test passed: selected windows, boundaries, three-channel reconciliation, read views, sync failures and mode races');
}

main().catch(error => {
    console.error('[FAIL] price_ladder_count_mode_smoke_test:', error);
    process.exitCode = 1;
});
