#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-price-ladder-reconcile-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.ORDER_DB_FILE_PATH = path.join(tempDir, 'rent_robot_order.db');
process.env.PRICE_DB_FILE_PATH = path.join(tempDir, 'rent_robot_price.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');
process.env.ORDER_COUNT_TRACE = 'false';

const { initUserGameAccountDb, upsertUserGameAccount } = require('../database/user_game_account_db');
const {
    upsertOrder,
    listOrders,
    listTodayOrderCountByAccounts,
    listTodayPaidOrderCountByAccounts,
    listBusinessDayFinishedOrderCountByAccounts,
    _internal: orderInternal
} = require('../database/order_db');
const { upsertBlacklistSource } = require('../database/user_blacklist_source_db');
const {
    initAccountPriceLadderRuntimeDb,
    getAccountPriceLadderRuntime,
    upsertAccountPriceLadderRuntime
} = require('../database/account_price_ladder_runtime_db');
const { initPriceLadderJobStateDb, getPriceLadderJobBusinessDate } = require('../database/price_ladder_job_state_db');
const {
    getPriceLadderFeatureConfig,
    setPriceLadderFeatureEnabled
} = require('../database/price_ladder_feature_config_db');
const { savePriceLadderRuleByUser, getPriceLadderDashboardByUser, getPriceLadderChannelResultByUser } = require('../price/price_ladder_service');
const {
    buildPriceLadderCandidatesFromOrderWrite,
    mergePriceLadderCandidates,
    initializePriceLadderRuntimeOnRuleSave,
    enqueuePriceLadderCandidates,
    getPriceLadderApplyBlock,
    reconcilePriceLadderAfterOrderSync,
    reconcilePendingPriceLaddersByUser,
    _internal
} = require('../price/price_ladder_reconcile_service');

const USER_ID = 8;
const GAME_ID = '2';
const GAME_NAME = '和平精英';
const ACCOUNT = 'ladder-account';

function addDays(day, count) {
    const date = new Date(`${day}T12:00:00`);
    date.setDate(date.getDate() + Number(count || 0));
    return date.toISOString().slice(0, 10);
}

function localDate(day, time = '08:00:00') {
    return new Date(`${day}T${time}`);
}

async function writeOrder(orderNo, status, day, input = {}) {
    const order = {
        user_id: USER_ID,
        channel: input.channel || 'uhaozu',
        order_no: orderNo,
        game_id: input.game_id || GAME_ID,
        game_name: input.game_name || GAME_NAME,
        game_account: input.game_account || ACCOUNT,
        order_status: status,
        order_amount: 10,
        rec_amount: input.rec_amount == null ? 8 : input.rec_amount,
        start_time: `${day} ${input.start_time || '08:00:00'}`,
        end_time: `${day} ${input.end_time || '09:00:00'}`,
        create_date: `${day} ${input.start_time || '08:00:00'}`,
        desc: 'price ladder reconcile smoke'
    };
    const result = await upsertOrder(order);
    return {
        order,
        result,
        candidates: buildPriceLadderCandidatesFromOrderWrite(order, result)
    };
}

async function runtime() {
    return getAccountPriceLadderRuntime(USER_ID, GAME_ID, ACCOUNT, 'uhaozu');
}

(async () => {
    await initUserGameAccountDb();
    await initAccountPriceLadderRuntimeDb();
    await initPriceLadderJobStateDb();
    await setPriceLadderFeatureEnabled(USER_ID, true, { expected_version: 0 });
    await upsertUserGameAccount({
        user_id: USER_ID,
        game_id: GAME_ID,
        game_name: GAME_NAME,
        game_account: ACCOUNT,
        account_remark: '测试账号',
        channel_status: { uhaozu: '上架' },
        channel_prd_info: {
            uhaozu: {
                prd_id: 'goods-ladder',
                rentalByHour: 2,
                rentalByNight: 8,
                rentalByDay: 12,
                rentalByWeek: 70
            }
        }
    });

    const day = orderInternal.businessDateText(6);
    const nextDay = addDays(day, 1);
    const publishCalls = [];
    let publishMode = 'success';
    const publisher = async (_uid, input) => {
        publishCalls.push(input);
        if (publishMode === 'throw') throw new Error('network timeout');
        if (publishMode === 'fail') return { ok: false, message: '平台价格范围错误' };
        if (publishMode === 'unchanged') return { ok: true, changed: false, prices: input.prices };
        return { ok: true, changed: true, batch_id: `batch-${publishCalls.length}`, prices: input.prices };
    };
    await savePriceLadderRuleByUser(USER_ID, {
        game_id: GAME_ID,
        game_name: GAME_NAME,
        game_account: ACCOUNT,
        prices: [2, 3, 4, 5],
        expected_version: 0
    }, {
        now: localDate(day),
        publisher
    });
    assert.strictEqual((await runtime()).applied_tier, 1);
    assert.strictEqual(publishCalls.length, 1);
    assert.strictEqual(publishCalls[0].force_publish, true);
    publishCalls.length = 0;
    publishMode = 'unchanged';
    const sameTierReset = await reconcilePriceLadderAfterOrderSync(USER_ID, [], {
        now: localDate(day), allow_apply: true, publisher
    });
    assert.strictEqual(sameTierReset.reset.due, true);
    assert.strictEqual(sameTierReset.reconciliation.unchanged, 1);
    assert.strictEqual(publishCalls.length, 1);
    assert.strictEqual(publishCalls[0].trigger_source, 'daily_reset');
    publishCalls.length = 0;
    publishMode = 'success';

    const renting = await writeOrder('order-1', '租赁中', day);
    assert.strictEqual(renting.result.price_ladder_relevant_changed, false);
    assert.deepStrictEqual(renting.candidates, []);
    const finished = await writeOrder('order-1', '已完成', day);
    assert.strictEqual(finished.result.status_changed, true);
    assert.strictEqual(finished.result.price_ladder_relevant_changed, true);
    assert.strictEqual(finished.candidates[0].delta, 1);

    const first = await reconcilePriceLadderAfterOrderSync(USER_ID, finished.candidates, {
        now: localDate(day),
        allow_apply: true,
        publisher,
        activation_reconcile: true,
        feature_version: 1
    });
    assert.strictEqual(first.reset.due, false);
    assert.strictEqual(first.activation.scanned, 1);
    assert.strictEqual(first.activation_marked, true);
    assert.strictEqual((await getPriceLadderFeatureConfig(USER_ID)).reconcile_required, false);
    assert.strictEqual(first.queued.queued, 1);
    assert.strictEqual(first.reconciliation.applied, 1);
    assert.strictEqual(publishCalls.length, 1);
    assert.strictEqual(publishCalls[0].tier, 2);
    assert.strictEqual((await runtime()).applied_tier, 2);

    const sameFinished = await writeOrder('order-1', '已完成', day);
    assert.strictEqual(sameFinished.result.status_changed, false);
    assert.strictEqual(sameFinished.result.price_ladder_relevant_changed, false);
    const partial = await writeOrder('order-1', '部分完成', day);
    assert.strictEqual(partial.result.status_changed, true);
    assert.strictEqual(partial.result.price_ladder_relevant_changed, false);
    assert.strictEqual((await reconcilePriceLadderAfterOrderSync(USER_ID, [], {
        now: localDate(day), allow_apply: true, publisher
    })).reconciliation.scanned, 0);
    assert.strictEqual(publishCalls.length, 1);

    const order2 = await writeOrder('order-2', '已完成', day, { channel: 'uuzuhao' });
    const incomplete = await reconcilePriceLadderAfterOrderSync(USER_ID, order2.candidates, {
        now: localDate(day), allow_apply: false, publisher
    });
    assert.strictEqual(incomplete.reconciliation.pending, 1);
    assert.strictEqual(publishCalls.length, 1);
    const recovered = await reconcilePriceLadderAfterOrderSync(USER_ID, [], {
        now: localDate(day), allow_apply: true, publisher
    });
    assert.strictEqual(recovered.reconciliation.applied, 1);
    assert.strictEqual(publishCalls.length, 2);
    assert.strictEqual(publishCalls[1].tier, 3);

    const order3 = await writeOrder('order-3', '已完成', day, { channel: 'zuhaowang' });
    await upsertBlacklistSource(USER_ID, ACCOUNT, 'order_cooldown', {
        game_id: GAME_ID,
        game_name: GAME_NAME,
        active: true,
        reason: '冷却期下架',
        priority: 500
    });
    await upsertBlacklistSource(USER_ID, ACCOUNT, 'platform_face_verify', {
        game_id: GAME_ID,
        game_name: GAME_NAME,
        active: true,
        reason: '人脸识别',
        priority: 800
    });
    const allowedDuringCooldown = await reconcilePriceLadderAfterOrderSync(USER_ID, order3.candidates, {
        now: localDate(day), allow_apply: true, publisher
    });
    assert.strictEqual(allowedDuringCooldown.reconciliation.applied, 1);
    assert.strictEqual(publishCalls.length, 3);
    assert.strictEqual(publishCalls[2].tier, 4);
    assert.strictEqual((await runtime()).status, 'applied');

    await upsertBlacklistSource(USER_ID, ACCOUNT, 'manual_maintenance', {
        game_id: GAME_ID,
        game_name: GAME_NAME,
        active: true,
        reason: '维护中',
        priority: 900
    });
    const maintenanceBlock = await getPriceLadderApplyBlock(USER_ID, {
        game_id: GAME_ID,
        game_name: GAME_NAME,
        game_account: ACCOUNT
    });
    assert.strictEqual(maintenanceBlock.blocked, false);
    assert.strictEqual(maintenanceBlock.reason, '');
    await upsertBlacklistSource(USER_ID, ACCOUNT, 'order_cooldown', {
        game_id: GAME_ID,
        game_name: GAME_NAME,
        active: false,
        reason: '冷却期下架',
        priority: 500
    });
    await upsertBlacklistSource(USER_ID, ACCOUNT, 'platform_face_verify', {
        game_id: GAME_ID,
        game_name: GAME_NAME,
        active: false,
        reason: '人脸识别',
        priority: 800
    });
    await upsertBlacklistSource(USER_ID, ACCOUNT, 'manual_maintenance', {
        game_id: GAME_ID,
        game_name: GAME_NAME,
        active: false,
        reason: '维护中',
        priority: 900
    });

    const order4 = await writeOrder('order-4', '已完成', day);
    const sameTier = await reconcilePriceLadderAfterOrderSync(USER_ID, order4.candidates, {
        now: localDate(day), allow_apply: true, publisher
    });
    assert.strictEqual(sameTier.reconciliation.unchanged, 1);
    assert.strictEqual(publishCalls.length, 3);

    await upsertUserGameAccount({
        user_id: USER_ID,
        game_id: GAME_ID,
        game_name: GAME_NAME,
        game_account: ACCOUNT,
        channel_prd_info: {
            uhaozu: {
                prd_id: 'goods-ladder',
                rentalByHour: 4.66,
                rentalByNight: 17,
                rentalByDay: 26,
                rentalByWeek: 145
            }
        }
    });
    const noPending = await reconcilePendingPriceLaddersByUser(USER_ID, {
        now: localDate(day), allow_apply: true, publisher
    });
    assert.strictEqual(noPending.scanned, 0);
    assert.strictEqual(publishCalls.length, 3);
    const channelView = await getPriceLadderChannelResultByUser(USER_ID, {
        game_id: GAME_ID,
        game_name: GAME_NAME,
        game_account: ACCOUNT
    });
    assert.strictEqual(channelView.channel_result.apply_status, 'manual');
    assert.strictEqual(channelView.channel_result.remote_current.hour, 4.66);

    const refund4 = await writeOrder('order-4', '已退款', day);
    const stillTier4 = await reconcilePriceLadderAfterOrderSync(USER_ID, refund4.candidates, {
        now: localDate(day), allow_apply: true, publisher
    });
    assert.strictEqual(stillTier4.reconciliation.unchanged, 1);
    const refund3 = await writeOrder('order-3', '已退款', day, { channel: 'zuhaowang' });
    const downshift = await reconcilePriceLadderAfterOrderSync(USER_ID, refund3.candidates, {
        now: localDate(day), allow_apply: true, publisher
    });
    assert.strictEqual(downshift.reconciliation.applied, 1);
    assert.strictEqual(publishCalls.at(-1).tier, 3);

    const reset = await reconcilePriceLadderAfterOrderSync(USER_ID, [], {
        now: localDate(nextDay, '06:01:00'), allow_apply: true, publisher
    });
    assert.strictEqual(reset.reset.due, true);
    assert.strictEqual(reset.reconciliation.applied, 1);
    assert.strictEqual(publishCalls.at(-1).tier, 1);
    const resetAgain = await reconcilePriceLadderAfterOrderSync(USER_ID, [], {
        now: localDate(nextDay, '06:06:00'), allow_apply: true, publisher
    });
    assert.strictEqual(resetAgain.reset.due, false);
    assert.strictEqual(resetAgain.reconciliation.scanned, 0);

    const active = await writeOrder('active-next', '租赁中', nextDay);
    assert.strictEqual(active.candidates.length, 0);
    const nextFinished = await writeOrder('finished-next', '已完成', nextDay);
    const activeBlocked = await reconcilePriceLadderAfterOrderSync(USER_ID, nextFinished.candidates, {
        now: localDate(nextDay), allow_apply: true, publisher
    });
    assert.strictEqual(activeBlocked.reconciliation.applied, 1);
    assert.strictEqual(activeBlocked.reconciliation.list[0].tier, 2);
    await writeOrder('active-next', '已撤单', nextDay);
    const failedNext = await writeOrder('failed-next', '已完成', nextDay);
    publishMode = 'fail';
    const failed = await reconcilePriceLadderAfterOrderSync(USER_ID, failedNext.candidates, {
        now: localDate(nextDay), allow_apply: true, publisher
    });
    assert.strictEqual(failed.reconciliation.failed, 1);
    assert.strictEqual((await runtime()).status, 'failed');
    const tooSoon = await reconcilePendingPriceLaddersByUser(USER_ID, {
        now: localDate(nextDay, '08:10:00'), allow_apply: true, publisher
    });
    assert.strictEqual(tooSoon.scanned, 0);
    publishMode = 'throw';
    const thrown = await reconcilePendingPriceLaddersByUser(USER_ID, {
        now: localDate(nextDay, '08:31:00'), allow_apply: true, publisher
    });
    assert.strictEqual(thrown.failed, 1);
    publishMode = 'success';
    const retried = await reconcilePendingPriceLaddersByUser(USER_ID, {
        now: localDate(nextDay, '09:02:00'), allow_apply: true, publisher
    });
    assert.strictEqual(retried.applied, 1);

    const counts = await listBusinessDayFinishedOrderCountByAccounts(USER_ID, [{
        game_id: GAME_ID, game_account: ACCOUNT
    }], nextDay);
    assert.strictEqual(counts[`${GAME_ID}::${ACCOUNT}`], 2);
    const orderPage = await listOrders(USER_ID, 1, 500);
    assert(orderPage.total >= 6);
    assert(orderPage.list.some((item) => item.order_no === 'finished-next'));
    const naturalCounts = await listTodayOrderCountByAccounts(USER_ID, [ACCOUNT], day);
    assert(Number(naturalCounts[ACCOUNT] || 0) >= 4);
    const paidCounts = await listTodayPaidOrderCountByAccounts(USER_ID, [{
        game_id: GAME_ID, game_account: ACCOUNT
    }], day);
    assert(Number(paidCounts[`${GAME_ID}::${ACCOUNT}`] || 0) >= 2);
    const dashboard = await getPriceLadderDashboardByUser(USER_ID, { game_id: GAME_ID, game_name: GAME_NAME });
    assert.strictEqual(dashboard.list[0].today_order_count, 2);
    assert.strictEqual(dashboard.list[0].current_tier, 3);
    assert.strictEqual(await getPriceLadderJobBusinessDate(USER_ID, _internal.DAILY_RESET_JOB_KEY), nextDay);

    const restricted = await getPriceLadderApplyBlock(USER_ID, {
        game_id: GAME_ID,
        game_name: GAME_NAME,
        game_account: 'restricted-account',
        channel_status: { uhaozu: '授权异常' },
        channel_prd_info: { uhaozu: { audit_reason: '授权失效' } }
    });
    assert.strictEqual(restricted.blocked, false);
    assert.strictEqual(restricted.reason, '');
    assert.strictEqual(await initializePriceLadderRuntimeOnRuleSave(0, null), null);

    await upsertAccountPriceLadderRuntime(USER_ID, {
        game_id: GAME_ID,
        game_name: GAME_NAME,
        game_account: 'missing-account',
        channel: 'uhaozu',
        business_date: nextDay,
        completed_order_count: 1,
        desired_tier: 2,
        applied_tier: 1,
        status: 'pending'
    });
    const missing = await reconcilePendingPriceLaddersByUser(USER_ID, {
        now: localDate(nextDay, '10:00:00'), allow_apply: true, publisher
    });
    assert(missing.list.some((item) => item.reason === 'rule_missing'));

    await upsertUserGameAccount({
        user_id: USER_ID,
        game_id: GAME_ID,
        game_name: GAME_NAME,
        game_account: 'no-baseline',
        account_remark: '无基准',
        channel_status: { uhaozu: '上架' },
        channel_prd_info: { uhaozu: { prd_id: 'goods-no-baseline', rentalByHour: 2 } }
    });
    await savePriceLadderRuleByUser(USER_ID, {
        game_id: GAME_ID,
        game_name: GAME_NAME,
        game_account: 'no-baseline',
        prices: [2, 3, 4, 5],
        expected_version: 0
    });
    const noBaselineOrder = await writeOrder('no-baseline-order', '已完成', nextDay, {
        game_account: 'no-baseline'
    });
    const noBaseline = await reconcilePriceLadderAfterOrderSync(USER_ID, noBaselineOrder.candidates, {
        now: localDate(nextDay, '10:01:00'), allow_apply: true, publisher
    });
    assert(noBaseline.reconciliation.list.some((item) => item.reason === 'baseline_unavailable'));

    const noRuleQueued = await enqueuePriceLadderCandidates(USER_ID, [{
        game_id: GAME_ID,
        game_name: GAME_NAME,
        game_account: 'unconfigured-account',
        business_date: nextDay,
        delta: 1,
        order_nos: ['unconfigured-order']
    }], { now: localDate(nextDay, '10:02:00') });
    assert.strictEqual(noRuleQueued.queued, 0);
    assert.strictEqual(await getAccountPriceLadderRuntime(USER_ID, GAME_ID, 'unconfigured-account', 'uhaozu'), null);

    await upsertAccountPriceLadderRuntime(USER_ID, {
        ...(await runtime()),
        applied_tier: 1,
        status: 'pending',
        next_retry_at: ''
    });
    const callsBeforeDisabledGuard = publishCalls.length;
    const disabledMidRun = await reconcilePendingPriceLaddersByUser(USER_ID, {
        now: localDate(nextDay, '10:03:00'),
        allow_apply: true,
        publisher,
        feature_guard: async () => ({ enabled: false })
    });
    assert.strictEqual(disabledMidRun.pending, 1);
    assert(disabledMidRun.list.some((item) => item.reason === 'feature_disabled'));
    assert.strictEqual(publishCalls.length, callsBeforeDisabledGuard);

    let clearedDuringGuard = false;
    const callsBeforeClearGuard = publishCalls.length;
    const clearedMidRun = await reconcilePendingPriceLaddersByUser(USER_ID, {
        now: localDate(nextDay, '10:04:00'),
        allow_apply: true,
        publisher,
        feature_guard: async () => {
            if (!clearedDuringGuard) {
                await savePriceLadderRuleByUser(USER_ID, {
                    game_id: GAME_ID,
                    game_name: GAME_NAME,
                    game_account: ACCOUNT,
                    action: 'clear',
                    expected_version: 1
                });
                clearedDuringGuard = true;
            }
            return { enabled: true };
        }
    });
    assert(clearedMidRun.list.some((item) => item.reason === 'rule_cleared'));
    assert.strictEqual(publishCalls.length, callsBeforeClearGuard);

    assert.deepStrictEqual(mergePriceLadderCandidates([
        { game_id: GAME_ID, game_account: ACCOUNT, business_date: day, delta: 1, order_no: 'a' },
        { game_id: GAME_ID, game_account: ACCOUNT, business_date: day, delta: -1, order_no: 'b' }
    ]), []);
    assert.strictEqual(_internal.tierByCompletedCount(-1), 1);
    assert.strictEqual(_internal.tierByCompletedCount(99), 4);
    assert.strictEqual(_internal.businessDateForOrder({ start_time: `${day} 05:00:00` }), addDays(day, -1));
    assert.strictEqual(_internal.isRetryDue({ next_retry_at: '' }), true);
    assert(/"tier":1/.test(_internal.priceSignature(1, { hour: 2, night: 8, day: 12, week: 70 })));

    console.log('[OK] price_ladder_reconcile_smoke_test passed');
})().catch((error) => {
    console.error('[FAIL] price_ladder_reconcile_smoke_test failed:', error);
    process.exit(1);
});
