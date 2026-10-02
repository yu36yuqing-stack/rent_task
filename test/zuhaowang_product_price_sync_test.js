'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-zhw-product-price-'));
for (const [env, file] of Object.entries({ MAIN_DB_FILE_PATH: 'main.db', RUNTIME_DB_FILE_PATH: 'runtime.db',
    ORDER_DB_FILE_PATH: 'order.db', STATS_DB_FILE_PATH: 'stats.db', PRICE_DB_FILE_PATH: 'price.db' })) process.env[env] = path.join(tempDir, file);
process.env.ORDER_COUNT_TRACE = 'false';

const api = require('../zuhaowang/zuhaowang_api');
const authDb = require('../database/user_platform_auth_db');
const orderRules = require('../order/service/order_rule_service');
const orderQuery = require('../order/service/order_query_service');
const accountDb = require('../database/user_game_account_db');
let goods = [];
let enabled = true;
let goodsCalls = 0;
let loadFailure = false;
let goodsFailure = false;
const originalList = accountDb.listUserGameAccounts;
accountDb.listUserGameAccounts = (...args) => loadFailure ? Promise.reject(new Error('fixture read failure')) : originalList(...args);
api.getGoodsList = async () => {
    goodsCalls += 1;
    if (goodsFailure) throw new Error('fixture API failure');
    return goods;
};
authDb.listUserPlatformAuth = async () => [{ platform: 'zuhaowang', channel_enabled: enabled,
    auth_status: 'valid', auth_payload: { token_yuanbao: 'fixture', device_id: 'fixture', package_name: 'fixture' } }];
orderRules.releaseOrderCooldownBlacklistByUser = async () => ({ skipped: true, reason: 'fixture' });
orderQuery.listLinkedOrderAccountsByUser = async () => [];
const { syncUserAccountsByAuth } = require('../product/product');
const { publishZuhaowangAccountPriceSetByUser } = require('../price/price_publish_service');
const { getProductChannelPriceSummaries } = require('../price/product_channel_price_service');
const { listPricePublishItemLogsByBatchId } = require('../database/price_publish_log_db');
const { upsertAccountPriceLadderRuntime } = require('../database/account_price_ladder_runtime_db');
const uid = 31;
const identity = { user_id: uid, game_id: '1', game_name: 'WZRY', game_account: 'account-A' };
const template = (hour) => ({ accountInfo: { priceTemplateType: 1 }, selfTemplate: {
    shortRent: { isOpen: true, obtainPrice: hour, minHours: [], discounts: [] },
    longRent: { isOpen: true, grades: [{ key: '24', currentObtainPrice: hour * 5 },
        { key: '72', currentObtainPrice: hour * 15 }, { key: '168', currentObtainPrice: hour * 35 }] }
} });
const row = (overrides = {}) => ({ id: 'same-product', gameId: '1', gameName: 'WZRY', account: 'account-A',
    status: '下架', rawStatus: -1, roleName: 'fresh-role', exceptionMsg: '', ...overrides });
const read = async (userId = uid, gameId = '1') => (await originalList(userId, 1, 200)).list.find((account) =>
    account.game_id === gameId && account.game_account === 'account-A');
const seed = async (extra = {}) => accountDb.upsertUserGameAccount({ ...identity,
    channel_status: { zuhaowang: '上架', uuzuhao: '上架' },
    channel_prd_info: { zuhaowang: { prd_id: 'same-product', exception_msg: 'old-auth-error' },
        uuzuhao: { prd_id: 'unchanged', hourPrice: 99 } }, ...extra });

async function main() {
    await seed();
    let templateCalls = 0;
    let modifyCalls = 0;
    const published = await publishZuhaowangAccountPriceSetByUser(uid, { ...identity,
        tier: 2, prices: { hour: 3.6, p24: 18, p72: 54, p168: 126 }, force_publish: true }, {
        auth: { token_yuanbao: 'fixture', device_id: 'fixture', package_name: 'fixture' },
        get_template: async () => template(++templateCalls === 1 ? 2 : 3.6),
        change_template: async () => { modifyCalls += 1; return { code: '0', desc: 'ok' }; }
    });
    assert(published.ok);
    await upsertAccountPriceLadderRuntime(uid, { game_id: '1', game_name: 'WZRY', game_account: 'account-A',
        channel: 'zuhaowang', applied_tier: 2, desired_tier: 2, status: 'applied' });
    assert.strictEqual((await read()).channel_prd_info.zuhaowang.hourPrice, 3.6);
    const publishLogs = await listPricePublishItemLogsByBatchId(published.batch_id);
    assert.strictEqual(publishLogs[0].response_data.verification_status, 'full');

    // Same account/product in different users and games must never supply each other's prices.
    await seed({ user_id: uid + 1, channel_prd_info: { zuhaowang: { prd_id: 'same-product', hourPrice: 88 } } });
    await seed({ game_id: '2', game_name: '和平精英', channel_prd_info: { zuhaowang: { prd_id: 'same-product', hourPrice: 77 } } });
    goods = [row()];
    for (let repeat = 0; repeat < 2; repeat += 1) {
        const result = await syncUserAccountsByAuth(uid);
        assert.strictEqual(result.ok, true);
        const account = await read();
        assert.strictEqual(account.channel_prd_info.zuhaowang.hourPrice, 3.6);
        assert.strictEqual(account.channel_prd_info.zuhaowang.p24Price, 18);
        assert.strictEqual(account.channel_prd_info.zuhaowang.p72Price, 54);
        assert.strictEqual(account.channel_prd_info.zuhaowang.p168Price, 126);
        assert.strictEqual(account.channel_prd_info.zuhaowang.exception_msg, '');
        assert.strictEqual(account.channel_prd_info.zuhaowang.remark, 'fresh-role');
        assert.strictEqual(account.channel_status.zuhaowang, '下架');
        assert.strictEqual(account.channel_prd_info.uuzuhao.hourPrice, 99);
        assert.deepStrictEqual((await getProductChannelPriceSummaries(uid, [account]))['1::account-A'].zuhaowang,
            { current_tier: 2, hour_price: 3.6 });
    }
    assert.strictEqual(templateCalls, 2, 'sync must not query price templates');
    assert.strictEqual(modifyCalls, 1, 'sync must not publish prices');
    assert.strictEqual((await read(uid + 1)).channel_prd_info.zuhaowang.hourPrice, 88);
    assert.strictEqual((await read(uid, '2')).channel_prd_info.zuhaowang.hourPrice, 77);
    assert.deepStrictEqual(await listPricePublishItemLogsByBatchId(published.batch_id), publishLogs);

    goods = [row({ rent_mode: 'day_only', hourPrice: 0, p24Price: 20 })];
    await syncUserAccountsByAuth(uid);
    assert.strictEqual((await read()).channel_prd_info.zuhaowang.hourPrice, 3.6);
    assert.strictEqual((await read()).channel_prd_info.zuhaowang.rent_mode, 'day_only');
    assert.strictEqual((await read()).channel_prd_info.zuhaowang.p24Price, 20);
    goods = [row({ hour_price: 2.5 })];
    await syncUserAccountsByAuth(uid);
    assert.strictEqual((await read()).channel_prd_info.zuhaowang.hourPrice, 2.5);
    loadFailure = true;
    await assert.rejects(() => syncUserAccountsByAuth(uid), /fixture read failure/);
    loadFailure = false;
    assert.strictEqual((await read()).channel_prd_info.zuhaowang.hourPrice, 2.5);

    goods = [row({ id: 'replacement-product' })];
    await syncUserAccountsByAuth(uid);
    assert.strictEqual((await read()).channel_prd_info.zuhaowang.hourPrice, undefined);
    assert.strictEqual((await read()).channel_prd_info.zuhaowang.rent_mode, undefined);
    goods = [row({ id: 'replacement-product', hourPrice: 4.2 })];
    await syncUserAccountsByAuth(uid);
    assert.strictEqual((await read()).channel_prd_info.zuhaowang.hourPrice, 4.2);
    goodsFailure = true;
    const failedPull = await syncUserAccountsByAuth(uid);
    assert.strictEqual(failedPull.ok, false);
    assert.strictEqual(failedPull.upserted, 0);
    assert(failedPull.errors.some((error) => error.includes('fixture API failure')));
    assert.strictEqual((await read()).channel_prd_info.zuhaowang.hourPrice, 4.2);
    goodsFailure = false;
    goods = [row({ account: 'brand-new', id: 'brand-new-product' })];
    await syncUserAccountsByAuth(uid);
    const brandNew = (await originalList(uid, 1, 200)).list.find((account) => account.game_account === 'brand-new');
    assert.strictEqual(brandNew.channel_prd_info.zuhaowang.hourPrice, undefined);
    const { openMainDatabase } = require('../database/sqlite_client');
    const db = openMainDatabase();
    await new Promise((resolve, reject) => db.run('UPDATE user_game_account SET is_deleted = 1, manual_deleted = 1 WHERE user_id = ? AND game_account = ?',
        [uid, 'brand-new'], (error) => error ? reject(error) : resolve()));
    await new Promise((resolve) => db.close(resolve));
    const skippedDeleted = await syncUserAccountsByAuth(uid);
    assert.strictEqual(skippedDeleted.upserted, 0);
    assert.strictEqual((await originalList(uid, 1, 200)).list.some((account) => account.game_account === 'brand-new'), false);
    const before = goodsCalls;
    enabled = false;
    const disabled = await syncUserAccountsByAuth(uid);
    assert.strictEqual(disabled.skipped, true);
    assert.strictEqual(goodsCalls, before);
    console.log('[PASS] zuhaowang product sync: publish/readback -> snapshot -> repeated sync -> product summary; identity, day-only, invalid prices and disabled channel');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
