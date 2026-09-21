#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-price-ladder-multi-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.ORDER_DB_FILE_PATH = path.join(tempDir, 'rent_robot_order.db');
process.env.PRICE_DB_FILE_PATH = path.join(tempDir, 'rent_robot_price.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');
process.env.ORDER_COUNT_TRACE = 'false';

const { upsertUserGameAccount } = require('../database/user_game_account_db');
const { upsertOrder, _internal: orderInternal } = require('../database/order_db');
const { setPriceLadderFeatureEnabled } = require('../database/price_ladder_feature_config_db');
const { getAccountPriceLadderRuntime } = require('../database/account_price_ladder_runtime_db');
const { savePriceLadderRuleByUser, getPriceLadderChannelResultByUser } = require('../price/price_ladder_service');
const {
    buildPriceLadderCandidatesFromOrderWrite,
    reconcilePriceLadderAfterOrderSync
} = require('../price/price_ladder_reconcile_service');

const USER_ID = 18;
const GAME_ID = '2';
const GAME_NAME = '和平精英';
const ACCOUNT = 'multi-channel-account';

function addDays(day, count) {
    const date = new Date(`${day}T12:00:00`);
    date.setDate(date.getDate() + Number(count || 0));
    return date.toISOString().slice(0, 10);
}

function localDate(day, time = '08:00:00') {
    return new Date(`${day}T${time}`);
}

async function finishOrder(orderNo, day) {
    const order = {
        user_id: USER_ID,
        channel: 'uuzuhao',
        order_no: orderNo,
        game_id: GAME_ID,
        game_name: GAME_NAME,
        game_account: ACCOUNT,
        order_status: '已完成',
        order_amount: 10,
        rec_amount: 8,
        start_time: `${day} 08:00:00`,
        end_time: `${day} 09:00:00`,
        create_date: `${day} 08:00:00`
    };
    const write = await upsertOrder(order);
    return buildPriceLadderCandidatesFromOrderWrite(order, write);
}

async function main() {
    await setPriceLadderFeatureEnabled(USER_ID, true, { expected_version: 0 });
    await upsertUserGameAccount({
        user_id: USER_ID,
        game_id: GAME_ID,
        game_name: GAME_NAME,
        game_account: ACCOUNT,
        account_remark: '双渠道账号',
        channel_prd_info: {
            uhaozu: {
                prd_id: 'uhaozu-multi',
                rentalByHour: 2,
                rentalByNight: 8,
                rentalByDay: 12,
                rentalByWeek: 70
            },
            uuzuhao: {
                prd_id: 'uuzuhao-multi',
                hourPrice: 2,
                minRentHour: 2
            }
        }
    });

    const day = orderInternal.businessDateText(6);
    const nextDay = addDays(day, 1);
    const calls = [];
    let failUuzuhao = false;
    const publishers = {
        uhaozu: async (_uid, input) => {
            calls.push({ channel: 'uhaozu', ...input });
            return { ok: true, changed: true, batch_id: `u-${calls.length}`, prices: input.prices };
        },
        uuzuhao: async (_uid, input) => {
            calls.push({ channel: 'uuzuhao', ...input });
            if (failUuzuhao) return { ok: false, changed: false, message: '悠悠套餐范围错误' };
            return { ok: true, changed: true, batch_id: `y-${calls.length}`, prices: input.prices };
        }
    };

    const saved = await savePriceLadderRuleByUser(USER_ID, {
        game_id: GAME_ID,
        game_name: GAME_NAME,
        game_account: ACCOUNT,
        prices: [2, 3, 4, 5],
        expected_version: 0
    }, { now: localDate(day), publishers });
    assert.strictEqual(saved.publish_result.applied, 2);
    assert.deepStrictEqual(calls.map((item) => item.channel), ['uhaozu', 'uuzuhao']);
    assert(calls.every((item) => item.tier === 1 && item.force_publish === true));
    assert.strictEqual(calls[1].prices.p2, 3.6);
    assert.strictEqual(calls[1].prices.p168, 201.6);
    assert.strictEqual((await getAccountPriceLadderRuntime(USER_ID, GAME_ID, ACCOUNT, 'uhaozu')).applied_tier, 1);
    assert.strictEqual((await getAccountPriceLadderRuntime(USER_ID, GAME_ID, ACCOUNT, 'uuzuhao')).applied_tier, 1);

    calls.length = 0;
    const tier2 = await reconcilePriceLadderAfterOrderSync(USER_ID, await finishOrder('multi-1', day), {
        now: localDate(day),
        allow_apply: true,
        publishers
    });
    assert.strictEqual(tier2.reconciliation.applied, 2);
    assert.strictEqual(tier2.queued.queued, 2);
    assert.strictEqual(calls.find((item) => item.channel === 'uhaozu').force_publish, false);
    assert.strictEqual(calls.find((item) => item.channel === 'uuzuhao').force_publish, true);

    calls.length = 0;
    failUuzuhao = true;
    const split = await reconcilePriceLadderAfterOrderSync(USER_ID, await finishOrder('multi-2', day), {
        now: localDate(day, '09:00:00'),
        allow_apply: true,
        publishers
    });
    assert.strictEqual(split.reconciliation.applied, 1);
    assert.strictEqual(split.reconciliation.failed, 1);
    assert.strictEqual((await getAccountPriceLadderRuntime(USER_ID, GAME_ID, ACCOUNT, 'uhaozu')).applied_tier, 3);
    assert.strictEqual((await getAccountPriceLadderRuntime(USER_ID, GAME_ID, ACCOUNT, 'uuzuhao')).status, 'failed');

    calls.length = 0;
    failUuzuhao = false;
    const tier4 = await reconcilePriceLadderAfterOrderSync(USER_ID, await finishOrder('multi-3', day), {
        now: localDate(day, '10:00:00'),
        allow_apply: true,
        publishers
    });
    assert.strictEqual(tier4.reconciliation.applied, 2);
    assert(calls.every((item) => item.tier === 4));

    calls.length = 0;
    const capped = await reconcilePriceLadderAfterOrderSync(USER_ID, await finishOrder('multi-4', day), {
        now: localDate(day, '11:00:00'),
        allow_apply: true,
        publishers
    });
    assert.strictEqual(capped.reconciliation.unchanged, 2);
    assert.strictEqual(calls.length, 0);

    const view = await getPriceLadderChannelResultByUser(USER_ID, {
        game_id: GAME_ID,
        game_name: GAME_NAME,
        game_account: ACCOUNT,
        channel: 'uuzuhao'
    });
    assert.strictEqual(view.selected_channel, 'uuzuhao');
    assert.strictEqual(view.channel_result.package_keys.length, 9);
    assert.strictEqual(view.channel_result.tiers[0].prices.p24, 28.8);
    assert.strictEqual(view.channel_result.baseline_status, 'formula');
    assert.strictEqual(view.channel_result.apply_status, 'manual');

    calls.length = 0;
    const reset = await reconcilePriceLadderAfterOrderSync(USER_ID, [], {
        now: localDate(nextDay, '06:01:00'),
        allow_apply: true,
        publishers
    });
    assert.strictEqual(reset.reset.due, true);
    assert.strictEqual(reset.reconciliation.applied, 2);
    const uhaozuReset = calls.find((item) => item.channel === 'uhaozu');
    const uuzuhaoReset = calls.find((item) => item.channel === 'uuzuhao');
    assert.strictEqual(uhaozuReset.force_publish, false);
    assert.strictEqual(uuzuhaoReset.force_publish, true);
    assert.strictEqual(uuzuhaoReset.tier, 1);

    const bootstrapAccount = 'later-uuzuhao-account';
    await upsertUserGameAccount({
        user_id: USER_ID,
        game_id: GAME_ID,
        game_name: GAME_NAME,
        game_account: bootstrapAccount,
        account_remark: '后绑定悠悠',
        channel_prd_info: {
            uhaozu: {
                prd_id: 'uhaozu-later',
                rentalByHour: 2,
                rentalByNight: 8,
                rentalByDay: 12,
                rentalByWeek: 70
            }
        }
    });
    await savePriceLadderRuleByUser(USER_ID, {
        game_id: GAME_ID,
        game_name: GAME_NAME,
        game_account: bootstrapAccount,
        prices: [2, 3, 4, 5],
        expected_version: 0
    }, { now: localDate(nextDay, '07:00:00'), publishers });
    assert.strictEqual(await getAccountPriceLadderRuntime(USER_ID, GAME_ID, bootstrapAccount, 'uuzuhao'), null);
    await upsertUserGameAccount({
        user_id: USER_ID,
        game_id: GAME_ID,
        game_name: GAME_NAME,
        game_account: bootstrapAccount,
        account_remark: '后绑定悠悠',
        channel_prd_info: {
            uhaozu: {
                prd_id: 'uhaozu-later',
                rentalByHour: 2,
                rentalByNight: 8,
                rentalByDay: 12,
                rentalByWeek: 70
            },
            uuzuhao: { prd_id: 'uuzuhao-later', hourPrice: 2, minRentHour: 2 }
        }
    });
    calls.length = 0;
    const bootstrapped = await reconcilePriceLadderAfterOrderSync(USER_ID, [], {
        now: localDate(nextDay, '07:05:00'),
        allow_apply: true,
        publishers
    });
    assert.strictEqual(bootstrapped.channel_bootstrap.initialized, 1);
    assert.deepStrictEqual(calls.map((item) => item.channel), ['uuzuhao']);
    assert.strictEqual(calls[0].trigger_source, 'channel_enabled_reconcile');
    assert.strictEqual((await getAccountPriceLadderRuntime(USER_ID, GAME_ID, bootstrapAccount, 'uuzuhao')).status, 'applied');

    console.log('[OK] price_ladder_multi_channel_smoke_test passed');
}

main().catch((error) => {
    console.error('[FAIL] price_ladder_multi_channel_smoke_test failed:', error);
    process.exit(1);
});
