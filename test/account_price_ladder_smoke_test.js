#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-price-ladder-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.ORDER_DB_FILE_PATH = path.join(tempDir, 'rent_robot_order.db');
process.env.PRICE_DB_FILE_PATH = path.join(tempDir, 'rent_robot_price.db');
process.env.ORDER_COUNT_TRACE = 'false';

const {
    initUserGameAccountDb,
    upsertUserGameAccount,
    updateUserGameAccountSoldByUserAndAccount
} = require('../database/user_game_account_db');
const { upsertOrder } = require('../database/order_db');
const {
    initAccountPriceLadderRuleDb,
    getAccountPriceLadderRule,
    listAccountPriceLadderRules,
    upsertAccountPriceLadderRule,
    _internal: dbInternal
} = require('../database/account_price_ladder_rule_db');
const {
    initAccountPriceLadderRuntimeDb,
    getAccountPriceLadderRuntime
} = require('../database/account_price_ladder_runtime_db');
const {
    getPriceLadderFeatureConfig,
    setPriceLadderFeatureEnabled
} = require('../database/price_ladder_feature_config_db');
const {
    initAccountChannelPriceBaselineDb,
    getAccountChannelPriceBaseline,
    saveAccountChannelPriceBaseline,
    _internal: baselineDbInternal
} = require('../database/account_channel_price_baseline_db');
const {
    initPricePublishLogDb,
    createPricePublishBatchLog,
    createPricePublishItemLog,
    listPricePublishBatchLogsByUser,
    listPricePublishItemLogsByAccount
} = require('../database/price_publish_log_db');
const {
    getPriceLadderDashboardByUser,
    savePriceLadderRuleByUser,
    getPriceLadderChannelResultByUser,
    _internal: serviceInternal
} = require('../price/price_ladder_service');

function businessDateText() {
    const d = new Date();
    if (d.getHours() < 6) d.setDate(d.getDate() - 1);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function addDays(dateText, days) {
    const d = new Date(`${dateText}T12:00:00`);
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
}

async function expectReject(fn, pattern) {
    let error = null;
    try {
        await fn();
    } catch (err) {
        error = err;
    }
    assert(error, 'expected promise rejection');
    assert(pattern.test(String(error.message || error)), `unexpected error: ${error.message}`);
    return error;
}

async function seedAccount(input) {
    return upsertUserGameAccount({
        user_id: 8,
        game_id: '2',
        game_name: '和平精英',
        account_remark: input.remark || '',
        channel_prd_info: {
            uhaozu: {
                prd_id: input.goodsId || `goods-${input.account}`,
                rentalByHour: input.price,
                rentalByNight: input.night == null ? input.price * 4 : input.night,
                rentalByDay: input.day == null ? input.price * 6 : input.day,
                rentalByWeek: input.week == null ? input.price * 35 : input.week
            }
        },
        game_account: input.account
    });
}

async function seedOrder(orderNo, input = {}) {
    return upsertOrder({
        user_id: 8,
        channel: input.channel || 'uhaozu',
        order_no: orderNo,
        game_id: '2',
        game_name: '和平精英',
        game_account: input.account || 'hpjy-a',
        order_status: input.status || '已完成',
        order_amount: 10,
        rec_amount: input.recAmount == null ? 8 : input.recAmount,
        start_time: input.startTime,
        end_time: input.endTime || input.startTime,
        create_date: input.startTime,
        desc: 'price ladder smoke'
    });
}

async function main() {
    await initUserGameAccountDb();
    await initAccountPriceLadderRuleDb();
    await initAccountPriceLadderRuntimeDb();
    await initAccountChannelPriceBaselineDb();
    await initPricePublishLogDb();
    await seedAccount({ account: 'hpjy-a', remark: '和平一号', price: 2.4 });
    await seedAccount({ account: 'hpjy-b', remark: '和平二号', price: 3 });
    await seedAccount({ account: 'hpjy-sold', remark: '已售账号', price: 4 });
    await updateUserGameAccountSoldByUserAndAccount(8, 'hpjy-sold', {
        game_id: '2',
        game_name: '和平精英',
        sold_at: businessDateText(),
        sold_price: 100,
        lifecycle_income_amount: 10,
        lifecycle_profit_amount: -90
    });
    await upsertUserGameAccount({
        user_id: 8,
        game_id: '1',
        game_name: 'WZRY',
        game_account: 'wzry-a',
        account_remark: '王者账号',
        channel_prd_info: { uhaozu: { rentalByHour: 5 } }
    });

    const day = businessDateText();
    const rulePublishCalls = [];
    const rulePublisher = async (_userId, input) => {
        rulePublishCalls.push(input);
        return { ok: true, changed: true, batch_id: `rule-save-${rulePublishCalls.length}`, prices: input.prices };
    };
    const saveOptions = { publisher: rulePublisher };
    await seedOrder('inside-paid', { startTime: `${day} 06:00:00` });
    await seedOrder('inside-renting', {
        channel: 'uuzuhao',
        status: '租赁中',
        recAmount: 0,
        startTime: `${day} 12:00:00`
    });
    await seedOrder('before-window', { startTime: `${day} 05:59:59` });
    await seedOrder('invalid-order', {
        status: '已取消',
        recAmount: 0,
        startTime: `${day} 13:00:00`
    });
    await seedOrder('next-window', { startTime: `${addDays(day, 1)} 06:00:00` });

    const initial = await getPriceLadderDashboardByUser(8, { game_name: '和平精英' });
    assert.strictEqual(initial.count_window, '06:00～次日06:00');
    assert.strictEqual(initial.channel_scope, 'global');
    assert.strictEqual(initial.effective_channel, 'uhaozu');
    assert.strictEqual(initial.list.length, 2);
    const accountA = initial.list.find((item) => item.game_account === 'hpjy-a');
    assert(accountA);
    assert.strictEqual(accountA.display_name, '和平一号');
    assert.strictEqual(accountA.current_uhaozu_price, 2.4);
    assert.deepStrictEqual(accountA.prices, ['', '', '', '']);
    assert.strictEqual(accountA.today_order_count, 1);
    assert.strictEqual(accountA.configured, false);
    assert.strictEqual(initial.feature.enabled, false);
    assert.strictEqual((await getPriceLadderFeatureConfig(8)).enabled, false);
    const enabledFeature = await setPriceLadderFeatureEnabled(8, true, { expected_version: 0 });
    assert.strictEqual(enabledFeature.enabled, true);
    assert.strictEqual(enabledFeature.reconcile_required, true);

    const savedA = await savePriceLadderRuleByUser(8, {
        game_name: '和平精英',
        game_account: 'hpjy-a',
        prices: [2.4, 3.4, 5.4, 10.4],
        expected_version: 0
    }, saveOptions);
    assert.strictEqual(savedA.version, 1);
    assert.deepStrictEqual(savedA.prices, [2.4, 3.4, 5.4, 10.4]);
    assert.strictEqual(savedA.baseline_created, true);
    assert.strictEqual(savedA.baseline_ready, true);
    const baselineA = await getAccountChannelPriceBaseline(8, '2', 'hpjy-a', 'uhaozu');
    assert.deepStrictEqual(baselineA.prices, { hour: 2.4, night: 9.6, day: 14.4, week: 84 });

    const savedB = await savePriceLadderRuleByUser(8, {
        game_id: '2',
        game_name: '和平精英',
        game_account: 'hpjy-b',
        prices: [2.4, 4.4, 7.4, 12.4],
        expected_version: 0,
        copied_from_game_account: 'hpjy-a'
    }, saveOptions);
    assert.strictEqual(savedB.copied_from_game_account, 'hpjy-a');
    assert.strictEqual(savedB.baseline_created, true);

    const updatedA = await savePriceLadderRuleByUser(8, {
        game_name: '和平精英',
        game_account: 'hpjy-a',
        prices: [2.5, 3.5, 5.5, 10.5],
        expected_version: 1
    }, saveOptions);
    assert.strictEqual(updatedA.version, 2);
    assert.strictEqual(updatedA.baseline_created, false);
    assert.strictEqual(rulePublishCalls.length, 3);
    assert(rulePublishCalls.every((item) => item.force_publish === true));

    const conflict = await expectReject(() => savePriceLadderRuleByUser(8, {
        game_name: '和平精英',
        game_account: 'hpjy-a',
        prices: [2.6, 3.6, 5.6, 10.6],
        expected_version: 1
    }), /配置已变化/);
    assert.strictEqual(conflict.code, 'PRICE_LADDER_VERSION_CONFLICT');

    await expectReject(() => savePriceLadderRuleByUser(8, {
        game_name: '和平精英', game_account: 'hpjy-a', prices: [1, 2, 0, 4]
    }), /大于 0/);
    await expectReject(() => savePriceLadderRuleByUser(8, {
        game_name: '和平精英', game_account: 'missing', prices: [1, 2, 3, 4]
    }), /账号不存在/);
    await expectReject(() => savePriceLadderRuleByUser(8, {
        game_name: '和平精英', game_account: 'hpjy-b', prices: [1, 2, 3, 4], copied_from_game_account: 'missing'
    }), /复制来源/);
    await expectReject(() => savePriceLadderRuleByUser(8, {
        game_name: '和平精英', game_account: 'hpjy-b', prices: [1, 2, 3, 4], copied_from_game_account: 'hpjy-b'
    }), /当前账号/);

    const loaded = await getPriceLadderDashboardByUser(8, { game_name: '和平精英' });
    assert.deepStrictEqual(loaded.list.find((item) => item.game_account === 'hpjy-a').prices, [2.5, 3.5, 5.5, 10.5]);
    assert.strictEqual(loaded.list.find((item) => item.game_account === 'hpjy-b').configured, true);
    const wzry = await getPriceLadderDashboardByUser(8, { game_name: 'WZRY' });
    assert.strictEqual(wzry.list.length, 1);
    assert.strictEqual(wzry.list[0].game_account, 'wzry-a');

    await createPricePublishItemLog({
        batch_id: 'ladder-fail-1',
        user_id: 8,
        channel: 'uhaozu',
        game_name: '和平精英',
        game_account: 'hpjy-a',
        goods_id: 'goods-hpjy-a',
        publish_status: 'fail',
        fail_message: '包夜价格超出范围 token=should-not-be-expanded',
        response_data: {
            stage: 'modify',
            code: 'PRICE_RANGE',
            message: '包夜价格超出范围',
            uhaozu_response: { responseCode: 'PRICE_RANGE', responseMsg: '包夜价格超出范围' }
        },
        price_target_hour: 3.5,
        price_target_night: 14,
        price_target_day: 21,
        price_target_week: 122.5
    });
    await createPricePublishItemLog({
        batch_id: 'ladder-ok-1',
        user_id: 8,
        channel: 'uhaozu',
        game_name: '和平精英',
        game_account: 'hpjy-a',
        goods_id: 'goods-hpjy-a',
        publish_status: 'success'
    });
    await createPricePublishItemLog({
        batch_id: 'ladder-other-game-fail',
        user_id: 8,
        channel: 'uhaozu',
        game_name: 'WZRY',
        game_account: 'hpjy-a',
        publish_status: 'fail',
        fail_message: '其他游戏同账号错误'
    });
    const channelResult = await getPriceLadderChannelResultByUser(8, {
        game_name: '和平精英',
        game_account: 'hpjy-a'
    });
    assert.strictEqual(channelResult.current_tier, 2);
    assert.strictEqual(channelResult.channels.length, 3);
    assert.deepStrictEqual(channelResult.channels.find((item) => item.channel === 'zuhaowang').package_keys, ['hour', 'p24', 'p72', 'p168']);
    assert.strictEqual(channelResult.channel_result.baseline_status, 'default');
    assert.deepStrictEqual(channelResult.channel_result.tiers[1].prices, {
        hour: 3.5,
        night: 14,
        day: 21,
        week: 122.5
    });
    assert.strictEqual(channelResult.channel_result.adjustment_logs.length, 2);
    assert.strictEqual(channelResult.channel_result.adjustment_logs[0].publish_status, 'success');
    assert(/包夜价格/.test(channelResult.channel_result.adjustment_logs[1].fail_message));
    assert.strictEqual(channelResult.channel_result.adjustment_logs[1].error_detail.code, 'PRICE_RANGE');
    assert.strictEqual(channelResult.channel_result.apply_status, 'manual');

    for (let index = 1; index <= 25; index += 1) {
        await createPricePublishBatchLog({
            batch_id: `retention-${index}`,
            user_id: 8,
            channel: 'uhaozu',
            game_name: '和平精英',
            trigger_source: 'order_finished_changed',
            status: index % 2 === 0 ? 'success' : 'fail'
        });
        await createPricePublishItemLog({
            batch_id: `retention-${index}`,
            user_id: 8,
            channel: 'uhaozu',
            game_name: '和平精英',
            game_account: 'retention-account',
            publish_status: index % 2 === 0 ? 'success' : 'fail',
            fail_message: index % 2 === 0 ? '' : `failure-${index}`
        });
    }
    const retainedLogs = await listPricePublishItemLogsByAccount(8, {
        channel: 'uhaozu',
        game_name: '和平精英',
        game_account: 'retention-account',
        limit: 100
    });
    assert.strictEqual(retainedLogs.length, 20);
    assert.strictEqual(retainedLogs[0].batch_id, 'retention-25');
    assert.strictEqual(retainedLogs.at(-1).batch_id, 'retention-6');
    const retainedBatches = await listPricePublishBatchLogsByUser(8, {
        channel: 'uhaozu',
        game_name: '和平精英',
        page_size: 100
    });
    assert.strictEqual(retainedBatches.list.filter((item) => item.batch_id.startsWith('retention-')).length, 20);

    await seedAccount({ account: 'hpjy-incomplete', remark: '套餐缺失', price: 3, night: 0, day: 0, week: 0 });
    const incompleteSaved = await savePriceLadderRuleByUser(8, {
        game_name: '和平精英',
        game_account: 'hpjy-incomplete',
        prices: [3, 4, 5, 6],
        expected_version: 0
    }, saveOptions);
    assert.strictEqual(incompleteSaved.baseline_ready, false);
    const incompleteResult = await getPriceLadderChannelResultByUser(8, {
        game_name: '和平精英',
        game_account: 'hpjy-incomplete'
    });
    assert.strictEqual(incompleteResult.channel_result.baseline_status, 'default');
    assert.strictEqual(incompleteResult.channel_result.tiers.length, 4);
    assert.strictEqual(await getAccountPriceLadderRule(8, '2', 'missing'), null);
    assert.strictEqual((await listAccountPriceLadderRules(0, '2')).length, 0);
    assert.strictEqual((await listAccountPriceLadderRules(8, '')).length, 0);
    assert.strictEqual(await getAccountChannelPriceBaseline(0, '2', 'a', 'uhaozu'), null);
    assert.deepStrictEqual(await listPricePublishItemLogsByAccount(0, {}), []);
    await expectReject(() => saveAccountChannelPriceBaseline(0, {}), /user_id/);
    await expectReject(() => saveAccountChannelPriceBaseline(8, {}), /账号信息/);
    await expectReject(() => saveAccountChannelPriceBaseline(8, {
        game_id: '2', game_name: '和平精英', game_account: 'bad', channel: 'uhaozu', prices: { hour: 0 }
    }), /时租价/);
    await expectReject(() => saveAccountChannelPriceBaseline(8, {
        game_id: '2', game_name: '和平精英', game_account: 'bad', channel: 'uhaozu', prices: { hour: 2, night: -1 }
    }), /套餐价格/);
    await expectReject(() => getPriceLadderChannelResultByUser(8, {
        game_name: '和平精英', game_account: 'missing'
    }), /账号不存在/);

    const clearedA = await savePriceLadderRuleByUser(8, {
        game_name: '和平精英',
        game_account: 'hpjy-a',
        action: 'clear',
        expected_version: 2
    });
    assert.strictEqual(clearedA.configured, false);
    assert.strictEqual(await getAccountPriceLadderRule(8, '2', 'hpjy-a'), null);
    assert.strictEqual(await getAccountPriceLadderRuntime(8, '2', 'hpjy-a', 'uhaozu'), null);
    assert.strictEqual(await getAccountChannelPriceBaseline(8, '2', 'hpjy-a', 'uhaozu'), null);
    const afterClear = await getPriceLadderDashboardByUser(8, { game_name: '和平精英' });
    const clearedCard = afterClear.list.find((item) => item.game_account === 'hpjy-a');
    assert.strictEqual(clearedCard.configured, false);
    assert.deepStrictEqual(clearedCard.prices, ['', '', '', '']);
    assert.strictEqual((await listPricePublishItemLogsByAccount(8, {
        channel: 'uhaozu', game_name: '和平精英', game_account: 'hpjy-a', publish_status: 'fail'
    })).length, 1);

    const resavedA = await savePriceLadderRuleByUser(8, {
        game_name: '和平精英',
        game_account: 'hpjy-a',
        prices: [2.7, 3.7, 5.7, 10.7],
        expected_version: 0
    }, saveOptions);
    assert.strictEqual(resavedA.version, 1);
    assert.strictEqual(resavedA.baseline_created, true);
    const clearedAgain = await savePriceLadderRuleByUser(8, {
        game_name: '和平精英', game_account: 'hpjy-a', action: 'clear', expected_version: 1
    });
    assert.strictEqual(clearedAgain.configured, false);
    await expectReject(() => upsertAccountPriceLadderRule(0, {}), /user_id/);
    await expectReject(() => upsertAccountPriceLadderRule(8, { game_id: '2' }), /game_name/);
    await expectReject(() => upsertAccountPriceLadderRule(8, {
        game_id: '2', game_name: '和平精英', game_account: 'direct', prices: [1, 2, 3, 4]
    }, { expected_version: -1 }), /expected_version/);
    await expectReject(() => upsertAccountPriceLadderRule(8, {
        game_id: '2', game_name: '和平精英', game_account: 'direct', prices: [1, 2, 3, 4]
    }, { expected_version: 3 }), /配置已变化/);

    assert.strictEqual(serviceInternal.roundMoney(2.345), 2.35);
    assert.strictEqual(serviceInternal.roundMoney('bad'), 0);
    assert.strictEqual(serviceInternal.pickCurrentUhaozuPrice({ channel_prd_info: {} }), 0);
    assert.strictEqual(serviceInternal.pickUhaozuPriceSet({ channel_prd_info: {} }).complete, false);
    assert.deepStrictEqual(serviceInternal.buildUhaozuRatios({ hour: 2, night: 8, day: 12, week: 70 }), {
        hour: 1, night: 4, day: 6, week: 35
    });
    assert.strictEqual(serviceInternal.samePriceSet({ hour: 2 }, { hour: 2 }), true);
    assert.strictEqual(serviceInternal.samePriceSet({ hour: 2 }, { hour: 3 }), false);
    assert.strictEqual(serviceInternal.sanitizePublishLog({ fail_message: 'x'.repeat(600) }).fail_message.length, 500);
    assert.strictEqual(serviceInternal.isAvailableAccount({ asset_status: 'active' }), true);
    assert.strictEqual(serviceInternal.isAvailableAccount({ asset_status: 'sold' }), false);
    assert.deepStrictEqual(serviceInternal.normalizePrices([1, 2.222, 3, 4]), [1, 2.22, 3, 4]);
    assert.strictEqual(dbInternal.toRule({}).version, 0);
    assert(/\d{4}-\d{2}-\d{2}/.test(dbInternal.nowText()));
    assert.strictEqual(baselineDbInternal.toBaseline({}).version, 0);
    assert(/\d{4}-\d{2}-\d{2}/.test(baselineDbInternal.nowText()));

    console.log('[OK] account_price_ladder_smoke_test passed');
}

main().catch((err) => {
    console.error('[FAIL] account_price_ladder_smoke_test failed:', err);
    process.exit(1);
});
