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
    publishUhaozuAccountPriceSetByUser,
    listPricePublishBatchLogsByUser,
    listPricePublishItemLogsByBatchId,
    _internals
} = require('../price/price_publish_service');

async function createPublishUser(account, suffix, channelInfo = {}) {
    const user = await createUserByAdmin({
        account,
        password: '123456',
        user_type: '内部',
        status: 'enabled',
        desc: 'price publish branch smoke'
    });
    await upsertUserPlatformAuth({
        user_id: user.id,
        platform: 'uhaozu',
        auth_type: 'cookie',
        auth_payload: { cookie: `JSESSIONID=${suffix}` },
        auth_status: 'valid',
        desc: 'price publish branch smoke'
    });
    await upsertUserGameAccount({
        user_id: user.id,
        game_account: `account-${suffix}`,
        game_id: '2',
        game_name: '和平精英',
        account_remark: suffix,
        channel_prd_info: { uhaozu: channelInfo }
    });
    await updateUserGameAccountTotalCostByUserAndAccount(user.id, `account-${suffix}`, 2000, 'price publish branch smoke', '2', '和平精英');
    await saveUhaozuPricingConfigByUser(user.id, {
        game_name: '和平精英',
        payback_days: 240,
        avg_daily_rent_hours: 3.5,
        platform_fee_rate: 0.2,
        withdrawal_fee_rate: 0.02,
        price_step: 0.3,
        deposit: 100
    });
    return user;
}

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
    let fetchMode = 'success';
    let modifiedPrices = null;
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
                            rentalByHour: modifiedPrices && fetchMode !== 'readback_mismatch' ? modifiedPrices.rentalByHour * 100 : 400,
                            rentalByNight: fetchMode === 'incomplete'
                                ? 0
                                : (modifiedPrices && fetchMode !== 'readback_mismatch' ? modifiedPrices.rentalByNight * 100 : 1600),
                            rentalByDay: modifiedPrices && fetchMode !== 'readback_mismatch' ? modifiedPrices.rentalByDay * 100 : 2400,
                            rentalByWeek: modifiedPrices && fetchMode !== 'readback_mismatch' ? modifiedPrices.rentalByWeek * 100 : 16000,
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
            if (fetchMode === 'platform_error') {
                return {
                    ok: true,
                    status: 200,
                    text: async () => JSON.stringify({
                        success: false,
                        responseCode: 'PRICE_RANGE',
                        responseMsg: '包夜价格超出允许范围'
                    })
                };
            }
            modifiedPrices = JSON.parse(String(options.body || '{}')).info || null;
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
        assert.strictEqual(Number((((hit.channel_prd_info || {}).uhaozu || {}).deposit || 0)), 3);
        assert.strictEqual(captured.length, 4);
        const modifyHit = captured.find((row) => String(row.url || '').includes('/merchants/goods/modify/'));
        assert(modifyHit);
        const modifyReq = JSON.parse(modifyHit.body || '{}');
        assert.strictEqual(Number((((modifyReq || {}).info || {}).deposit || 0)), 3);
        assert.strictEqual(Number((((modifyReq || {}).info || {}).rentalByNight || 0)), 19.2);
        assert.strictEqual(Number((((modifyReq || {}).info || {}).rentalByDay || 0)), 28.8);
        assert.strictEqual(Number((((modifyReq || {}).info || {}).rentalByWeek || 0)), 192);
        const batchLogs = await listPricePublishBatchLogsByUser(1, { channel: 'uhaozu', page: 1, page_size: 10 });
        assert.strictEqual(batchLogs.total, 1);
        assert.strictEqual(String(batchLogs.list[0].batch_id || ''), String(out.batch_id || ''));
        assert.strictEqual(String(batchLogs.list[0].status || ''), 'success');
        const itemLogs = await listPricePublishItemLogsByBatchId(out.batch_id);
        assert.strictEqual(itemLogs.length, 1);
        assert.strictEqual(String(itemLogs[0].publish_status || ''), 'success');
        assert.strictEqual(Number(itemLogs[0].price_target_hour || 0), 4.8);
        assert.strictEqual(Number(itemLogs[0].price_target_night || 0), 19.2);
        assert.ok(itemLogs[0].before_data);
        assert.ok(itemLogs[0].request_data);
        assert.ok(itemLogs[0].response_data);
        assert.ok(itemLogs[0].after_data);

        fetchMode = 'success';
        modifiedPrices = null;
        const ladderOut = await publishUhaozuAccountPriceSetByUser(1, {
            game_id: '2',
            game_name: '和平精英',
            game_account: '10001',
            tier: 2,
            prices: { hour: 3, night: 10, day: 14, week: 75 },
            trigger_source: 'price_ladder_test'
        });
        assert.strictEqual(ladderOut.ok, true);
        assert.deepStrictEqual(ladderOut.prices, {
            rentalByHour: 3,
            rentalByNight: 10,
            rentalByDay: 14,
            rentalByWeek: 75
        });
        const ladderLogs = await listPricePublishItemLogsByBatchId(ladderOut.batch_id);
        assert.strictEqual(ladderLogs.length, 1);
        assert.strictEqual(ladderLogs[0].publish_status, 'success');
        assert.strictEqual(Number(ladderLogs[0].price_target_week || 0), 75);

        fetchMode = 'platform_error';
        modifiedPrices = null;
        const ladderFailed = await publishUhaozuAccountPriceSetByUser(1, {
            game_id: '2',
            game_name: '和平精英',
            game_account: '10001',
            tier: 3,
            prices: { hour: 4, night: 12, day: 18, week: 90 }
        });
        assert.strictEqual(ladderFailed.ok, false);
        assert(/包夜价格/.test(ladderFailed.message));
        const ladderFailedLogs = await listPricePublishItemLogsByBatchId(ladderFailed.batch_id);
        assert.strictEqual(ladderFailedLogs[0].publish_status, 'fail');

        const missingGoodsUser = await createPublishUser('price_publish_missing_goods', 'missing-goods', {
            rentalByHour: 4
        });
        const missingGoodsOut = await publishUhaozuPricingByUser(missingGoodsUser.id, { game_name: '和平精英' });
        assert.strictEqual(missingGoodsOut.success_count, 0);
        assert.strictEqual(missingGoodsOut.fail_count, 1);
        assert.strictEqual(missingGoodsOut.list[0].message, '缺少 U号租商品ID');

        const incompleteUser = await createPublishUser('price_publish_incomplete', 'incomplete', {
            prd_id: '1132393092',
            rentalByHour: 4
        });
        fetchMode = 'incomplete';
        modifiedPrices = null;
        const incompleteOut = await publishUhaozuPricingByUser(incompleteUser.id, { game_name: '和平精英' });
        assert.strictEqual(incompleteOut.fail_count, 1);
        assert(/rentalByNight/.test(incompleteOut.list[0].message));
        const incompleteLogs = await listPricePublishItemLogsByBatchId(incompleteOut.batch_id);
        assert(incompleteLogs[0].before_data);
        assert.strictEqual(incompleteLogs[0].request_data, null);

        const rejectedUser = await createPublishUser('price_publish_rejected', 'rejected', {
            prd_id: '1132393093',
            rentalByHour: 4
        });
        fetchMode = 'platform_error';
        modifiedPrices = null;
        const rejectedOut = await publishUhaozuPricingByUser(rejectedUser.id, { game_name: '和平精英' });
        assert.strictEqual(rejectedOut.fail_count, 1);
        assert(/包夜价格超出允许范围/.test(rejectedOut.list[0].message));
        const rejectedLogs = await listPricePublishItemLogsByBatchId(rejectedOut.batch_id);
        assert(rejectedLogs[0].request_data);
        assert.strictEqual(Number(rejectedLogs[0].price_target_night || 0) > 0, true);

        const mismatchUser = await createPublishUser('price_publish_mismatch', 'mismatch', {
            prd_id: '1132393094',
            rentalByHour: 4
        });
        fetchMode = 'readback_mismatch';
        modifiedPrices = null;
        const mismatchOut = await publishUhaozuPricingByUser(mismatchUser.id, { game_name: '和平精英' });
        assert.strictEqual(mismatchOut.fail_count, 1);
        assert(/回读不一致/.test(mismatchOut.list[0].message));
        const mismatchLogs = await listPricePublishItemLogsByBatchId(mismatchOut.batch_id);
        assert(mismatchLogs[0].after_data);
        assert.strictEqual(Number(mismatchLogs[0].price_after_hour || 0), 4);

        const noAuthUser = await createUserByAdmin({
            account: 'price_publish_no_auth',
            password: '123456',
            user_type: '内部',
            status: 'enabled'
        });
        await assert.rejects(
            () => publishUhaozuPricingByUser(noAuthUser.id, { game_name: '和平精英' }),
            /没有可用/
        );
        await assert.rejects(() => publishUhaozuPricingByUser(0), /user_id/);
        await assert.rejects(() => publishUhaozuAccountPriceSetByUser(0), /user_id/);
        await assert.rejects(() => publishUhaozuAccountPriceSetByUser(1, {}), /账号信息/);
        await assert.rejects(() => publishUhaozuAccountPriceSetByUser(1, {
            game_id: '2', game_name: '和平精英', game_account: '10001', prices: { hour: 2 }
        }), /不完整/);
        assert.throws(() => _internals.deriveUhaozuPackagePriceSet(0, {}), /目标时租价/);
        assert.throws(() => _internals.deriveUhaozuPackagePriceSet(2, {}), /当前时租价/);
        assert.throws(() => _internals.deriveUhaozuPackagePriceSet(2, {
            rentalByHour: 2,
            rentalByNight: 0,
            rentalByDay: 12,
            rentalByWeek: 70
        }), /rentalByNight/);
        assert.strictEqual(_internals.isAuthRowUsable(null), false);
        assert.strictEqual(_internals.isAuthRowUsable({ platform: 'zuhaowang', auth_status: 'valid' }), false);
        assert.strictEqual(_internals.isAuthRowUsable({ platform: 'uhaozu', auth_status: 'expired' }), false);
        assert.strictEqual(_internals.isAuthRowUsable({
            platform: 'uhaozu', auth_status: 'valid', expire_at: 'not-a-date'
        }), true);
        assert.strictEqual(_internals.isAuthRowUsable({
            platform: 'uhaozu', auth_status: 'valid', expire_at: '2000-01-01T00:00:00Z'
        }), false);
        assert.strictEqual(_internals.randomDelayMs(-1, -2), 0);
        assert.strictEqual(_internals.pickPriceFields(null).rentalByHour, 0);
        assert.strictEqual(_internals.samePublishPriceSet({ rentalByHour: 2 }, { rentalByHour: 2 }), true);
        assert.strictEqual(_internals.samePublishPriceSet({ rentalByHour: 2 }, { rentalByHour: 3 }), false);
        assert.deepStrictEqual(_internals.normalizeUhaozuTargetPriceSet({
            hour: 2.345, night: 8, day: 12, week: 70
        }), {
            rentalByHour: 2.35,
            rentalByNight: 8,
            rentalByDay: 12,
            rentalByWeek: 70
        });
        assert.deepStrictEqual(_internals.sanitizePriceLogPayload({
            cookie: 'secret',
            info: { gamePassword: '123456', rentalByHour: 2 },
            rows: [{ mobile: '13800000000' }]
        }), {
            cookie: '[redacted]',
            info: { gamePassword: '[redacted]', rentalByHour: 2 },
            rows: [{ mobile: '[redacted]' }]
        });
        assert.ok(_internals.buildPublishBatchId(2, '').includes('_2_'));
        await _internals.sleep(0);
        console.log('[OK] price_publish_service_smoke_test passed');
    } finally {
        global.fetch = originalFetch;
    }
})().catch((err) => {
    console.error('[FAIL] price_publish_service_smoke_test failed:', err);
    process.exit(1);
});
