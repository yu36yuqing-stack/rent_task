#!/usr/bin/env node
'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-product-income-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'main.db');
process.env.STATS_DB_FILE_PATH = path.join(tempDir, 'stats.db');
const { openDatabase, openStatsDatabase } = require('../database/sqlite_client');
const dbApi = require('../database/product_income_db');
const servicePath = require.resolve('../stats/product_income_service');
const { getProductIncomeSummaries } = require(servicePath);
const { buildHistoricalIncomeTotals } = require('../stats/historical_income');

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => db.run(sql, params, (error) => error ? reject(error) : resolve()));
}

async function seed() {
    const main = openDatabase();
    const stats = openStatsDatabase();
    try {
        await run(main, `CREATE TABLE user_game_account(id INTEGER PRIMARY KEY, user_id INTEGER,
            game_id TEXT, game_name TEXT, game_account TEXT, purchase_price REAL,
            purchase_date TEXT, asset_status TEXT DEFAULT 'active', is_deleted INTEGER DEFAULT 0)`);
        await run(stats, `CREATE TABLE order_stats_weekly_snapshot(id INTEGER PRIMARY KEY,
            user_id INTEGER, game_name TEXT, game_account TEXT, snapshot_date TEXT,
            total_rec_amount REAL, is_deleted INTEGER DEFAULT 0)`);
        await run(stats, `CREATE TABLE order_stats_daily(id INTEGER PRIMARY KEY,
            user_id INTEGER, game_name TEXT, game_account TEXT, stat_date TEXT,
            amount_rec_sum REAL, is_deleted INTEGER DEFAULT 0)`);
        let id = 0;
        for (const account of ['normal', 'zero', 'missing', 'missing-config', 'bad-date', 'tiny-cost', 'negative', 'bad-amount', 'bad-snapshot', 'deleted', 'sold', 'same', "quote'--", 'snapshot-zero', 'future', 'overflow']) {
            await run(main, `INSERT INTO user_game_account
                (id,user_id,game_id,game_name,game_account,purchase_price,purchase_date,asset_status,is_deleted)
                VALUES(?,1,'1','WZRY',?,?,? ,?,?)`, [++id, account,
                account === 'missing-config' ? 0 : account === 'tiny-cost' ? 0.001 : 100,
                account === 'bad-date' ? '' : '2026-01-01', account === 'sold' ? 'sold' : 'active', account === 'deleted' ? 1 : 0]);
        }
        await run(main, `INSERT INTO user_game_account VALUES(?,1,'2','和平精英','same',100,'2026-01-01','active',0)`, [++id]);
        await run(main, `INSERT INTO user_game_account VALUES(?,2,'1','WZRY','foreign',100,'2026-01-01','active',0)`, [++id]);
        const daily = async (uid, game, account, date, amount, deleted = 0) => run(stats,
            `INSERT INTO order_stats_daily(user_id,game_name,game_account,stat_date,amount_rec_sum,is_deleted) VALUES(?,?,?,?,?,?)`, [uid, game, account, date, amount, deleted]);
        const snapshot = async (account, date, amount, deleted = 0) => run(stats,
            `INSERT INTO order_stats_weekly_snapshot(user_id,game_name,game_account,snapshot_date,total_rec_amount,is_deleted) VALUES(1,'WZRY',?,?,?,?)`, [account, date, amount, deleted]);
        await snapshot('normal', '2026-10-11', 80);
        await snapshot('normal', '2026-10-18', 100);
        await snapshot('normal', '2026-10-25', 999);
        await snapshot('normal', '2026-10-20', 888, 1);
        await daily(1, 'WZRY', 'normal', '2026-10-18', 90);
        await daily(1, 'WZRY', 'normal', '2026-10-19', 2.555);
        await daily(1, 'WZRY', 'normal', '2026-10-19', 1.555);
        await daily(1, 'WZRY', 'normal', '2026-10-22', 3);
        await daily(1, 'WZRY', 'normal', '2026-10-23', 888);
        await daily(2, 'WZRY', 'normal', '2026-10-20', 999);
        await daily(1, 'WZRY', 'normal', '2026-10-20', 999, 1);
        await daily(1, 'WZRY', 'zero', '2026-10-20', 0);
        await daily(1, 'WZRY', 'negative', '2026-10-20', -1);
        await daily(1, 'WZRY', 'negative', '2026-10-20', 3);
        await daily(1, 'WZRY', 'bad-amount', '2026-10-20', 'not-money');
        await snapshot('bad-snapshot', '2026-10-18', 'invalid');
        await daily(1, 'WZRY', 'bad-snapshot', '2026-10-20', 2);
        await snapshot('snapshot-zero', '2026-10-18', 0);
        await daily(1, 'WZRY', 'same', '2026-10-20', 12);
        await daily(1, '和平精英', 'same', '2026-10-20', 34);
        await daily(2, 'WZRY', 'foreign', '2026-10-20', 999);
        await daily(1, 'WZRY', "quote'--", '2026-10-20', 1.23);
        await daily(1, 'WZRY', 'future', '2026-10-23', 9);
        await snapshot('overflow', '2026-10-18', 1.7e308);
        await daily(1, 'WZRY', 'overflow', '2026-10-20', 1.7e308);
        for (const account of ['missing-config', 'bad-date', 'tiny-cost', 'deleted', 'sold']) await daily(1, 'WZRY', account, '2026-10-20', 123);
    } finally {
        main.close();
        stats.close();
    }
}

async function main() {
    await seed();
    const now = new Date(2026, 9, 22, 10);
    const accounts = ['normal', 'zero', 'missing', 'missing-config', 'bad-date', 'tiny-cost', 'negative', 'bad-amount', 'bad-snapshot', 'deleted', 'sold', 'same', 'foreign', "quote'--", 'snapshot-zero', 'future', 'overflow']
        .map((game_account) => ({ game_id: '1', game_name: 'WZRY', game_account, purchase_price: 999, purchase_date: '2026-01-01' }));
    accounts.push({ game_id: '2', game_name: '和平精英', game_account: 'same' }, null, {}, { game_id: '1', game_account: '' });
    const result = await getProductIncomeSummaries(1, accounts, { now });
    assert.deepEqual(result['1::normal'], { amount: 107.11, status: 'ready' });
    assert.deepEqual(result['1::zero'], { amount: 0, status: 'ready' });
    assert.deepEqual(result['1::snapshot-zero'], { amount: 0, status: 'ready' });
    assert.equal(result['1::same'].amount, 12);
    assert.equal(result['2::same'].amount, 34);
    assert.equal(result['1::negative'].amount, 2);
    assert.equal(result["1::quote'--"].amount, 1.23);
    for (const account of ['missing', 'missing-config', 'bad-date', 'tiny-cost', 'bad-amount', 'bad-snapshot', 'deleted', 'sold', 'foreign', 'future', 'overflow']) {
        assert.deepEqual(result[`1::${account}`], { amount: null, status: 'unavailable' }, account);
    }
    assert.deepEqual(await getProductIncomeSummaries(1, []), {});
    assert.deepEqual(await getProductIncomeSummaries(1, null), {});
    assert.equal((await getProductIncomeSummaries('bad', accounts, { now }))['1::normal'].amount, null);
    assert.equal((await getProductIncomeSummaries(1, accounts, { now: new Date('bad') }))['1::normal'].amount, null);
    assert.equal((await getProductIncomeSummaries(1, [accounts[0], accounts[0]], { now }))['1::normal'].amount, 107.11);
    const otherOwner = await getProductIncomeSummaries(2, [{ game_id: '1', game_name: 'WZRY', game_account: 'foreign' }, accounts[0]], { now });
    assert.equal(otherOwner['1::foreign'].amount, 999);
    assert.equal(otherOwner['1::normal'].amount, null);
    assert.deepEqual(await dbApi.listOwnedProductIncomeAccounts(1, '1', 'WZRY', []), []);
    assert.deepEqual(await dbApi.listProductIncomeRows(1, 'WZRY', [], '2026-10-22'), { snapshotRows: [], dailyRows: [] });

    // Strict display vs legacy dashboard zero fallback, latest-id tie, unrelated
    // rows, invalid dates, and money rounding share the same pure algorithm.
    const snapshots = [{ game_account: 'a', snapshot_date: '2026-10-18', id: 1, total_rec_amount: 9 },
        { game_account: 'a', snapshot_date: '2026-10-18', id: 2, total_rec_amount: 10 },
        { game_account: 'foreign', snapshot_date: '2026-10-21', total_rec_amount: 999 }];
    const daily = [{ game_account: 'a', stat_date: '2026-10-18', amount_rec_sum: 99 },
        { game_account: 'a', stat_date: '2026-10-19', amount_rec_sum: 0.11 },
        { game_account: 'foreign', stat_date: '2026-10-20', amount_rec_sum: 999 }];
    assert.deepEqual([...buildHistoricalIncomeTotals(['a', 'b'], snapshots, daily)], [['a', 10.11], ['b', 0]]);
    assert.equal(buildHistoricalIncomeTotals(['a'], [{ game_account: 'a', total_rec_amount: 'bad' }], []).get('a'), 0);
    assert.equal(buildHistoricalIncomeTotals(['a'], [], [{ game_account: 'a', amount_rec_sum: 2 }], { strict: true }).get('a'), null);
    assert.equal(buildHistoricalIncomeTotals(['a'], [{ game_account: 'a', total_rec_amount: 2 }], [], { strict: true }).get('a'), null);
    assert.equal(buildHistoricalIncomeTotals(['a'], [], [{ game_account: 'a', stat_date: '2026-01-01', amount_rec_sum: null }], { strict: true }).get('a'), null);
    assert.equal(buildHistoricalIncomeTotals(['a'], [], [{ game_account: 'a', stat_date: '2026-01-01', amount_rec_sum: -3 }], { strict: true }).get('a'), -3);

    // Require-time injection verifies per-game read failures do not leak values
    // or break healthy games. The backing database still enforces ownership.
    const originalRows = dbApi.listProductIncomeRows;
    dbApi.listProductIncomeRows = async (uid, game, ...rest) => {
        if (game === 'WZRY') throw new Error('fixture read failure');
        return originalRows(uid, game, ...rest);
    };
    delete require.cache[servicePath];
    const partial = await require(servicePath).getProductIncomeSummaries(1, accounts, { now });
    assert.equal(partial['1::normal'].amount, null);
    assert.equal(partial['2::same'].amount, 34);
    dbApi.listProductIncomeRows = originalRows;
    const owned = dbApi.listOwnedProductIncomeAccounts;
    dbApi.listOwnedProductIncomeAccounts = async () => { throw new Error('fixture main store failure'); };
    delete require.cache[servicePath];
    assert.equal((await require(servicePath).getProductIncomeSummaries(1, accounts, { now }))['1::normal'].amount, null);
    dbApi.listOwnedProductIncomeAccounts = owned;
    delete require.cache[servicePath];

    const stats = openStatsDatabase();
    try { await run(stats, 'DROP TABLE order_stats_daily'); } finally { stats.close(); }
    await assert.rejects(dbApi.listProductIncomeRows(1, 'WZRY', ['normal'], '2026-10-22'), /no such table/);
    assert.equal((await getProductIncomeSummaries(1, accounts, { now }))['1::normal'].amount, null);
    console.log('[PASS] product income service: scoped batch totals, zero/unknown, snapshot boundary, failures and shared algorithm');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
