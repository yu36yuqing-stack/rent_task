#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-five-e-product-sync-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');
process.env.ORDER_DB_FILE_PATH = path.join(tempDir, 'rent_robot_order.db');
process.env.STATS_DB_FILE_PATH = path.join(tempDir, 'rent_robot_stats.db');
process.env.PRICE_DB_FILE_PATH = path.join(tempDir, 'rent_robot_price.db');

const fiveEApi = require('../5e_platfrom/5e_api');
const orderRuleService = require('../order/service/order_rule_service');
const orderQueryService = require('../order/service/order_query_service');
const { upsertUserPlatformAuth, listUserPlatformAuth } = require('../database/user_platform_auth_db');
const { upsertUserGameAccount, listUserGameAccounts } = require('../database/user_game_account_db');

async function main() {
    const uid = 8;
    await upsertUserPlatformAuth({
        user_id: uid,
        platform: '5e',
        auth_type: 'token',
        auth_payload: { token: 'five-e-test-token' },
        auth_status: 'valid',
        expire_at: '2099-01-01 00:00:00',
        channel_enabled: true,
        desc: '5e product sync smoke'
    });
    await upsertUserGameAccount({
        user_id: uid,
        game_account: 'jorjinagorohov169',
        game_id: '4',
        game_name: 'CSGO',
        account_remark: 'existing csgo account',
        channel_status: { uuzuhao: '上架' },
        channel_prd_info: { uuzuhao: { prd_id: 'uuzuhao-1' } },
        desc: 'existing csgo card'
    });

    const originals = {
        listAllRentAccounts: fiveEApi.listAllRentAccounts,
        releaseOrderCooldownBlacklistByUser: orderRuleService.releaseOrderCooldownBlacklistByUser,
        listLinkedOrderAccountsByUser: orderQueryService.listLinkedOrderAccountsByUser
    };
    fiveEApi.listAllRentAccounts = async (auth) => {
        assert.strictEqual(auth.token, 'five-e-test-token');
        return {
            total: 1,
            list: [{
                id: '8086',
                account_id: 'CS5819323392',
                steam_id: '76561199407966750',
                steam_account: 'jorjinagorohov169',
                remark: '5e remark',
                shelf_status: 'on_shelf',
                shelf_status_raw: 1,
                rent_status: 'idle',
                rent_status_raw: 0,
                channel_divide: 30,
                account_value: '21347',
                finished_order_count: 4,
                income_amount: '7.8',
                created_at: '2026-07-23 19:39:09'
            }]
        };
    };
    orderRuleService.releaseOrderCooldownBlacklistByUser = async () => ({ skipped: true, reason: 'stub' });
    orderQueryService.listLinkedOrderAccountsByUser = async () => [];

    delete require.cache[require.resolve('../product/product')];
    const { syncUserAccountsByAuth } = require('../product/product');
    const out = await syncUserAccountsByAuth(uid);
    assert.strictEqual(out.ok, true);
    assert.deepStrictEqual(out.platforms, ['5e']);
    assert.strictEqual(out.pulled['5e'], 1);

    const accounts = await listUserGameAccounts(uid, 1, 20, { game_name: 'CSGO' });
    assert.strictEqual(accounts.list.length, 1, '5E商品应合并到原有CSGO主档，不能新增重复卡片');
    const account = accounts.list[0];
    assert.strictEqual(account.game_account, 'jorjinagorohov169');
    assert.strictEqual(account.channel_status['5e'], '上架');
    assert.strictEqual(account.channel_status.uuzuhao, '上架');
    assert.strictEqual(account.channel_prd_info['5e'].account_no, 'CS5819323392');
    assert.strictEqual(account.channel_prd_info['5e'].steam_id, '76561199407966750');
    assert.strictEqual(Object.prototype.hasOwnProperty.call(account.channel_prd_info['5e'], 'token_email_or_mafile'), false);

    const authRows = await listUserPlatformAuth(uid, { with_payload: false });
    assert.strictEqual(authRows[0].platform, '5e');

    fiveEApi.listAllRentAccounts = originals.listAllRentAccounts;
    orderRuleService.releaseOrderCooldownBlacklistByUser = originals.releaseOrderCooldownBlacklistByUser;
    orderQueryService.listLinkedOrderAccountsByUser = originals.listLinkedOrderAccountsByUser;
    delete require.cache[require.resolve('../product/product')];

    console.log(`[PASS] five_e_product_sync_smoke_test temp_dir=${tempDir}`);
}

main().catch((error) => {
    console.error(`[FAIL] five_e_product_sync_smoke_test: ${error.message}`);
    process.exit(1);
});
