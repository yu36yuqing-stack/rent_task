'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-product-income-h5-'));
for (const [key, file] of Object.entries({
    MAIN_DB_FILE_PATH: 'main.db', RUNTIME_DB_FILE_PATH: 'runtime.db', ORDER_DB_FILE_PATH: 'order.db',
    STATS_DB_FILE_PATH: 'stats.db', PRICE_DB_FILE_PATH: 'price.db'
})) process.env[key] = path.join(temporary, file);
process.env.H5_PORT = '0';
process.env.SHEEP_FIX_ENABLE = '0';
process.env.BL_V2_INSPECTOR_ENABLE = '0';
process.env.ORDER_COUNT_TRACE = 'false';

const incomeDb = require('../database/product_income_db');
const originalRows = incomeDb.listProductIncomeRows;
let sourceFailure = false;
incomeDb.listProductIncomeRows = (...args) => sourceFailure
    ? Promise.reject(Object.assign(new Error('private-source-error'), { code: 'SQLITE_CORRUPT' }))
    : originalRows(...args);
const incomeService = require('../stats/product_income_service');
const originalSummaries = incomeService.getProductIncomeSummaries;
const batches = [];
incomeService.getProductIncomeSummaries = (userId, accounts, options) => {
    batches.push({ userId, accounts: accounts.map(({ game_id, game_account }) => ({ game_id, game_account })) });
    return originalSummaries(userId, accounts, options);
};
const { createUserByAdmin } = require('../database/user_db');
const { upsertUserGameAccount } = require('../database/user_game_account_db');
const { initOrderStatsDailyDb } = require('../database/order_stats_daily_db');
const { initOrderStatsWeeklySnapshotDb } = require('../database/order_stats_weekly_snapshot_db');
const { openMainDatabase, openStatsDatabase } = require('../database/sqlite_client');
const { createAccessToken } = require('../user/auth_token');
const { bootstrap } = require('../h5/local_h5_server');
const { stopProdRiskTaskWorker } = require('../product/prod_status_guard');

async function sql(open, query, params = []) {
    const db = open();
    try {
        return await new Promise((resolve, reject) => db.all(query, params, (error, rows) => error ? reject(error) : resolve(rows)));
    } finally {
        await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
    }
}

async function daily(userId, game, account, amount, day = '2020-01-06', channel = 'uhaozu') {
    await sql(openStatsDatabase, `INSERT INTO order_stats_daily
        (user_id,game_name,game_account,stat_date,channel,amount_rec_sum) VALUES (?,?,?,?,?,?)`,
    [userId, game, account, day, channel, amount]);
}

async function weekly(userId, game, account, amount) {
    await sql(openStatsDatabase, `INSERT INTO order_stats_weekly_snapshot
        (user_id,game_name,game_account,snapshot_date,total_rec_amount) VALUES (?,?,?,?,?)`,
    [userId, game, account, '2020-01-05', amount]);
}

async function main() {
    const user = await createUserByAdmin({ account: 'income-card-owner', password: 'fixture-password', status: 'enabled', user_type: '内部' });
    const other = await createUserByAdmin({ account: 'income-card-other', password: 'fixture-password', status: 'enabled', user_type: '内部' });
    const games = [['1', 'WZRY'], ['2', '和平精英'], ['3', 'CFM'], ['4', 'CSGO']];
    for (const [game_id, game_name] of games) {
        await upsertUserGameAccount({ user_id: user.id, game_id, game_name, game_account: 'shared-account',
            purchase_price: 500, purchase_date: '2020-01-01', channel_status: { uhaozu: '上架' } });
    }
    for (const account of ['missing-config', 'no-stats', 'sold-account']) {
        await upsertUserGameAccount({ user_id: user.id, game_id: '1', game_name: 'WZRY', game_account: account,
            purchase_price: account === 'missing-config' ? 0 : 500,
            purchase_date: account === 'missing-config' ? '' : '2020-01-01' });
    }
    await upsertUserGameAccount({ user_id: other.id, game_id: '1', game_name: 'WZRY', game_account: 'shared-account',
        purchase_price: 500, purchase_date: '2020-01-01' });
    const server = await bootstrap();
    try {
        await initOrderStatsDailyDb();
        await initOrderStatsWeeklySnapshotDb();
        await sql(openMainDatabase, 'UPDATE user_game_account SET total_cost_amount = 500 WHERE user_id IN (?,?)', [user.id, other.id]);
        await sql(openMainDatabase, `UPDATE user_game_account
            SET asset_status='sold',sold_price=600,lifecycle_income_amount=777,lifecycle_profit_amount=877
            WHERE user_id=? AND game_account='sold-account'`, [user.id]);
        await weekly(user.id, 'WZRY', 'shared-account', 100);
        await daily(user.id, 'WZRY', 'shared-account', 900, '2020-01-04');
        await daily(user.id, 'WZRY', 'shared-account', 80, '2020-01-05');
        await daily(user.id, 'WZRY', 'shared-account', 10, '2020-01-06', 'uhaozu');
        await daily(user.id, 'WZRY', 'shared-account', 20, '2020-01-06', 'uuzuhao');
        await daily(user.id, 'WZRY', 'shared-account', 5, '2020-01-06', 'zuhaowang');
        await weekly(user.id, '和平精英', 'shared-account', 200);
        await daily(user.id, '和平精英', 'shared-account', 1);
        await daily(user.id, 'CFM', 'shared-account', 0);
        await daily(user.id, 'CSGO', 'shared-account', 12.34);
        await daily(user.id, 'WZRY', 'missing-config', 99);
        await weekly(other.id, 'WZRY', 'shared-account', 9000);
        await daily(other.id, 'WZRY', 'shared-account', 1);
        const beforeDaily = await sql(openStatsDatabase, 'SELECT * FROM order_stats_daily ORDER BY id');
        const beforeWeekly = await sql(openStatsDatabase, 'SELECT * FROM order_stats_weekly_snapshot ORDER BY id');
        const base = `http://127.0.0.1:${server.address().port}`;
        const headers = { Authorization: `Bearer ${createAccessToken(user)}` };
        const products = async (query = '', authHeaders = headers) => {
            const params = new URLSearchParams(query.replace(/^\?/, ''));
            if (!params.has('page_size')) params.set('page_size', '20');
            const response = await fetch(`${base}/api/products?${params}`, { headers: authHeaders });
            const data = await response.json();
            assert.strictEqual(response.status, 200, JSON.stringify(data));
            assert(!JSON.stringify(data).includes('private-source-error'));
            return data;
        };
        assert.strictEqual((await fetch(`${base}/api/products`)).status, 401);
        batches.length = 0;
        const all = await products();
        assert.strictEqual(all.total, 6);
        assert.strictEqual(batches.length, 1, 'one income service call per page');
        assert.strictEqual(batches[0].accounts.length, 6);
        const expected = { '1': 135, '2': 201, '3': 0, '4': 12.34 };
        for (const item of all.list) {
            assert.strictEqual(item.total_cost_amount, 500, 'income does not replace or subtract costs');
            const amount = item.game_account === 'shared-account' ? expected[item.game_id] : null;
            assert.deepStrictEqual(item.rental_income, { amount, status: amount === null ? 'unavailable' : 'ready' });
        }
        for (const [gameId, game] of games) {
            const out = await products(`?game_name=${encodeURIComponent(game)}`);
            const account = out.list.find(item => item.game_account === 'shared-account');
            assert.strictEqual(account.rental_income.amount, expected[gameId]);
        }
        batches.length = 0;
        const page = await products('?page=2&page_size=2');
        assert.strictEqual(page.list.length, 2);
        assert.deepStrictEqual(batches[0].accounts, page.list.map(({ game_id, game_account }) => ({ game_id, game_account })), 'income query is scoped after paging');
        assert.strictEqual((await products('?page=99&page_size=2')).list.length, 0);
        const isolated = await products('', { Authorization: `Bearer ${createAccessToken(other)}` });
        assert.strictEqual(isolated.list.length, 1);
        assert.strictEqual(isolated.list[0].rental_income.amount, 9001);
        batches.length = 0;
        const sold = await products('?asset_status=sold');
        assert.strictEqual(batches.length, 0, 'sold cards retain their existing frozen lifecycle values');
        assert.strictEqual(sold.list.length, 1);
        assert.strictEqual(sold.list[0].lifecycle_income_amount, 777);
        assert.strictEqual(sold.list[0].lifecycle_profit_amount, 877);
        assert(!Object.hasOwn(sold.list[0], 'rental_income'));
        sourceFailure = true;
        const degraded = await products();
        assert.strictEqual(degraded.list.length, 6, 'income source failure must not break the product list');
        assert(degraded.list.every(item => item.rental_income.amount === null && item.rental_income.status === 'unavailable'));
        sourceFailure = false;
        assert.strictEqual((await products()).list.find(item => item.game_id === '1' && item.game_account === 'shared-account').rental_income.amount, 135);
        assert.deepStrictEqual(await sql(openStatsDatabase, 'SELECT * FROM order_stats_daily ORDER BY id'), beforeDaily);
        assert.deepStrictEqual(await sql(openStatsDatabase, 'SELECT * FROM order_stats_weekly_snapshot ORDER BY id'), beforeWeekly);
        const html = await (await fetch(base)).text();
        assert(html.indexOf('/js/ui/product_income_summary.js?') < html.indexOf('/js/menu_products.js?'));
        assert.strictEqual((await fetch(`${base}/js/ui/product_income_summary.js?v=20261022a`)).status, 200);
        console.log('[PASS] product_rent_income_h5: auth, four-game identity, batch paging, snapshots, zero/unknown, cost preservation, sold and safe degradation');
    } finally {
        stopProdRiskTaskWorker();
        await new Promise(resolve => server.close(resolve));
    }
}

main().catch(error => { stopProdRiskTaskWorker(); console.error(error); process.exitCode = 1; });
