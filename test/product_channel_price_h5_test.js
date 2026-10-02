'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-product-price-'));
for (const [env, file] of Object.entries({ MAIN_DB_FILE_PATH: 'main.db', RUNTIME_DB_FILE_PATH: 'runtime.db',
    ORDER_DB_FILE_PATH: 'order.db', STATS_DB_FILE_PATH: 'stats.db', PRICE_DB_FILE_PATH: 'price.db' })) {
    process.env[env] = path.join(tempDir, file);
}
process.env.H5_PORT = '0';
process.env.SHEEP_FIX_ENABLE = '0';
process.env.BL_V2_INSPECTOR_ENABLE = '0';
process.env.ORDER_COUNT_TRACE = 'false';

const runtimeDb = require('../database/account_price_ladder_runtime_db');
const authDb = require('../database/user_platform_auth_db');
let runtimeFailure = false;
let authFailure = false;
const originalList = runtimeDb.listAccountPriceLadderRuntimesByUser;
const originalAuth = authDb.listUserPlatformAuth;
runtimeDb.listAccountPriceLadderRuntimesByUser = (...args) => runtimeFailure
    ? Promise.reject(Object.assign(new Error('test only'), { code: 'SQLITE_CORRUPT' })) : originalList(...args);
authDb.listUserPlatformAuth = (...args) => authFailure
    ? Promise.reject(new Error('test only')) : originalAuth(...args);
const { createUserByAdmin } = require('../database/user_db');
const { upsertUserGameAccount } = require('../database/user_game_account_db');
const { openMainDatabase, openPriceDatabase } = require('../database/sqlite_client');
const { createAccessToken } = require('../user/auth_token');
const { bootstrap } = require('../h5/local_h5_server');
const { stopProdRiskTaskWorker } = require('../product/prod_status_guard');

async function sql(open, statement, params = []) {
    const db = open();
    try {
        return await new Promise((resolve, reject) => db.all(statement, params, (error, rows) => error ? reject(error) : resolve(rows)));
    } finally {
        await new Promise((resolve, reject) => db.close((error) => error ? reject(error) : resolve()));
    }
}

async function main() {
    const user = await createUserByAdmin({ account: 'product_price_test', password: 'test-password', status: 'enabled', user_type: '内部' });
    const other = await createUserByAdmin({ account: 'product_price_other', password: 'test-password', status: 'enabled', user_type: '内部' });
    for (const [game_id, game_name] of [['1', 'WZRY'], ['2', '和平精英'], ['3', 'CFM'], ['4', 'CSGO']]) {
        await upsertUserGameAccount({ user_id: user.id, game_id, game_name, game_account: 'same-account',
            channel_status: { uhaozu: '上架', uuzuhao: '下架', zuhaowang: '租赁中' },
            channel_prd_info: {
                uhaozu: { prd_id: `u-${game_id}`, rentalByHour: 2.3 },
                uuzuhao: { prd_id: `y-${game_id}`, hourPrice: 1.9 },
                zuhaowang: { prd_id: `z-${game_id}`, hourPrice: 2.5, rent_mode: 'hour_only' }
            } });
        for (const [channel, tier] of [['uhaozu', 2], ['uuzuhao', 1], ['zuhaowang', 3]]) {
            await runtimeDb.upsertAccountPriceLadderRuntime(user.id, { game_id, game_name, game_account: 'same-account',
                channel, applied_tier: tier, desired_tier: 4, status: 'failed', last_error: 'private-error' });
        }
    }
    await upsertUserGameAccount({ user_id: other.id, game_id: '1', game_name: 'WZRY', game_account: 'same-account',
        channel_prd_info: { uhaozu: { prd_id: 'other', rentalByHour: 99 } } });
    const server = await bootstrap();
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { Authorization: `Bearer ${createAccessToken(user)}` };
    const products = async (query = '', customHeaders = headers) => {
        const response = await fetch(`${base}/api/products${query}`, { headers: customHeaders });
        const payload = await response.json();
        assert.strictEqual(response.status, 200, JSON.stringify(payload));
        return payload;
    };
    try {
        assert.strictEqual((await fetch(`${base}/api/products`)).status, 401);
        const before = await sql(openPriceDatabase, 'SELECT * FROM account_price_ladder_runtime ORDER BY id');
        const all = await products();
        assert.strictEqual(all.total, 4);
        for (const item of all.list) {
            assert.deepStrictEqual(item.price_ladder, { uhaozu: { current_tier: 2, hour_price: 2.3 },
                zuhaowang: { current_tier: 3, hour_price: 2.5 }, uuzuhao: { current_tier: 1, hour_price: 1.9 } });
            assert.strictEqual(item.channel_status.uuzuhao, '下架');
            assert(!JSON.stringify(item.price_ladder).includes('private-error'));
            assert(!Object.hasOwn(item.price_ladder.uuzuhao, 'desired_tier'));
        }
        assert.strictEqual((await products('?page=2&page_size=1')).list.length, 1);
        assert.strictEqual((await products('?page=99&page_size=1')).list.length, 0);
        assert.strictEqual((await products('?filter=renting')).total, 4);
        for (const game of ['WZRY', '和平精英', 'CFM', 'CSGO']) {
            const page = await products(`?game_name=${encodeURIComponent(game)}`);
            assert.strictEqual(page.list.length, 1);
            assert.strictEqual(page.list[0].game_name, game);
        }
        const otherList = await products('', { Authorization: `Bearer ${createAccessToken(other)}` });
        assert.deepStrictEqual(otherList.list[0].price_ladder.uhaozu, { current_tier: 0, hour_price: 99 });
        assert.deepStrictEqual(await sql(openPriceDatabase, 'SELECT * FROM account_price_ladder_runtime ORDER BY id'), before);

        await sql(openMainDatabase, `INSERT INTO user_platform_auth
            (user_id, platform, auth_type, auth_payload, auth_status, channel_enabled) VALUES (?, 'uhaozu', 'api_key', '{}', 'valid', 0)`, [user.id]);
        assert.strictEqual((await products()).list[0].price_ladder.uhaozu, undefined);
        await sql(openMainDatabase, 'DELETE FROM user_platform_auth WHERE user_id = ?', [user.id]);
        runtimeFailure = true;
        assert.deepStrictEqual((await products()).list[0].price_ladder.uuzuhao, { current_tier: 0, hour_price: 1.9 });
        runtimeFailure = false;
        authFailure = true;
        assert.deepStrictEqual((await products()).list[0].price_ladder, {});
        authFailure = false;
        await sql(openMainDatabase, `UPDATE user_game_account SET asset_status = 'sold' WHERE user_id = ? AND game_id = '1'`, [user.id]);
        assert.deepStrictEqual((await products('?asset_status=sold')).list[0].price_ladder, {});
        const html = await (await fetch(base)).text();
        assert(html.indexOf('/js/ui/channel_price_summary.js?') < html.indexOf('/js/menu_products.js?'));
        assert.strictEqual((await fetch(`${base}/js/ui/channel_price_summary.js?v=20261002a`)).status, 200);
        assert.strictEqual((await fetch(`${base}/api/ping`)).status, 200);
        console.log('[PASS] product_channel_price_h5: isolated five DBs, auth, paging, filters, four games, disable and degradation');
    } finally {
        stopProdRiskTaskWorker();
        await new Promise((resolve) => server.close(resolve));
    }
}

main().catch((error) => { stopProdRiskTaskWorker(); console.error(error); process.exitCode = 1; });
