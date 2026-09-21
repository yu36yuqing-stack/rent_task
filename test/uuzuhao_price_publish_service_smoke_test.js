#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-uuzuhao-price-publish-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.PRICE_DB_FILE_PATH = path.join(tempDir, 'rent_robot_price.db');

const { createUserByAdmin } = require('../database/user_db');
const { upsertUserPlatformAuth } = require('../database/user_platform_auth_db');
const { upsertUserGameAccount, listUserGameAccounts } = require('../database/user_game_account_db');
const { listPricePublishItemLogsByBatchId } = require('../database/price_publish_log_db');
const {
    publishUuzuhaoAccountPriceSetByUser,
    _internals
} = require('../price/price_publish_service');

async function createAccountUser(account, withAuth = true) {
    const user = await createUserByAdmin({
        account: `uuzuhao_publish_${account}`,
        password: '123456',
        user_type: '内部',
        status: 'enabled'
    });
    if (withAuth) {
        await upsertUserPlatformAuth({
            user_id: user.id,
            platform: 'uuzuhao',
            auth_type: 'token',
            auth_payload: { app_key: 'fixture-key', app_secret: 'fixture-secret' },
            auth_status: 'valid'
        });
    }
    await upsertUserGameAccount({
        user_id: user.id,
        game_id: '2',
        game_name: '和平精英',
        game_account: account,
        account_remark: account,
        channel_prd_info: {
            uuzuhao: { prd_id: `product-${account}`, hourPrice: 2, minRentHour: 2 }
        }
    });
    return user;
}

async function main() {
    const user = await createAccountUser('publish-a');
    const queryRows = [
        { productId: 'product-publish-a', accountNo: 'publish-a', hourPrice: 2, minRentHour: 2 },
        { productId: 'product-publish-a', accountNo: 'publish-a', hourPrice: 3, minRentHour: 2 }
    ];
    const modifyCalls = [];
    const success = await publishUuzuhaoAccountPriceSetByUser(user.id, {
        game_id: '2',
        game_name: '和平精英',
        game_account: 'publish-a',
        tier: 2,
        prices: { hour: 3 },
        trigger_source: 'order_finished_changed'
    }, {
        query_product: async () => queryRows.shift(),
        modify_price: async (productId, input) => {
            modifyCalls.push({ productId, input });
            return {
                product_id: productId,
                hour_price: input.hourPrice,
                package_prices: { p2Price: 5.4 },
                raw: { code: 0, msg: '成功' }
            };
        }
    });
    assert.strictEqual(success.ok, true);
    assert.strictEqual(success.changed, true);
    assert.strictEqual(success.verification_status, 'partial');
    assert.deepStrictEqual(modifyCalls[0], {
        productId: 'product-publish-a',
        input: {
            hourPrice: 3,
            p2Price: 5.4,
            p3Price: 7.2,
            p5Price: 10.5,
            p7Price: 14.7,
            p9Price: 18.9,
            p10Price: 21,
            p24Price: 43.2,
            p168Price: 302.4,
            minRentHour: 2
        }
    });
    const successLogs = await listPricePublishItemLogsByBatchId(success.batch_id);
    assert.strictEqual(successLogs.length, 1);
    assert.strictEqual(successLogs[0].publish_status, 'success');
    assert.strictEqual(successLogs[0].request_data.target_prices.p2, 5.4);
    assert.strictEqual(successLogs[0].request_data.target_prices.p168, 302.4);
    assert.strictEqual(successLogs[0].response_data.verification_status, 'partial');
    const rows = await listUserGameAccounts(user.id, 1, 20);
    assert.strictEqual(rows.list[0].channel_prd_info.uuzuhao.hourPrice, 3);

    let unchangedModifyCount = 0;
    const unchanged = await publishUuzuhaoAccountPriceSetByUser(user.id, {
        game_id: '2',
        game_name: '和平精英',
        game_account: 'publish-a',
        prices: { hour: 3 }
    }, {
        query_product: async () => ({ productId: 'product-publish-a', hourPrice: 3, minRentHour: 2 }),
        modify_price: async () => { unchangedModifyCount += 1; }
    });
    assert.strictEqual(unchanged.changed, false);
    assert.strictEqual(unchanged.batch_id, '');
    assert.strictEqual(unchangedModifyCount, 0);

    const forcedRows = [
        { productId: 'product-publish-a', hourPrice: 3, minRentHour: 2 },
        { productId: 'product-publish-a', hourPrice: 3, minRentHour: 2 }
    ];
    const forced = await publishUuzuhaoAccountPriceSetByUser(user.id, {
        game_id: '2',
        game_name: '和平精英',
        game_account: 'publish-a',
        prices: { hour: 3 },
        trigger_source: 'daily_reset',
        force_publish: true
    }, {
        query_product: async () => forcedRows.shift(),
        modify_price: async (productId, input) => ({ product_id: productId, hour_price: input.hourPrice, raw: { code: 0 } })
    });
    assert.strictEqual(forced.changed, true);

    const platformError = new Error('code=4001, msg=套餐折扣超出限制');
    platformError.code = '4001';
    platformError.uuzuhao_response = { code: 4001, msg: '套餐折扣超出限制' };
    const failed = await publishUuzuhaoAccountPriceSetByUser(user.id, {
        game_id: '2',
        game_name: '和平精英',
        game_account: 'publish-a',
        prices: { hour: 4 }
    }, {
        query_product: async () => ({ productId: 'product-publish-a', hourPrice: 3, minRentHour: 2 }),
        modify_price: async () => { throw platformError; }
    });
    assert.strictEqual(failed.ok, false);
    assert.strictEqual(failed.error_detail.stage, 'modify');
    assert.strictEqual(failed.error_detail.channel_response.code, 4001);
    const failedLogs = await listPricePublishItemLogsByBatchId(failed.batch_id);
    assert.strictEqual(failedLogs[0].request_data.target_prices.p24, 57.6);
    assert.strictEqual(failedLogs[0].response_data.channel_response.msg, '套餐折扣超出限制');

    const noAuthUser = await createAccountUser('no-auth', false);
    const noAuth = await publishUuzuhaoAccountPriceSetByUser(noAuthUser.id, {
        game_id: '2',
        game_name: '和平精英',
        game_account: 'no-auth',
        prices: { hour: 2 }
    });
    assert.strictEqual(noAuth.ok, false);
    assert.strictEqual(noAuth.error_detail.stage, 'authorization');

    assert.deepStrictEqual(_internals.pickUuzuhaoProductPriceSet({ hourPrice: 2.345, minRentHour: 3 }), {
        hour: 2.35,
        min_rent_hour: 3
    });
    assert.strictEqual(_internals.pickUuzuhaoProductPriceSet({ productHourRentPrice: 4.8 }).hour, 4.8);
    assert.throws(() => _internals.normalizeUuzuhaoTargetPriceSet({ hour: 0 }), /目标时租价/);
    assert.strictEqual(_internals.normalizeUuzuhaoTargetPriceSet({
        hour: 2,
        p2: 3.8,
        p3: 5,
        p5: 8,
        p7: 11,
        p9: 14,
        p10: 15,
        p24: 30,
        p168: 210
    }).p2, 3.8);
    assert.strictEqual(_internals.isAuthRowUsable({
        platform: 'uuzuhao', auth_status: 'valid', channel_enabled: true
    }, 'uuzuhao'), true);
    assert.strictEqual(_internals.isAuthRowUsable({
        platform: 'uuzuhao', auth_status: 'valid', channel_enabled: false
    }, 'uuzuhao'), false);

    console.log('[OK] uuzuhao_price_publish_service_smoke_test passed');
}

main().catch((error) => {
    console.error('[FAIL] uuzuhao_price_publish_service_smoke_test failed:', error);
    process.exit(1);
});
