'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-price-publish-'));
process.env.MAIN_DB_FILE_PATH = path.join(tmpDir, 'rent_robot.db');
process.env.PRICE_DB_FILE_PATH = path.join(tmpDir, 'rent_robot_price.db');

const { initUserDb, createUserByAdmin } = require('../database/user_db');
const { upsertUserPlatformAuth } = require('../database/user_platform_auth_db');
const {
    initUserGameAccountDb,
    upsertUserGameAccount,
    updateUserGameAccountTotalCostByUserAndAccount,
    listUserGameAccounts
} = require('../database/user_game_account_db');
const { saveUhaozuPricingConfigByUser } = require('../price/price_rule_service');
const {
    publishUhaozuPricingByUser,
    listPricePublishBatchLogsByUser,
    listPricePublishItemLogsByBatchId
} = require('../price/price_publish_service');

(async () => {
    await initUserDb();
    await createUserByAdmin({
        account: 'price_publish_smoke',
        password: '123456',
        user_type: '内部',
        status: 'enabled',
        desc: 'price publish smoke'
    });
    await initUserGameAccountDb();

    await upsertUserPlatformAuth({
        user_id: 1,
        platform: 'uhaozu',
        auth_type: 'cookie',
        auth_payload: {
            cookie: 'JSESSIONID=abc; uid=xyz'
        },
        auth_status: 'valid',
        desc: 'price publish smoke'
    });

    await upsertUserGameAccount({
        user_id: 1,
        game_account: '10001',
        game_id: '2',
        game_name: '和平精英',
        account_remark: 'smoke',
        channel_prd_info: {
            uhaozu: {
                prd_id: '1132393091',
                rentalByHour: 4
            }
        }
    });
    await updateUserGameAccountTotalCostByUserAndAccount(1, '10001', 3000, 'price publish smoke', '2', '和平精英');
    await saveUhaozuPricingConfigByUser(1, {
        game_name: '和平精英',
        payback_days: 240,
        avg_daily_rent_hours: 3.5,
        platform_fee_rate: 0.2,
        withdrawal_fee_rate: 0.02,
        price_step: 0.3,
        deposit: 100
    });

    const originalFetch = global.fetch;
    const captured = [];
    global.fetch = async (url, options = {}) => {
        captured.push({ url: String(url || ''), body: String(options.body || '') });
        if (String(url).includes('/api/goods/modify/query/')) {
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({
                    success: true,
                    responseCode: '0000',
                    responseMsg: 'success',
                    object: {
                        goods: {
                            goodsId: 1132393091,
                            gameId: 'A2706',
                            gameAccount: '10001',
                            gameRoleName: 'smoke',
                            rentalByHour: 400,
                            rentalByNight: 1600,
                            rentalByDay: 2400,
                            rentalByWeek: 16000,
                            deposit: 300
                        },
                        options: [],
                        urls: [],
                        goodsDiscountOptions: [],
                        rentDiscountOptions: [],
                        authSource: 'LB',
                        mode: 0,
                        randStr: 'RAND',
                        authVersion: 2
                    }
                })
            };
        }
        if (String(url).includes('/merchants/goods/modify/')) {
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({
                    success: true,
                    responseCode: '0000',
                    responseMsg: 'success',
                    object: { goodsId: 1132393091 }
                })
            };
        }
        throw new Error(`unexpected url: ${url}`);
    };

    try {
        const out = await publishUhaozuPricingByUser(1, { game_name: '和平精英', deposit: 66 });
        assert.strictEqual(out.success_count, 1);
        assert.strictEqual(out.fail_count, 0);
        assert.ok(String(out.batch_id || '').startsWith('uhaozu_1_'));
        assert.strictEqual(Number(out.list[0].current_listing_hourly_price || 0), 4.8);
        const rows = await listUserGameAccounts(1, 1, 20);
        const hit = (rows.list || []).find((x) => String(x.game_account || '') === '10001');
        assert(hit);
        assert.strictEqual(Number((((hit.channel_prd_info || {}).uhaozu || {}).rentalByHour || 0)), 4.8);
        assert.strictEqual(Number((((hit.channel_prd_info || {}).uhaozu || {}).deposit || 0)), 66);
        assert.strictEqual(captured.length, 4);
        const modifyHit = captured.find((row) => String(row.url || '').includes('/merchants/goods/modify/'));
        assert(modifyHit);
        const modifyReq = JSON.parse(modifyHit.body || '{}');
        assert.strictEqual(Number((((modifyReq || {}).info || {}).deposit || 0)), 66);
        const batchLogs = await listPricePublishBatchLogsByUser(1, { channel: 'uhaozu', page: 1, page_size: 10 });
        assert.strictEqual(batchLogs.total, 1);
        assert.strictEqual(String(batchLogs.list[0].batch_id || ''), String(out.batch_id || ''));
        assert.strictEqual(String(batchLogs.list[0].status || ''), 'success');
        const itemLogs = await listPricePublishItemLogsByBatchId(out.batch_id);
        assert.strictEqual(itemLogs.length, 1);
        assert.strictEqual(String(itemLogs[0].publish_status || ''), 'success');
        assert.strictEqual(Number(itemLogs[0].price_target_hour || 0), 4.8);
        assert.ok(itemLogs[0].before_data);
        assert.ok(itemLogs[0].request_data);
        assert.ok(itemLogs[0].response_data);
        assert.ok(itemLogs[0].after_data);
        console.log('[OK] price_publish_service_smoke_test passed');
    } finally {
        global.fetch = originalFetch;
    }
})().catch((err) => {
    console.error('[FAIL] price_publish_service_smoke_test failed:', err);
    process.exit(1);
});
