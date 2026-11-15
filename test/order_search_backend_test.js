'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-order-search-'));
for (const key of ['MAIN', 'RUNTIME', 'ORDER', 'STATS', 'PRICE']) {
    process.env[`${key}_DB_FILE_PATH`] = path.join(temporary, `${key}.db`);
}
process.env.TZ = 'Asia/Shanghai';
process.env.SHEEP_FIX_ENABLE = 'false';
process.env.ORDER_COUNT_TRACE = 'false';
global.fetch = async () => { throw new Error('Search tests cannot make external requests'); };
const RealDate = Date;
let current = '2026-11-15T14:00:00+08:00';
global.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [current])); }
    static now() { return new RealDate(current).getTime(); }
};

const client = require('../database/sqlite_client');
const originalOpenMain = client.openMainDatabase;
let queryFailure = false, closeCalls = 0;
client.openMainDatabase = () => {
    const db = originalOpenMain();
    const realAll = db.all, realClose = db.close;
    db.all = function(sql, params, callback) {
        if (queryFailure) { queueMicrotask(() => callback(new Error('fixture read failure'))); return db; }
        return realAll.apply(db, arguments);
    };
    db.close = function(...args) { closeCalls++; return realClose.apply(db, args); };
    return db;
};
const search = require('../order/order_search');
const accountDb = require('../database/order_search_account_db');
const { initOrderDb, upsertOrder } = require('../database/order_db');
const { listOrdersForUser } = require('../order/order');
const run = (db, sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, error => error ? reject(error) : resolve()));
const close = db => new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
let cases = 0;
const caseOf = async (name, action) => { await action(); cases++; };

async function account(overrides = {}) {
    const row = { user_id: 8, game_id: '1', game_account: '0012345678', account_remark: '本地新名',
        channel_prd_info: JSON.stringify({ uuzuhao: { remark: '呆熊宝✨' } }), is_deleted: 0, ...overrides };
    const db = originalOpenMain();
    try {
        await run(db, `INSERT INTO user_game_account
            (user_id,game_id,game_account,account_remark,channel_prd_info,is_deleted) VALUES (?,?,?,?,?,?)`,
        [row.user_id, row.game_id, row.game_account, row.account_remark, row.channel_prd_info, row.is_deleted]);
    } finally { await close(db); }
}
async function order(overrides = {}) {
    const row = { user_id: 8, channel: 'uuzuhao', order_no: 'base', game_id: '1', game_name: 'WZRY',
        game_account: '0012345678', role_name: '历史旧名', order_status: '已完成', order_amount: 12,
        rent_hour: 2, rec_amount: 10, start_time: '2026-11-15 08:00:00', end_time: '2026-11-15 10:00:00',
        ...overrides };
    await upsertOrder(row);
}
const list = options => listOrdersForUser(8, { game_name: 'WZRY', quick_filter: 'today', ...options });

async function main() {
    const db = originalOpenMain();
    await run(db, `CREATE TABLE user_game_account (id INTEGER PRIMARY KEY,user_id INTEGER,game_id TEXT,
        game_account TEXT,account_remark TEXT,channel_prd_info TEXT,is_deleted INTEGER)`);
    await close(db);
    await initOrderDb();
    await account();
    await account({ game_id: '4', account_remark: 'CS新名', channel_prd_info: '{}' });
    await account({ user_id: 9, channel_prd_info: JSON.stringify({ uuzuhao: { remark: '别人的独占名字' } }) });
    await account({ game_account: 'deleted', account_remark: '删除商品才有的名字', is_deleted: 1, channel_prd_info: '{}' });
    await account({ game_account: 'invalid-json', account_remark: '坏JSON仍可查询', channel_prd_info: 'invalid JSON' });
    await account({ game_account: 'english', account_remark: 'HELLO World', channel_prd_info: '{}' });
    await account({ game_account: '9988776655', account_remark: '', channel_prd_info: '{}' });
    await account({ game_account: '8877665544', account_remark: '8877665544', channel_prd_info: '{}' });
    await account({ game_account: '7766554433', account_remark: '', channel_prd_info: JSON.stringify({ uuzuhao: { remark: '7766554433' } }) });
    for (let n = 0; n < 25; n++) await order({ channel: ['uuzuhao', 'uhaozu', 'zuhaowang', '5e'][n % 4], order_no: `A-${n}`,
        order_status: n === 0 ? '租赁中' : n === 1 ? '已退款' : '已完成', rec_amount: n <= 2 ? 0 : 10 });
    await order({ order_no: 'leading-zero-other', game_account: '12345678', role_name: '另一名字' });
    await order({ order_no: 'CS-same-number', game_id: '4', game_name: 'CSGO', role_name: 'CS快照' });
    await order({ user_id: 9, order_no: 'private', role_name: '别人的独占名字' });
    await order({ order_no: 'deleted', game_account: 'deleted', role_name: '已删旧名字' });
    await order({ order_no: 'invalid-json', game_account: 'invalid-json', role_name: '' });
    await order({ order_no: 'english', game_account: 'english', role_name: 'old english' });
    for (const number of ['9988776655', '8877665544', '7766554433']) await order({ order_no: `unnamed-${number}`, game_account: number, role_name: number });
    await order({ order_no: 'literal', game_account: 'wildcard-literal', role_name: '100%_\\奇名' });
    await order({ order_no: 'non-literal', game_account: 'wildcard-nonliteral', role_name: '100xxxx奇名' });
    await order({ order_no: 'older', game_account: 'month-bounds', role_name: '日期边界', start_time: '2026-10-16 01:00:00', end_time: '2026-10-17 05:59:59' });
    await order({ order_no: 'lower-equal', game_account: 'month-bounds', role_name: '日期边界', start_time: '2026-10-16 01:00:00', end_time: '2026-10-17 06:00:00' });
    await order({ order_no: 'upper-equal', game_account: 'month-bounds', role_name: '日期边界', start_time: '2026-11-16 06:00:00', end_time: '2026-11-16 08:00:00' });
    await order({ order_no: 'future-day', game_account: 'month-bounds', role_name: '日期边界', start_time: '2026-11-16 08:00:00', end_time: '2026-11-16 10:00:00' });
    await order({ order_no: 'yesterday', game_account: 'business-day', role_name: '业务日边界', start_time: '2026-11-14 07:00:00', end_time: '2026-11-14 09:00:00' });

    await caseOf('keyword validation, trim and Unicode bounds', async () => {
        for (const value of [undefined, null, '', ' \t ']) assert.strictEqual(search.normalizeOrderSearchKeyword(value), '');
        assert.strictEqual(search.normalizeOrderSearchKeyword(' 名字 '), '名字');
        assert.strictEqual(search.normalizeOrderSearchKeyword('✨'.repeat(64)), '✨'.repeat(64));
        for (const value of [1, {}, [], '名'.repeat(65), '😀'.repeat(65), '\u0000', '名\u0000字', '名\t字', '名\n字', '\u007f']) {
            assert.throws(() => search.normalizeOrderSearchKeyword(value), e => e.statusCode === 400 && e.code === 'ORDER_SEARCH_INVALID');
        }
        await assert.rejects(list({ keyword: 'x'.repeat(65) }), e => e.code === 'ORDER_SEARCH_INVALID');
    });
    await caseOf('empty search does not access account database', async () => {
        queryFailure = true;
        assert((await list()).total > 0);
        assert.deepStrictEqual(await search.buildOrderSearchPredicate(8, ' '), { keyword: '', sql: '', params: [] });
        queryFailure = false;
    });
    await caseOf('all current names and snapshot aliases search whole result before pagination', async () => {
        for (const keyword of ['呆熊宝', '本地新名', '历史旧名', ' 熊宝 ']) {
            const result = await list({ keyword });
            assert.strictEqual(result.total, 25, keyword);
            assert.strictEqual(result.list.length, 20);
            assert.strictEqual(result.keyword, keyword.trim());
            assert.strictEqual(result.stats.progress, 1);
            assert.strictEqual(result.stats.done, 24);
            assert.strictEqual(result.stats.done_zero, 2);
            assert.strictEqual(result.stats.today_total, 25);
            assert.strictEqual(result.stats.progress_order_amount_sum, 0);
            const next = await list({ keyword, page: 2 });
            assert.strictEqual(next.total, 25); assert.strictEqual(next.list.length, 5);
            const identities = [...result.list, ...next.list].map(row => `${row.channel}:${row.order_no}`);
            assert.strictEqual(new Set(identities).size, 25);
            assert.strictEqual(new Set(result.list.map(row => row.channel)).size, 4);
        }
    });
    await caseOf('QQ exact string with leading zeros, no partial match', async () => {
        assert.strictEqual((await list({ keyword: '0012345678' })).total, 25);
        assert.strictEqual((await list({ keyword: '12345678' })).total, 1);
        assert.strictEqual((await list({ keyword: '12345' })).total, 0);
        for (const number of ['9988776655', '8877665544', '7766554433']) {
            assert.strictEqual((await list({ keyword: number })).total, 1);
            assert.strictEqual((await list({ keyword: number.slice(0, 6) })).total, 0, 'account fallback is not a fuzzy name');
            assert.strictEqual((await list({ keyword: number.slice(-6) })).total, 0, 'account tails are exact identifiers too');
        }
    });
    await caseOf('game and user isolation for names and QQ', async () => {
        assert.strictEqual((await list({ keyword: '呆熊宝', game_name: '全部' })).total, 25);
        assert.strictEqual((await list({ keyword: '呆熊宝', game_name: 'CS2' })).total, 0);
        assert.strictEqual((await list({ keyword: '0012345678', game_name: '全部' })).total, 26);
        assert.strictEqual((await list({ keyword: 'CS新名', game_name: '全部' })).total, 1);
        assert.strictEqual((await list({ keyword: '别人的独占名字' })).total, 0);
    });
    await caseOf('deleted account keeps order snapshot and QQ searchable', async () => {
        assert.strictEqual((await list({ keyword: '已删旧名字' })).total, 1);
        assert.strictEqual((await list({ keyword: 'deleted' })).total, 1);
        assert.strictEqual((await list({ keyword: '删除商品才有的名字' })).total, 0);
    });
    await caseOf('invalid JSON, case fold and no current alias fallback', async () => {
        assert.strictEqual((await list({ keyword: '坏JSON仍可查询' })).total, 1);
        assert.strictEqual((await list({ keyword: 'hello' })).total, 1);
        assert.strictEqual((await list({ keyword: 'OLD ENGLISH' })).total, 1);
    });
    await caseOf('wildcards, backslashes and SQL text are literal', async () => {
        for (const keyword of ['100%', '%_', '_\\', '100%_\\']) assert.strictEqual((await list({ keyword })).total, 1, keyword);
        assert.strictEqual((await list({ keyword: "' OR 1=1 --" })).total, 0);
    });
    await caseOf('search applies consistently to status, amount and totals', async () => {
        const progress = await list({ keyword: '熊宝', status_filter: 'progress' });
        assert.strictEqual(progress.total, 1); assert.strictEqual(progress.list.length, 1);
        assert.strictEqual(progress.stats.progress_order_amount_sum, 12);
        assert.strictEqual(progress.stats.done_zero, 2, 'retain pre-existing status-independent aggregate semantics');
        assert.strictEqual((await list({ keyword: '熊宝', status_filter: 'refund' })).total, 1);
        assert.strictEqual((await list({ keyword: '熊宝', status_filter: 'done' })).total, 24);
        assert.strictEqual((await list({ keyword: 'absent' })).stats.today_total, 0);
    });
    await caseOf('server date range hard limit and overlap boundaries', async () => {
        const result = await list({ keyword: '日期边界', quick_filter: 'last30', start: '1900-01-01', end: '2099-01-01' });
        assert.deepStrictEqual(result.range, { start: '2026-10-17 06:00:00', end: '2026-11-16 06:00:00' });
        assert.deepStrictEqual(result.list.map(r => r.order_no), ['lower-equal']);
        for (const quick_filter of ['all', 'month', 'week', 'yesterday', 'last9999', {}, '1900-01-01']) {
            const narrowed = await list({ quick_filter, keyword: '日期边界', date_start: '1900-01-01' });
            assert.strictEqual(narrowed.quick_filter, 'today'); assert.strictEqual(narrowed.total, 0);
            assert.strictEqual(narrowed.range.start, '2026-11-15 06:00:00');
        }
        assert.strictEqual((await list({ quick_filter: ' LAST30 ' })).quick_filter, 'last30');
        assert.strictEqual((await list({ quick_filter: 'last7' })).range.start, '2026-11-09 06:00:00');
        assert.strictEqual((await list({ quick_filter: 'last24h' })).range.start, '2026-11-14 14:00:00');
    });
    await caseOf('business day switches at six', async () => {
        current = '2026-11-15T05:59:59+08:00';
        const before = await list({ keyword: '业务日边界' });
        assert.strictEqual(before.total, 1); assert.strictEqual(before.range.start, '2026-11-14 06:00:00');
        current = '2026-11-15T06:00:00+08:00';
        assert.strictEqual((await list({ keyword: '业务日边界' })).total, 0);
        current = '2026-11-15T14:00:00+08:00';
    });
    await caseOf('large candidate sets keep all tuples using a single JSON bind', async () => {
        const rows = Array.from({ length: 1200 }, (_, i) => ({ game_id: '1', game_account: `fixture-${i}`, account_remark: '批量目标' }));
        rows.push({ game_id: '1', game_account: '0012345678', account_remark: '批量目标' }, rows[0],
            { game_id: '', game_account: 'skip', account_remark: '批量目标' }, { game_id: '1', game_account: '', account_remark: '批量目标' });
        const predicate = await search.buildOrderSearchPredicate(8, '批量目标', { listAccountNames: async () => rows });
        assert.strictEqual(predicate.params.length, 3);
        assert.strictEqual(JSON.parse(predicate.params[2]).length, 1201);
        const orderDb = client.openOrderDatabase();
        try {
            const result = await new Promise((resolve, reject) => orderDb.get(`SELECT count(*) n FROM "order" WHERE user_id=8 AND ${predicate.sql}`, predicate.params,
                (error, row) => error ? reject(error) : resolve(row)));
            assert.strictEqual(result.n, 25, 'late candidates are not dropped and games remain identity-bound');
        } finally { await close(orderDb); }
    });
    await caseOf('DAO only returns name fields and closes on read failure', async () => {
        const rows = await accountDb.listOrderSearchAccountNames(8);
        assert(rows.every(row => Object.keys(row).sort().join(',') === 'account_remark,game_account,game_id,uuzuhao_remark'));
        assert(!rows.some(row => row.account_remark === '删除商品才有的名字'));
        const closes = closeCalls; queryFailure = true;
        await assert.rejects(accountDb.listOrderSearchAccountNames(8), /fixture read failure/);
        assert.strictEqual(closeCalls, closes + 1); queryFailure = false;
        for (const id of [0, -1, '8', NaN]) await assert.rejects(accountDb.listOrderSearchAccountNames(id), /user_id/);
    });
    console.log(`[PASS] order_search_backend_test: ${cases} cases, isolated SQLite and no external HTTP`);
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(() => {
    global.Date = RealDate;
    fs.rmSync(temporary, { recursive: true, force: true });
});
