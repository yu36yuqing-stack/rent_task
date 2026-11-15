'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Every schema/fixture below belongs to this test, never to a user's local database.
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-order-search-api-'));
for (const key of ['MAIN', 'RUNTIME', 'ORDER', 'STATS', 'PRICE']) {
    process.env[`${key}_DB_FILE_PATH`] = path.join(tempDir, `${key}.db`);
}
Object.assign(process.env, {
    TZ: 'Asia/Shanghai', H5_HOST: '127.0.0.1', H5_PORT: '0',
    SHEEP_FIX_ENABLE: 'false', BL_V2_INSPECTOR_ENABLE: 'false',
    UUZUHAO_AUTO_REAUTHORIZE_ENABLED: '0', ORDER_COUNT_TRACE: 'false'
});

const RealDate = Date;
let nowMs = RealDate.parse('2026-11-15T12:00:00+08:00');
global.Date = class FixtureDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [nowMs])); }
    static now() { return nowMs; }
};

let forbiddenRequests = 0;
const originalFetch = global.fetch;
function assertLocal(input) {
    const hostname = new URL(String(input && input.url || input)).hostname;
    if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(hostname)) {
        forbiddenRequests += 1;
        throw new Error('Order search API tests forbid external HTTP');
    }
}
global.fetch = async (input, options) => { assertLocal(input); return originalFetch(input, options); };
const undici = require('undici');
const originalUndiciFetch = undici.fetch;
undici.fetch = async (input, options) => { assertLocal(input); return originalUndiciFetch(input, options); };

const { createUserByAdmin } = require('../database/user_db');
const { createAccessToken } = require('../user/auth_token');
const { upsertUserGameAccount } = require('../database/user_game_account_db');
const { upsertOrder } = require('../database/order_db');
const { openMainDatabase, openOrderDatabase } = require('../database/sqlite_client');
const { bootstrap } = require('../h5/local_h5_server');
const { stopProdRiskTaskWorker } = require('../product/prod_status_guard');

let cases = 0;
async function test(name, run) { await run(); cases += 1; }
async function writeMain(sql, params) {
    const db = openMainDatabase();
    try {
        return await new Promise((resolve, reject) => db.run(sql, params, error => error ? reject(error) : resolve()));
    } finally { await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve())); }
}

async function seedUser(account) {
    return createUserByAdmin({ account, password: 'fixture-password', name: account,
        user_type: '外部', status: 'enabled', desc: 'isolated order search HTTP fixture' });
}

async function seedAccount(user, gameAccount, remark, overrides = {}) {
    return upsertUserGameAccount({ user_id: user.id, game_id: '1', game_name: 'WZRY',
        game_account: gameAccount, account_remark: remark, ...overrides });
}

async function seedOrder(user, orderNo, gameAccount, overrides = {}) {
    return upsertOrder({ user_id: user.id, channel: 'uuzuhao', order_no: orderNo,
        game_id: '1', game_name: 'WZRY', game_account: gameAccount,
        role_name: '无关角色', order_status: '已完成', order_amount: 10,
        rent_hour: 1, ren_way: '时租', rec_amount: 2,
        start_time: '2026-11-15 10:00:00', end_time: '2026-11-15 11:00:00',
        create_date: '2026-11-15 09:59:00', desc: 'isolated search fixture', ...overrides });
}

async function main() {
    let server;
    try {
        const owner = await seedUser('order-search-owner');
        const other = await seedUser('order-search-other');
        const qq = '0012345678';
        await seedAccount(owner, qq, '当前账号备注熊宝', {
            channel_prd_info: { uuzuhao: { prd_id: 'fixture-primary', remark: '悠悠最新熊宝' } }
        });
        await seedAccount(owner, qq, 'CS2当前名字', { game_id: '4', game_name: 'CSGO' });
        await seedAccount(other, qq, '当前账号备注熊宝', {
            channel_prd_info: { uuzuhao: { prd_id: 'fixture-other-user', remark: '悠悠最新熊宝' } }
        });
        await seedAccount(owner, '9876543210', '删除前商品名称');
        await writeMain('UPDATE user_game_account SET is_deleted=1 WHERE user_id=? AND game_account=?', [owner.id, '9876543210']);
        await seedAccount(owner, '77778888', '改名后的不相关备注');
        await seedAccount(owner, '99990000', '符号%_\\名称');
        await seedAccount(owner, '12345678', '普通数字账号');
        await seedAccount(owner, '6060123499', '');
        await seedAccount(other, '55667788', '另一个人的唯一名称');

        const channels = ['uuzuhao', 'uhaozu', 'zuhaowang', '5e'];
        for (let index = 1; index <= 24; index += 1) {
            await seedOrder(owner, `bulk-${index}`, qq, {
                channel: channels[(index - 1) % channels.length], role_name: '旧快照主号', rec_amount: index <= 2 ? 0 : 2
            });
        }
        await seedOrder(owner, 'primary-progress', qq, {
            channel: 'uhaozu', role_name: '旧快照主号', order_status: '租赁中',
            order_amount: 30, rec_amount: 0, start_time: '2026-11-15 09:00:00', end_time: '2026-11-15 15:00:00'
        });
        await seedOrder(owner, 'primary-week', qq, {
            start_time: '2026-11-10 10:00:00', end_time: '2026-11-10 11:00:00'
        });
        await seedOrder(owner, 'primary-30day-edge', qq, {
            start_time: '2026-10-16 20:00:00', end_time: '2026-10-17 06:00:00'
        });
        await seedOrder(owner, 'primary-outside-30day', qq, {
            start_time: '2026-10-16 20:00:00', end_time: '2026-10-17 05:59:59'
        });
        await seedOrder(owner, 'primary-old-history', qq, {
            start_time: '2026-09-01 10:00:00', end_time: '2026-09-01 11:00:00'
        });
        await seedOrder(owner, 'same-qq-cs2', qq, { game_id: '4', game_name: 'CSGO', role_name: 'CS2旧快照' });
        await seedOrder(other, 'foreign-same-qq', qq, { role_name: '旧快照主号' });
        await seedOrder(other, 'foreign-unique', '55667788', { role_name: '另一个人的唯一名称' });
        await seedOrder(owner, 'deleted-account-order', '9876543210', { role_name: '已删旧熊宝' });
        await seedOrder(owner, 'renamed-order-snapshot', '77778888', { role_name: '历史熊宝', rec_amount: 0 });
        await seedOrder(owner, 'literal-special-name', '99990000', { role_name: '符号%_\\旧名称' });
        await seedOrder(owner, 'literal-special-control', '99991111', { role_name: '符号ABC名称' });
        await seedOrder(owner, 'without-leading-zero', '12345678');
        await seedOrder(owner, 'unnamed-numeric-account', '6060123499', { role_name: '6060123499' });
        await seedOrder(owner, 'max-keyword', '88880000', { role_name: '界'.repeat(64) });

        server = await bootstrap();
        const fixtureDb = openOrderDatabase();
        try {
            const sentinels = await new Promise((resolve, reject) => fixtureDb.get(
                'SELECT COUNT(*) n FROM "order" WHERE user_id=? AND order_no IN (?,?) AND is_deleted=0',
                [owner.id, 'primary-outside-30day', 'primary-old-history'],
                (error, row) => error ? reject(error) : resolve(row.n)
            ));
            assert.strictEqual(sentinels, 2, 'out-of-range fixtures must remain stored so range checks are not vacuous');
        } finally { await new Promise(resolve => fixtureDb.close(resolve)); }
        const baseUrl = `http://127.0.0.1:${server.address().port}`;
        async function request(params = {}, user = owner, authorized = true) {
            const query = new URLSearchParams({ game_name: 'WZRY', quick_filter: 'today', status_filter: 'all',
                page: '1', page_size: '20', ...params });
            // Renew the fixture token after changing the frozen business clock.
            const headers = authorized ? { Authorization: `Bearer ${createAccessToken(user)}` } : {};
            const response = await fetch(`${baseUrl}/api/orders?${query}`, { headers });
            return { status: response.status, data: await response.json() };
        }
        async function list(params = {}, user = owner) {
            const out = await request(params, user);
            assert.strictEqual(out.status, 200, JSON.stringify(out));
            assert.strictEqual(out.data.ok, true);
            return out.data;
        }

        await test('actual authenticated route and current UU display-name search', async () => {
            const out = await list({ keyword: '  悠悠最新  ' });
            assert.strictEqual(out.keyword, '悠悠最新');
            assert.strictEqual(out.total, 25);
            assert.strictEqual(out.list.length, 20);
            assert(out.list.every(row => row.display_name === '悠悠最新熊宝'));
            assert.strictEqual(out.stats.progress, 1);
            assert.strictEqual(out.stats.done, 24);
            assert.strictEqual(out.stats.done_zero, 2);
            assert.strictEqual(out.stats.today_total, 25);
        });
        await test('account remark and order-saved names both remain searchable', async () => {
            assert.strictEqual((await list({ keyword: '当前账号备注' })).total, 25);
            assert.strictEqual((await list({ keyword: '旧快照主号' })).total, 25);
            assert.strictEqual((await list({ keyword: '改名后的' })).total, 1);
            assert.strictEqual((await list({ keyword: '历史熊宝' })).total, 1);
        });
        await test('same keyword shared by list, total, zero-income and page boundaries', async () => {
            const pages = [];
            for (const page of [1, 2, 3]) pages.push(await list({ keyword: '熊宝', page: String(page), page_size: '10' }));
            assert.deepStrictEqual(pages.map(out => out.list.length), [10, 10, 7]);
            assert(pages.every(out => out.total === 27));
            assert(pages.every(out => out.stats.done_zero === 3 && out.stats.done === 26 && out.stats.progress === 1));
            const identities = pages.flatMap(out => out.list.map(row => `${row.channel}:${row.order_no}`));
            assert.strictEqual(new Set(identities).size, 27);
            assert.deepStrictEqual([...new Set(pages.flatMap(out => out.list.map(row => row.channel)))].sort(), channels.slice().sort());
            const next = await list({ keyword: '熊宝', page: '4', page_size: '10' });
            assert.strictEqual(next.total, 27);assert.deepStrictEqual(next.list, []);
        });
        await test('status and expected rental amount use the searched account range', async () => {
            const out = await list({ keyword: '熊宝', status_filter: 'progress' });
            assert.strictEqual(out.total, 1);assert.strictEqual(out.list[0].order_no, 'primary-progress');
            assert.strictEqual(out.stats.progress_order_amount_sum, 30);
            assert.strictEqual((await list({ keyword: '熊宝', status_filter: 'done' })).total, 26);
        });
        await test('complete QQ string, leading zero and same-account multi-game isolation', async () => {
            assert.strictEqual((await list({ keyword: qq })).total, 25);
            assert.strictEqual((await list({ keyword: qq, game_name: '全部' })).total, 26);
            const cs2 = await list({ keyword: qq, game_name: 'CSGO' });
            assert.strictEqual(cs2.total, 1);assert.strictEqual(cs2.list[0].order_no, 'same-qq-cs2');
            assert.strictEqual((await list({ keyword: '12345678' })).total, 1);
            assert.strictEqual((await list({ keyword: '1234' })).total, 0);
            assert.strictEqual((await list({ keyword: '6060123499' })).total, 1);
            assert.strictEqual((await list({ keyword: '606012' })).total, 0, 'a display fallback to QQ must not enable partial QQ matches');
            assert.strictEqual((await list({ keyword: '3499' })).total, 0, 'QQ copied into role_name must not enable suffix matches');
        });
        await test('cross-user identity/name searches cannot leak another user', async () => {
            const otherList = await list({ keyword: qq }, other);
            assert.strictEqual(otherList.total, 1);assert.strictEqual(otherList.list[0].order_no, 'foreign-same-qq');
            assert.strictEqual((await list({ keyword: '55667788' })).total, 0);
            assert.strictEqual((await list({ keyword: '另一个人的唯一名称' })).total, 0);
            const bypass = await list({ keyword: '另一个人的唯一名称', user_id: String(other.id) });
            assert.strictEqual(bypass.total, 0);
        });
        await test('deleted products retain order name and QQ lookup', async () => {
            const byName = await list({ keyword: '已删旧熊宝' });
            const byQq = await list({ keyword: '9876543210' });
            assert.strictEqual(byName.total, 1);assert.strictEqual(byQq.total, 1);
            assert.strictEqual(byName.list[0].display_name, '已删旧熊宝');
        });
        await test('special characters are literal, bound search values cannot expand SQL', async () => {
            for (const keyword of ['%', '_', '\\', '%_\\']) {
                const out = await list({ keyword });
                assert.strictEqual(out.total, 1, keyword);
                assert.strictEqual(out.list[0].order_no, 'literal-special-name');
            }
            assert.strictEqual((await list({ keyword: "x' OR 1=1 --" })).total, 0);
        });
        await test('clearing the keyword restores the existing selected range', async () => {
            const plain = await list();
            const empty = await list({ keyword: '' });
            const spaces = await list({ keyword: '  ' });
            for (const out of [empty, spaces]) {
                assert.strictEqual(out.keyword, '');assert.strictEqual(out.total, plain.total);
                assert.deepStrictEqual(out.list, plain.list);assert.deepStrictEqual(out.stats, plain.stats);
                assert.deepStrictEqual(out.range, plain.range);
            }
        });
        await test('7/30-day scopes and exact lower boundary cap history', async () => {
            assert.strictEqual((await list({ keyword: '悠悠最新', quick_filter: 'last7' })).total, 26);
            const last30 = await list({ keyword: '悠悠最新', quick_filter: 'last30', page_size: '100' });
            assert.strictEqual(last30.total, 27);
            assert.deepStrictEqual(last30.range, { start: '2026-10-17 06:00:00', end: '2026-11-16 06:00:00' });
            assert(last30.list.some(row => row.order_no === 'primary-30day-edge'));
            assert(!last30.list.some(row => ['primary-outside-30day', 'primary-old-history'].includes(row.order_no)));
            const last24h = await list({ keyword: '悠悠最新', quick_filter: 'last24h' });
            assert.strictEqual(last24h.total, 25);
            assert.deepStrictEqual(last24h.range, { start: '2026-11-14 12:00:00', end: '2026-11-15 12:00:00' });
        });
        await test('tampered range parameters and unsupported filters cannot expose old orders', async () => {
            for (const quick_filter of ['all', 'month', 'week', 'yesterday', 'last365', 'invalid']) {
                const out = await list({ keyword: '悠悠最新', quick_filter,
                    start_time: '1900-01-01', end_time: '2100-01-01', days: '999999', page_size: '100' });
                assert.strictEqual(out.quick_filter, 'today');assert.strictEqual(out.total, 25);
                assert.deepStrictEqual(out.range, { start: '2026-11-15 06:00:00', end: '2026-11-16 06:00:00' });
                assert(!out.list.some(row => row.order_no === 'primary-old-history'));
            }
        });
        await test('business-day date boundary is consistent before and at 06:00', async () => {
            nowMs = RealDate.parse('2026-11-15T05:59:59+08:00');
            assert.deepStrictEqual((await list({ keyword: '悠悠最新' })).range,
                { start: '2026-11-14 06:00:00', end: '2026-11-15 06:00:00' });
            nowMs = RealDate.parse('2026-11-15T06:00:00+08:00');
            assert.deepStrictEqual((await list({ keyword: '悠悠最新' })).range,
                { start: '2026-11-15 06:00:00', end: '2026-11-16 06:00:00' });
            nowMs = RealDate.parse('2026-11-15T12:00:00+08:00');
        });
        await test('64-character limit and zero-result summary are explicit HTTP contracts', async () => {
            assert.strictEqual((await list({ keyword: '界'.repeat(64) })).total, 1);
            const invalid = await request({ keyword: '界'.repeat(65) });
            assert.strictEqual(invalid.status, 400);assert.strictEqual(invalid.data.ok, false);
            assert.match(invalid.data.message, /64/);
            const nul = await request({ keyword: '\u0000' });
            assert.strictEqual(nul.status, 400);assert.strictEqual(nul.data.ok, false);
            assert.strictEqual(nul.data.list, undefined, 'encoded NUL must not turn LIKE into an unrestricted match');
            const absent = await list({ keyword: '根本不存在的名称' });
            assert.strictEqual(absent.total, 0);assert.deepStrictEqual(absent.list, []);
            assert.strictEqual(absent.stats.today_total, 0);assert.strictEqual(absent.stats.done_zero, 0);
        });
        await test('account-name read failure is an HTTP error, never a false empty result', async () => {
            await writeMain('ALTER TABLE user_game_account RENAME TO order_search_fixture_accounts_unavailable', []);
            try {
                const failed = await request({ keyword: '悠悠最新' });
                assert.strictEqual(failed.status, 500);assert.strictEqual(failed.data.ok, false);
                assert.strictEqual(failed.data.list, undefined);assert.strictEqual(failed.data.total, undefined);
            } finally {
                await writeMain('ALTER TABLE order_search_fixture_accounts_unavailable RENAME TO user_game_account', []);
            }
            assert.strictEqual((await list({ keyword: '悠悠最新' })).total, 25);
        });
        await test('the endpoint still requires authentication', async () => {
            const denied = await request({ keyword: '熊宝' }, owner, false);
            assert.strictEqual(denied.status, 401);assert.strictEqual(denied.data.ok, false);
        });

        assert.strictEqual(forbiddenRequests, 0);
        console.log(`[PASS] order_search_api_test: ${cases} authenticated HTTP cases; five temporary databases; no external HTTP`);
    } finally {
        if (server) {
            server.closeAllConnections?.();
            await new Promise(resolve => server.close(resolve));
        }
        stopProdRiskTaskWorker();
        global.Date = RealDate;
        global.fetch = originalFetch;
        undici.fetch = originalUndiciFetch;
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
}

main().catch(error => { console.error(`[FAIL] order_search_api_test: ${error.stack || error}`); process.exitCode = 1; });
