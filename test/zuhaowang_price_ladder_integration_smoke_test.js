#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-zhw-ladder-integration-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.ORDER_DB_FILE_PATH = path.join(tempDir, 'rent_robot_order.db');
process.env.PRICE_DB_FILE_PATH = path.join(tempDir, 'rent_robot_price.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');
process.env.ORDER_COUNT_TRACE = 'false';

const { upsertUserGameAccount } = require('../database/user_game_account_db');
const { setPriceLadderFeatureEnabled } = require('../database/price_ladder_feature_config_db');
const { getAccountPriceLadderRuntime } = require('../database/account_price_ladder_runtime_db');
const { savePriceLadderRuleByUser } = require('../price/price_ladder_service');
const { savePackageRatioSettingsByUser } = require('../price/package_ratio_service');
const { reconcilePendingPriceLaddersByUser } = require('../price/price_ladder_reconcile_service');
const { _internal: orderInternal } = require('../database/order_db');

async function main() {
    const userId = 99;
    const account = 'zhw-ladder';
    await upsertUserGameAccount({
        user_id: userId,
        game_id: '1',
        game_name: 'WZRY',
        game_account: account,
        account_remark: '租号王阶梯账号',
        channel_prd_info: {
            zuhaowang: { prd_id: '90779045', game_id: '1104466820' }
        }
    });
    await setPriceLadderFeatureEnabled(userId, true, { expected_version: 0 });
    const firstRatio = await savePackageRatioSettingsByUser(userId, {
        channel: 'zuhaowang',
        ratios: { p24: 5, p72: 12, p168: 28 },
        expected_version: 0
    });
    assert.strictEqual(firstRatio.queued_count, 0);

    const calls = [];
    const publisher = async (_uid, input) => {
        calls.push(input);
        return { ok: true, changed: true, batch_id: `zhw-${calls.length}`, prices: input.prices };
    };
    const day = orderInternal.businessDateText(6);
    const now = new Date(`${day}T08:00:00`);
    const savedRule = await savePriceLadderRuleByUser(userId, {
        game_id: '1',
        game_name: 'WZRY',
        game_account: account,
        prices: [2, 2.2, 2.5, 3],
        expected_version: 0
    }, { now, publishers: { zuhaowang: publisher } });
    assert.strictEqual(savedRule.publish_result.applied, 1);
    assert.deepStrictEqual(calls[0].prices, { hour: 2, p24: 10, p72: 24, p168: 56 });

    const secondRatio = await savePackageRatioSettingsByUser(userId, {
        channel: 'zuhaowang',
        ratios: { p24: 6, p72: 14, p168: 30 },
        expected_version: 1
    });
    assert.strictEqual(secondRatio.queued_count, 1);
    assert.strictEqual(calls.length, 1);
    const pending = await getAccountPriceLadderRuntime(userId, '1', account, 'zuhaowang');
    assert.strictEqual(pending.status, 'pending');
    assert.strictEqual(pending.trigger_source, 'package_ratio_saved');

    const synced = await reconcilePendingPriceLaddersByUser(userId, {
        now,
        allow_apply: true,
        publishers: { zuhaowang: publisher }
    });
    assert.strictEqual(synced.applied, 1);
    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(calls[1].prices, { hour: 2, p24: 12, p72: 28, p168: 60 });
    assert.strictEqual(calls[1].force_publish, true);
    assert.strictEqual((await getAccountPriceLadderRuntime(userId, '1', account, 'zuhaowang')).status, 'applied');

    console.log('[OK] zuhaowang_price_ladder_integration_smoke_test passed');
}

main().catch((error) => {
    console.error('[FAIL] zuhaowang_price_ladder_integration_smoke_test failed:', error);
    process.exit(1);
});
