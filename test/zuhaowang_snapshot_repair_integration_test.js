'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-zhw-snapshot-repair-'));
for (const [env, file] of Object.entries({ MAIN_DB_FILE_PATH: 'main.db', PRICE_DB_FILE_PATH: 'price.db',
    RUNTIME_DB_FILE_PATH: 'runtime.db', ORDER_DB_FILE_PATH: 'order.db', STATS_DB_FILE_PATH: 'stats.db' })) process.env[env] = path.join(dir, file);
process.env.ORDER_COUNT_TRACE = 'false';
const db = require('../database/user_game_account_db');
const logDb = require('../database/price_publish_log_db');
const originalUpsert = db.upsertUserGameAccount;
let failWrite = false;
db.upsertUserGameAccount = (...args) => failWrite ? Promise.reject(new Error('fixture snapshot write failed')) : originalUpsert(...args);
const originalLogs = logDb.listLatestSuccessfulPriceSnapshotsByUser;
let historyLoads = 0;
let failHistory = false;
logDb.listLatestSuccessfulPriceSnapshotsByUser = (...args) => {
    historyLoads += 1;
    return failHistory ? Promise.reject(new Error('fixture history read failed')) : originalLogs(...args);
};
let enabled = true;
const auth = { token_yuanbao: 'fixture', device_id: 'fixture', package_name: 'fixture' };
require('../database/user_platform_auth_db').listUserPlatformAuth = async () => [
    { platform: 'zuhaowang', channel_enabled: enabled, auth_status: 'valid', auth_payload: auth }
];
require('../order/service/order_rule_service').releaseOrderCooldownBlacklistByUser = async () => ({ skipped: true });
require('../order/service/order_query_service').listLinkedOrderAccountsByUser = async () => [];
let goods = [];
let goodsCalls = 0;
require('../zuhaowang/zuhaowang_api').getGoodsList = async () => { goodsCalls += 1; return goods; };
const { publishZuhaowangAccountPriceSetByUser: publish } = require('../price/price_publish_service');
const { syncUserAccountsByAuth: sync } = require('../product/product');
const { getProductChannelPriceSummaries: summarize } = require('../price/product_channel_price_service');
const { upsertAccountPriceLadderRuntime: runtime } = require('../database/account_price_ladder_runtime_db');
const zhwAdapter = require('../price/channel_adapters/zuhaowang_price_adapter');
const identity = { user_id: 8, game_id: '1', game_name: 'WZRY', game_account: '2571775932' };
const prices = (hour) => ({ hour, p24: hour * 6, p72: hour * 15, p168: hour * 40 });
const template = (p, day = true) => ({ accountInfo: { priceTemplateType: 1 }, selfTemplate: {
    shortRent: { isOpen: !day, obtainPrice: day ? 3.4 : p.hour, minHours: [], discounts: [] },
    longRent: { isOpen: true, grades: ['p24', 'p72', 'p168'].map((key) => ({ key: key.slice(1), currentObtainPrice: p[key] })) }
} });
const seed = (info, extra = {}) => originalUpsert({ ...identity, ...extra, channel_prd_info: {
    zuhaowang: { prd_id: '90738958', exception_msg: 'old-error', ...info },
    uuzuhao: { prd_id: 'other-channel', hourPrice: 99 }
} });
const read = async () => (await db.listUserGameAccounts(8, 1, 200)).list.find((row) => row.game_id === '1' && row.game_account === identity.game_account);
let templateCalls = 0;
let changeCalls = 0;
const callPublish = (target, templates, force = true) => publish(8, { ...identity, prices: target, force_publish: force }, {
    auth, get_template: async () => { templateCalls += 1; return templates.shift(); },
    change_template: async (request) => { changeCalls += 1; assert.strictEqual(request.selfTemplate.shortRent, null); return { code: '0' }; }
});

async function main() {
    await seed({ hourPrice: 3.4, rent_mode: 'day_only' });
    for (const hour of [3.2, 2.5, 3.6]) {
        const result = await callPublish(prices(hour), [template(prices(4)), template(prices(hour))]);
        assert.strictEqual(result.ok, true);
        const row = await read();
        assert.strictEqual(row.channel_prd_info.zuhaowang.hourPrice, 3.4, 'keep the last known actual quote separately');
        assert.strictEqual(row.channel_prd_info.zuhaowang.hour_basis, hour);
        const activePrices = zhwAdapter.pickCurrentPriceSet(row);
        assert.strictEqual(activePrices.prices.hour, 0);
        assert.strictEqual(zhwAdapter.samePriceSet(prices(hour), activePrices.prices), true);
        const logs = await logDb.listPricePublishItemLogsByBatchId(result.batch_id);
        assert.strictEqual(logs[0].price_after_hour, 0, 'inactive actual hourly quote remains zero in verification logs');
        assert.strictEqual(logs[0].after_data.hour_basis, hour);
        await runtime(8, { ...identity, channel: 'zuhaowang', applied_tier: 1 });
        assert.strictEqual((await summarize(8, [row]))['1::2571775932'].zuhaowang.hour_price, hour);
    }
    assert.strictEqual(changeCalls, 3);
    await seed({ rent_mode: 'day_only', p24Price: 19.2, p72Price: 48, p168Price: 128 });
    const changesBefore = changeCalls;
    const templatesBefore = templateCalls;
    const matching = await callPublish(prices(3.2), [template(prices(3.2))], false);
    assert.strictEqual(matching.changed, false);
    assert.strictEqual(matching.batch_id, '');
    assert.strictEqual(changeCalls, changesBefore);
    assert.strictEqual(templateCalls, templatesBefore + 1);
    assert.strictEqual((await read()).channel_prd_info.zuhaowang.hour_basis, 3.2);
    assert.strictEqual((await logDb.listPricePublishItemLogsByBatchId('')).length, 0);
    const unchanged = JSON.stringify((await read()).channel_prd_info);
    const mismatch = await callPublish(prices(3.6), [template(prices(3.2)), template(prices(3.2))]);
    assert.strictEqual(mismatch.ok, false);
    assert.strictEqual(JSON.stringify((await read()).channel_prd_info), unchanged);
    failWrite = true;
    const writeFailure = await callPublish(prices(3.2), [template(prices(3.2))], false);
    failWrite = false;
    assert.strictEqual(writeFailure.ok, false);
    assert.strictEqual(writeFailure.error_detail.stage, 'save_snapshot');
    assert.strictEqual(JSON.stringify((await read()).channel_prd_info), unchanged);

    // Reproduce the exact production gap from a verified legacy day-only publish.
    const historical = { batch_id: 'legacy-confirmed', user_id: 8, channel: 'zuhaowang', game_name: 'WZRY',
        game_account: identity.game_account, goods_id: '90738958', publish_status: 'success',
        response_data: { verification_status: 'full' }, request_data: { target_prices: prices(3.2) },
        after_data: { rent_mode: 'day_only', prices: { ...prices(3.2), hour: 0 }, template: template(prices(3.2)) } };
    await logDb.createPricePublishItemLog(historical);
    await seed({});
    await seed({}, { user_id: 9 });
    await seed({}, { game_id: '2', game_name: '和平精英' });
    goods = [{ id: '90738958', account: identity.game_account, gameId: 1, gameName: 'WZRY',
        roleName: 'fresh-role', exceptionMsg: '', status: '上架', rawStatus: 1 }];
    const firstSync = await sync(8);
    assert.strictEqual(firstSync.ok, true);
    const healed = await read();
    assert.strictEqual(healed.channel_prd_info.zuhaowang.hour_basis, 3.2);
    assert.strictEqual(healed.channel_prd_info.zuhaowang.p24Price, 19.2);
    assert.strictEqual(healed.channel_prd_info.zuhaowang.hourPrice, undefined);
    assert.strictEqual(healed.channel_prd_info.zuhaowang.exception_msg, '');
    assert.strictEqual(healed.channel_prd_info.zuhaowang.role_name, 'fresh-role');
    assert.strictEqual(healed.channel_prd_info.uuzuhao.hourPrice, 99);
    assert.strictEqual((await summarize(8, [healed]))['1::2571775932'].zuhaowang.hour_price, 3.2);
    assert.strictEqual((await db.listUserGameAccounts(9, 1, 200)).list[0].channel_prd_info.zuhaowang.hour_basis, undefined);
    assert.strictEqual((await db.listUserGameAccounts(8, 1, 200)).list.find((r) => r.game_id === '2').channel_prd_info.zuhaowang.hour_basis, undefined);
    const loadsBefore = historyLoads;
    await sync(8);
    assert.strictEqual(historyLoads, loadsBefore, 'a healed snapshot must not reread history every round');
    assert.strictEqual((await read()).channel_prd_info.zuhaowang.hour_basis, 3.2);
    assert.strictEqual(changeCalls, changesBefore + 1, 'only the explicit mismatched publish invoked a write API');
    assert.strictEqual(templateCalls, templatesBefore + 4, 'snapshot recovery does not query remote prices');

    await logDb.createPricePublishItemLog({ ...historical, batch_id: 'latest-unverified', response_data: { verification_status: 'partial' } });
    await seed({});
    await sync(8);
    assert.strictEqual((await read()).channel_prd_info.zuhaowang.hour_basis, undefined, 'do not fall back past a newer unverified success');
    await logDb.createPricePublishItemLog({ ...historical, batch_id: 'latest-verified' });
    failHistory = true;
    await sync(8);
    failHistory = false;
    assert.strictEqual((await read()).channel_prd_info.zuhaowang.hour_basis, undefined);
    await sync(8);
    assert.strictEqual((await read()).channel_prd_info.zuhaowang.hour_basis, 3.2);
    goods[0].id = 'replacement-product';
    await sync(8);
    assert.strictEqual((await read()).channel_prd_info.zuhaowang.hour_basis, undefined);
    enabled = false;
    const callsBefore = goodsCalls;
    assert.strictEqual((await sync(8)).skipped, true);
    assert.strictEqual(goodsCalls, callsBefore);
    console.log('[PASS] ZHW repair: day-only rise/fall, already-matches, failure atomicity, legacy recovery -> sync -> display, isolation, idempotence and disabled channel');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
