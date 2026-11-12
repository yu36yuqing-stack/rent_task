'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-order-game-info-db-'));
for (const name of ['MAIN', 'RUNTIME', 'ORDER', 'STATS', 'PRICE']) process.env[`${name}_DB_FILE_PATH`] = path.join(dir, `${name}.db`);
global.fetch = async () => { throw new Error('Real HTTP is forbidden in ledger tests'); };
const client = require('../database/sqlite_client');
const realOpenOrder = client.openOrderDatabase;
let failSql = null;
client.openOrderDatabase = () => {
    const db = realOpenOrder();
    const original = db.run;
    db.run = function faultable(sql, params, callback) {
        if (failSql && failSql.test(sql)) {
            failSql = null;
            const cb = typeof params === 'function' ? params : callback;
            queueMicrotask(() => cb.call({}, new Error('fixture database write failure')));
            return db;
        }
        return original.apply(db, arguments);
    };
    return db;
};
const ledger = require('../database/order_game_info_refresh_db');
const migration = require('../database/migrations/20261112_023_order_game_info_refresh');
const configMigration = require('../database/migrations/20261104_022_system_config');
const config = require('../database/system_config_db');
const run = (db, sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function done(error) {
    if (error) return reject(error);
    resolve(this);
}));
const all = (db, sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
const close = db => new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
async function query(sql, params = [], write = false) {
    const db = realOpenOrder();
    try { return await (write ? run : all)(db, sql, params); } finally { await close(db); }
}
const now = new Date(2026, 10, 12, 12, 0, 0);
const later = new Date(2026, 10, 12, 12, 10, 0);
const earlier = new Date(2026, 10, 12, 11, 0, 0);
const input = (overrides = {}) => ({
    user_id: 8, channel: 'uhaozu', order_no: 'order-1', game_id: '1', game_name: 'WZRY', game_account: 'QQ-A',
    target_product_id: '202601141000819243', order_status: '已完成', start_time: '2026-11-12 10:00:00',
    end_time: '2026-11-12 10:20:00', ...overrides
});
const key = overrides => input(overrides);
const SYNC_TOKEN = 'fixture-sync';
const claim = (id, options = {}) => ledger.claimRefreshAttempt(id, { sync_token: SYNC_TOKEN, ...options });
async function enqueue(overrides = {}, options = { now }) {
    const row = input(overrides);
    const scoped = { now: options.now, business_scene: row.business_scene, target_channel: row.target_channel, token: SYNC_TOKEN };
    await ledger.beginRefreshOrderSync(row.user_id, scoped);
    const result = await ledger.enqueueRefreshOrder(row, { ...options, sync_token: SYNC_TOKEN });
    await ledger.completeRefreshOrderSync(row.user_id, scoped);
    return result;
}
const identity = order => ({ user_id: order.user_id, channel: order.channel, order_no: order.order_no,
    business_scene: order.business_scene, target_channel: order.target_channel });
async function migrate() {
    const db = client.openMainDatabase();
    try { await migration.up({ db, run }); } finally { await close(db); }
}
async function source(overrides = {}) {
    const row = input(overrides);
    await query(`INSERT INTO "order" (user_id,channel,order_no,game_id,game_name,game_account,role_name,order_status,start_time,end_time,is_deleted)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`, [row.user_id, row.channel, row.order_no, row.game_id, row.game_name,
        row.game_account, 'fixture role', row.order_status, row.start_time, row.end_time, overrides.is_deleted || 0], true);
    return row;
}

async function syncGenerationGate() {
    const user_id = 42, tokenA = 'sync-A', tokenB = 'sync-B';
    const row = input({ user_id, order_no: 'generation-gate' });
    const { row: pending } = await ledger.enqueueRefreshOrder(row, { now });
    assert.strictEqual(pending.sync_token, ''); assert.strictEqual(pending.sync_ready, 0);
    assert.strictEqual(await ledger.claimRefreshAttempt(pending.id, { now }), null, 'an absent token fails closed');
    assert.strictEqual(await ledger.claimRefreshAttempt(pending.id, { now, sync_token: '  ' }), null);
    assert.strictEqual(await ledger.claimRefreshAttempt(pending.id, { now, sync_token: tokenA }), null);
    assert.deepStrictEqual(await ledger.listPendingRefreshTasks({ now, user_ids: [user_id] }), []);
    assert.strictEqual((await ledger.beginRefreshOrderSync(user_id, { token: tokenA, now })).changes, 1);
    assert.strictEqual((await ledger.completeRefreshOrderSync(user_id, { token: tokenA, now })).changes, 1);
    const readByOldWorker = (await ledger.listPendingRefreshTasks({ now, user_ids: [user_id] }))[0];
    assert.strictEqual(readByOldWorker.sync_token, tokenA); assert.strictEqual(readByOldWorker.sync_ready, 1);
    // A failed newer sync leaves old pending work blocked even when its worker had already read it.
    await ledger.beginRefreshOrderSync(user_id, { token: tokenB, now: later });
    assert.deepStrictEqual(await ledger.listPendingRefreshTasks({ now: later, user_ids: [user_id] }), []);
    assert.strictEqual(await ledger.claimRefreshAttempt(pending.id, { now: later, sync_token: tokenA }), null);
    assert.strictEqual(await ledger.claimRefreshAttempt(pending.id, { now: later, sync_token: tokenB }), null);
    assert.strictEqual((await ledger.completeRefreshOrderSync(user_id, { token: tokenA, now: later })).changes, 0,
        'old synchronization cannot reopen a newer generation');
    const beforeStaleWrite = await ledger.getRefreshTaskById(pending.id);
    await ledger.observeActiveOrder({ ...row, order_status: '租赁中' }, { now: later, sync_token: tokenA });
    assert.deepStrictEqual(await ledger.getRefreshTaskById(pending.id), beforeStaleWrite, 'old observation cannot reset new pending state');
    assert.strictEqual((await ledger.enqueueRefreshOrder(row, { now: later, sync_token: tokenA })).queued, false);
    assert.deepStrictEqual(await ledger.getRefreshTaskById(pending.id), beforeStaleWrite);
    await ledger.completeRefreshOrderSync(user_id, { token: tokenB, now: later });
    assert.strictEqual((await ledger.listPendingRefreshTasks({ now: later, user_ids: [user_id] })).length, 1);
    const observed = await ledger.observeActiveOrder({ ...row, order_status: '租赁中' }, { now: later });
    assert.strictEqual(observed.status, 'watching'); assert.strictEqual(observed.sync_token, tokenB); assert.strictEqual(observed.sync_ready, 1);
    assert.strictEqual((await ledger.enqueueRefreshOrder(row, { now: later })).queued, false, 'tokenless enqueue cannot bypass generation');
    assert.strictEqual((await ledger.enqueueRefreshOrder(row, { now: later, sync_token: tokenA })).queued, false);
    assert.strictEqual((await ledger.enqueueRefreshOrder(row, { now: later, sync_token: tokenB })).queued, true);
    assert.strictEqual(await ledger.claimRefreshAttempt(pending.id, { now: later, sync_token: tokenA }), null);
    assert(await ledger.claimRefreshAttempt(pending.id, { now: later, sync_token: tokenB }));
    assert.strictEqual((await ledger.beginRefreshOrderSync(user_id, { token: 'sync-C', now: later })).changes, 0,
        'already consumed attempts never reset on a synchronization');

    const fresh = await ledger.observeActiveOrder(input({ user_id, order_no: 'generation-new-active' }), { now, sync_token: tokenB });
    assert.strictEqual(fresh.sync_token, tokenB); assert.strictEqual(fresh.sync_ready, 0);
    const tokenless = await ledger.observeActiveOrder(input({ user_id, order_no: 'generation-tokenless-active' }), { now });
    await ledger.observeActiveOrder(input({ user_id, order_no: 'generation-tokenless-active' }), { now, sync_token: tokenB });
    assert.strictEqual((await ledger.getRefreshTaskById(tokenless.id)).sync_token, tokenB);
    await ledger.enqueueRefreshOrder(input({ user_id, order_no: 'generation-new-pending' }), { now, sync_token: tokenB });
    const otherScene = await ledger.enqueueRefreshOrder(input({ user_id, order_no: 'generation-other-scene', business_scene: 'generation_other' }), { now, sync_token: tokenA });
    const otherTarget = await ledger.enqueueRefreshOrder(input({ user_id, order_no: 'generation-other-target', target_channel: 'uhaozu' }), { now, sync_token: tokenA });
    const otherUser = await ledger.enqueueRefreshOrder(input({ user_id: 43, order_no: 'generation-other-user' }), { now, sync_token: tokenA });
    await ledger.completeRefreshOrderSync(user_id, { token: tokenB, now });
    await ledger.beginRefreshOrderSync(user_id, { token: 'sync-C', now });
    for (const untouched of [otherScene.row, otherTarget.row, otherUser.row]) {
        const actual = await ledger.getRefreshTaskById(untouched.id);
        assert.strictEqual(actual.sync_token, tokenA); assert.strictEqual(actual.sync_ready, 0);
    }
    assert.strictEqual((await ledger.completeRefreshOrderSync(user_id, { token: tokenA, now, business_scene: 'generation_other' })).changes, 1);
    assert.strictEqual((await ledger.getRefreshTaskById(otherScene.row.id)).sync_ready, 1);
    assert.strictEqual((await ledger.beginRefreshOrderSync(user_id, { token: tokenB, now, business_scene: 'generation_other' })).changes, 1);
    assert.strictEqual((await ledger.getRefreshTaskById(otherScene.row.id)).sync_ready, 0);
    for (const method of [ledger.beginRefreshOrderSync, ledger.completeRefreshOrderSync]) {
        await assert.rejects(method(0, { token: tokenA }), /positive integer/);
        await assert.rejects(method(user_id), /non-empty string/);
    }
    await assert.rejects(ledger.observeActiveOrder(row, { sync_token: '' }), /non-empty string/);
    await assert.rejects(ledger.enqueueRefreshOrder(row, { sync_token: 1 }), /non-empty string/);
}

async function main() {
    await assert.rejects(ledger.getRefreshTaskByIdentity(key()), /no such table/);
    await assert.rejects(enqueue(), /no such table/);
    assert.deepStrictEqual(await query("SELECT name FROM sqlite_master WHERE type='table' AND name='order_game_info_refresh'"), [], 'reads and writes must not silently initialize schema');
    failSql = /CREATE INDEX IF NOT EXISTS idx_order_game_info_refresh_pending/;
    await assert.rejects(ledger.initOrderGameInfoRefreshDb(), /fixture database write failure/);
    assert.deepStrictEqual(await query("SELECT name FROM sqlite_master WHERE type='table' AND name='order_game_info_refresh'"), [], 'schema creation must roll back atomically');
    await assert.rejects(migrate(), /no such table: system_config/);
    assert.strictEqual((await query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='order_game_info_refresh'"))[0].n, 1,
        'order schema can commit before the main-database seed fails; retry must be safe');

    const mainDb = client.openMainDatabase();
    try { await configMigration.up({ db: mainDb, run }); } finally { await close(mainDb); }
    await migrate();
    await migrate();
    const cfg = await config.getSystemConfig('uuzuhao.order_game_info_refresh');
    assert.deepStrictEqual(cfg.value, { enabled: false, user_ids: [8], activated_at: '' });
    assert.strictEqual(migration.use_transaction, false);
    const columns = (await query('PRAGMA table_info(order_game_info_refresh)')).map(row => row.name);
    for (const name of ['id', 'create_date', 'modify_date', 'is_deleted', 'desc', 'attempted_at', 'observed_active_at', 'sync_token', 'sync_ready']) assert(columns.includes(name));
    assert.strictEqual((await query("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='order_game_info_refresh'"))[0].n, 1);
    const edited = await config.setSystemConfig(cfg.key, { enabled: true, user_ids: null, activated_at: '2026-11-12 09:00:00' }, { expectedId: cfg.id, expectedVersion: cfg.version });
    await migrate();
    assert.deepStrictEqual(await config.getSystemConfig(cfg.key), edited, 'repeat migration must preserve rollout policy');
    await config.deleteSystemConfig(cfg.key, { expectedId: edited.id, expectedVersion: edited.version });
    await migrate();
    assert.strictEqual((await config.getSystemConfig(cfg.key)).found, false, 'repeat migration must not revive deleted policy');

    assert.strictEqual(await ledger.getRefreshTaskById(999), null);
    assert.strictEqual(await ledger.getRefreshTaskByIdentity(key()), null);
    let task = await ledger.observeActiveOrder(input({ order_status: '租赁中', target_product_id: '' }), { now });
    assert.strictEqual(task.status, 'watching');
    assert.strictEqual(task.observed_active_at, '2026-11-12 12:00:00');
    assert.deepStrictEqual(task.result_summary, {});
    const again = await ledger.observeActiveOrder(input({ order_status: '租赁中', source_order_status: 'ignored' }), { now: earlier });
    assert.strictEqual(again.id, task.id);
    assert.strictEqual(again.observed_active_at, task.observed_active_at, 'clock moving backwards must not erase observation');
    const queued = await enqueue();
    assert.strictEqual(queued.created, false);
    assert.strictEqual(queued.queued, true);
    assert.strictEqual(queued.row.id, task.id);
    assert.strictEqual(queued.row.status, 'pending');
    assert.strictEqual((await enqueue()).queued, false, 'repeated sync must not requeue');
    assert.strictEqual(await ledger.deferRefreshTask(task.id, { reason: 'new rental', now, next_check_at: later }), true);
    assert.strictEqual((await enqueue()).row.next_check_at, '2026-11-12 12:10:00', 'duplicate scans must preserve deferral');
    assert.strictEqual((await ledger.listPendingRefreshTasks({ now })).length, 0);
    assert.strictEqual(await claim(task.id, { now }), null);
    task = await ledger.observeActiveOrder(input({ order_status: '租赁中' }), { now: later });
    assert.strictEqual(task.status, 'watching', 'a renewed rental invalidates unsent queue eligibility');
    assert.strictEqual(task.next_check_at, '');
    assert.strictEqual((await enqueue({}, { now: later })).queued, true);
    assert.strictEqual((await ledger.listPendingRefreshTasks({ now: later, user_ids: [8, 8] })).length, 1);
    assert.deepStrictEqual(await ledger.listPendingRefreshTasks({ user_ids: [], now: later }), []);
    assert.deepStrictEqual(await ledger.listPendingRefreshTasks({ user_ids: [9], now: later }), []);

    const claims = await Promise.all(Array.from({ length: 8 }, () => claim(task.id, { now: later })));
    assert.strictEqual(claims.filter(Boolean).length, 1, 'only one concurrent caller can consume an attempt');
    assert.strictEqual(claims.find(Boolean).attempted_at, '2026-11-12 12:10:00');
    assert.strictEqual((await enqueue()).queued, false);
    assert.strictEqual((await ledger.observeActiveOrder(input(), { now: later })).status, 'sending', 'new observations cannot reset an attempted task');
    assert.strictEqual(await ledger.deferRefreshTask(task.id, { next_check_at: later }), false);
    assert.strictEqual(await ledger.skipRefreshTask(task.id, { reason: 'too late', now }), false);
    assert.strictEqual(await ledger.finishRefreshAttempt(task.id, { status: 'success', code: 0, message: 'ok', now: later,
        summary: { http_status: 200, data_type: 'object', game_account_info_count: 8, product_item_num: null, cause_code: false,
            data_keys: ['gameAccountInfoList', 1, 'x'.repeat(120)], raw: { password: 'never persist' }, app_secret: 'never persist', error_name: { raw: true } } }), true);
    task = await ledger.getRefreshTaskById(task.id);
    assert.strictEqual(task.status, 'success');
    assert.strictEqual(task.result_code, '0');
    assert.strictEqual(task.result_message, 'ok');
    assert.deepStrictEqual(task.result_summary, { http_status: 200, data_type: 'object', game_account_info_count: 8, product_item_num: null, cause_code: false,
        data_keys: ['gameAccountInfoList', 'x'.repeat(100)] });
    assert(!JSON.stringify(task).includes('never persist'));
    assert.strictEqual(await ledger.finishRefreshAttempt(task.id, { status: 'failed' }), false);
    assert.strictEqual(await claim(task.id), null);

    const otherUser = await enqueue({ user_id: 9 });
    const otherChannel = await enqueue({ channel: 'zuhaowang' });
    const otherScene = await enqueue({ business_scene: 'other_scene' });
    const otherTarget = await enqueue({ target_channel: 'other_target' });
    assert([otherUser, otherChannel, otherScene, otherTarget].every(row => row.created), 'all business identity dimensions must be isolated');
    assert.strictEqual((await ledger.listPendingRefreshTasks({ now, user_ids: null })).length, 2, 'default queue excludes other scenes and targets');
    assert.strictEqual((await ledger.listPendingRefreshTasks({ now, business_scene: 'other_scene' }))[0].id, otherScene.row.id);
    assert.strictEqual((await ledger.listPendingRefreshTasks({ now, target_channel: 'other_target' }))[0].id, otherTarget.row.id);
    for (const other of [otherScene, otherTarget]) {
        assert.strictEqual(await claim(other.row.id, { now }), null);
        assert.strictEqual(await ledger.deferRefreshTask(other.row.id, { now, next_check_at: later }), false);
        assert.strictEqual(await ledger.skipRefreshTask(other.row.id), false);
    }
    const scoped = { now, business_scene: 'other_scene' };
    assert(await claim(otherScene.row.id, scoped));
    assert.strictEqual(await ledger.finishRefreshAttempt(otherScene.row.id, { status: 'success', now }), false);
    assert.strictEqual((await ledger.recoverStaleRefreshAttempts({ now: later, before: now })).changes, 0, 'default recovery excludes another business scene');
    assert.strictEqual((await ledger.recoverStaleRefreshAttempts({ ...scoped, now: later, before: now })).changes, 1);
    assert.strictEqual((await ledger.getRefreshTaskById(otherScene.row.id)).status, 'unknown');
    assert.strictEqual(await claim(otherScene.row.id, { ...scoped, now: later }), null);

    const failure = await enqueue({ order_no: 'failure' });
    await claim(failure.row.id, { now });
    assert.strictEqual((await ledger.recoverStaleRefreshAttempts({ now, before: earlier })).changes, 0);
    assert.strictEqual(await ledger.finishRefreshAttempt(failure.row.id, { status: 'failed', code: 'E'.repeat(120), message: 'm'.repeat(400), summary: null, now }), true);
    const failed = await ledger.getRefreshTaskById(failure.row.id);
    assert.strictEqual(failed.result_code.length, 100);assert.strictEqual(failed.result_message.length, 300);
    assert.deepStrictEqual(failed.result_summary, {});
    const unknown = await enqueue({ order_no: 'unknown' });
    await claim(unknown.row.id, { now });
    await ledger.finishRefreshAttempt(unknown.row.id, { status: 'unknown', summary: [] });
    const interrupted = await enqueue({ order_no: 'interrupted' });
    await claim(interrupted.row.id, { now });
    assert.strictEqual((await ledger.recoverStaleRefreshAttempts({ now: later, before: now })).changes, 1);
    assert.strictEqual((await ledger.getRefreshTaskById(interrupted.row.id)).result_code, 'PROCESS_INTERRUPTED');
    assert.strictEqual((await enqueue({ order_no: 'interrupted' })).queued, false, 'stale sending is never automatically replayed');
    assert.strictEqual(await ledger.skipRefreshTask(otherUser.row.id, { now, reason: 'mapping changed' }), true);
    assert.strictEqual((await ledger.getRefreshTaskById(otherUser.row.id)).status, 'skipped');
    assert.strictEqual((await enqueue({ user_id: 9 })).queued, false);
    assert.strictEqual(await ledger.deferRefreshTask(otherChannel.row.id, { now, next_check_at: later }), true);
    assert.strictEqual((await ledger.listPendingRefreshTasks({ now: later, limit: 1 })).length, 1);

    await query('UPDATE order_game_info_refresh SET is_deleted=1 WHERE id=?', [task.id], true);
    assert.strictEqual((await enqueue()).created, false, 'logical deletion must not release identity');
    assert.strictEqual(await claim(task.id, { now: later }), null);
    const watch = await ledger.observeActiveOrder(input({ order_no: 'watch-to-skip', game_name: '', target_product_id: '', order_status: '', source_order_status: '租赁中', start_time: '', end_time: '' }));
    assert.strictEqual(watch.source_order_status, '租赁中');
    assert.strictEqual(await ledger.skipRefreshTask(watch.id), true);

    failSql = /^COMMIT/;
    await assert.rejects(enqueue({ order_no: 'commit-failure' }), /fixture database write failure/);
    assert.strictEqual(await ledger.getRefreshTaskByIdentity(key({ order_no: 'commit-failure' })), null, 'failed commit rolls back inserted attempt');
    const registrations = await Promise.all(Array.from({ length: 8 }, () => enqueue({ order_no: 'concurrent-registration' })));
    assert.strictEqual(registrations.filter(item => item.created).length, 1);
    assert.strictEqual(registrations.filter(item => item.queued).length, 1, 'concurrent registration must queue only once without sqlite threadpool starvation');
    assert.strictEqual(new Set(registrations.map(item => item.row.id)).size, 1);
    const fairness = { now, business_scene: 'fairness' };
    const waiting1 = await enqueue({ order_no: 'fairness-old-1', business_scene: fairness.business_scene });
    const waiting2 = await enqueue({ order_no: 'fairness-old-2', business_scene: fairness.business_scene });
    const fresh = await enqueue({ order_no: 'fairness-new', business_scene: fairness.business_scene });
    await ledger.deferRefreshTask(waiting1.row.id, { ...fairness, next_check_at: now });
    await ledger.deferRefreshTask(waiting2.row.id, { ...fairness, next_check_at: now });
    assert.strictEqual((await ledger.listPendingRefreshTasks({ ...fairness, now: later, limit: 1 }))[0].id, fresh.row.id,
        'new tasks must not be starved by older authorization deferrals with lower IDs');
    await claim(fresh.row.id, { ...fairness, now: later });
    await ledger.finishRefreshAttempt(fresh.row.id, { ...fairness, status: 'success', now: later });
    assert.strictEqual((await ledger.listPendingRefreshTasks({ ...fairness, now: later, limit: 1 }))[0].id, waiting1.row.id);
    await ledger.deferRefreshTask(waiting1.row.id, { ...fairness, now: later, next_check_at: '2026-11-12 12:20:00' });
    assert.strictEqual((await ledger.listPendingRefreshTasks({ ...fairness, now: later, limit: 1 }))[0].id, waiting2.row.id,
        'repeated deferral must rotate behind other due work');

    await query(`CREATE TABLE "order" (id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER,channel TEXT,order_no TEXT,
        game_id TEXT,game_name TEXT,game_account TEXT,role_name TEXT,order_status TEXT,start_time TEXT,end_time TEXT,is_deleted INTEGER)` , [], true);
    await source({ order_no: 'fresh' });
    await source({ order_no: 'old', start_time: '2026-11-11 10:00:00', end_time: '2026-11-11 11:00:00' });
    await source({ order_no: 'old-active', order_status: '租赁中', start_time: '2026-11-11 10:00:00' });
    await source({ order_no: 'old-watched', start_time: '2026-11-11 10:00:00' });
    await ledger.observeActiveOrder(input({ order_no: 'old-watched' }), { now });
    await source({ order_no: 'other-scene-watch', start_time: '2026-11-11 10:00:00' });
    await ledger.observeActiveOrder(input({ order_no: 'other-scene-watch', business_scene: 'other_scene' }), { now });
    await source({ order_no: 'deleted', is_deleted: 1 });
    await source({ order_no: 'user9', user_id: 9 });
    const options = { activated_at: '2026-11-12 00:00:00', limit: 2 };
    const first = await ledger.listSourceOrdersForRefresh(8, options);
    assert.deepStrictEqual(first.map(row => row.order_no), ['fresh', 'old-active']);
    const second = await ledger.listSourceOrdersForRefresh(8, { ...options, after_id: first[1].id });
    assert.deepStrictEqual(second.map(row => row.order_no), ['old-watched']);
    assert.strictEqual(second[0].task_status, 'watching');
    assert.strictEqual(second[0].observed_active_at, '2026-11-12 12:00:00');
    const alt = await ledger.listSourceOrdersForRefresh(8, { ...options, limit: 100, business_scene: 'other_scene', target_channel: 'uuzuhao' });
    assert(alt.some(row => row.order_no === 'other-scene-watch'));
    assert(!alt.some(row => row.order_no === 'old-watched'));
    const found = await ledger.getSourceOrder(8, 'uhaozu', 'fresh');
    assert.strictEqual(found.game_account, 'QQ-A');
    assert.strictEqual(await ledger.getSourceOrder(9, 'uhaozu', 'fresh'), null);
    assert.strictEqual((await ledger.getSourceOrder(8, 'uhaozu', 'deleted')).is_deleted, 1, 'processor must see deleted source state');
    for (const status of ['sending', 'success', 'failed', 'unknown', 'skipped', 'deleted']) {
        const order_no = `processed-source-${status}`;
        await source({ order_no });
        const record = await enqueue({ order_no });
        if (status === 'skipped') await ledger.skipRefreshTask(record.row.id);
        else if (status === 'deleted') await query('UPDATE order_game_info_refresh SET is_deleted=1 WHERE id=?', [record.row.id], true);
        else {
            await claim(record.row.id, { now });
            if (status !== 'sending') await ledger.finishRefreshAttempt(record.row.id, { status, now });
        }
    }
    const candidates = await ledger.listSourceOrdersForRefresh(8, { ...options, limit: 1000 });
    assert(candidates.every(row => !row.order_no.startsWith('processed-source-')),
        'already attempted, skipped and deleted identities must not return as source candidates');
    await ledger.listSourceOrdersForRefresh(8);

    await syncGenerationGate();

    for (const invalid of [0, -1, 1.2, '8', Number.NaN]) await assert.rejects(ledger.getRefreshTaskById(invalid), /positive integer/);
    for (const overrides of [{ user_id: 0 }, { channel: '' }, { order_no: '' }, { business_scene: '' }, { target_channel: '' }, { game_id: '' }, { game_account: '' }, { target_product_id: 123 }]) {
        await assert.rejects(enqueue(overrides), /positive integer|non-empty string/);
    }
    await assert.rejects(ledger.getSourceOrder(8, '', 'x'), /channel/);
    await assert.rejects(ledger.listSourceOrdersForRefresh(0, options), /user_id/);
    await assert.rejects(ledger.listSourceOrdersForRefresh(8, { ...options, after_id: -1 }), /after_id/);
    await assert.rejects(ledger.listSourceOrdersForRefresh(8, { ...options, activated_at: 'bad' }), /timestamp/);
    for (const limit of [0, 1001, 1.5]) await assert.rejects(ledger.listPendingRefreshTasks({ limit }), /limit/);
    for (const ids of ['8', [0], Array(1001).fill(8)]) await assert.rejects(ledger.listPendingRefreshTasks({ user_ids: ids }), /user_ids|user_id/);
    await assert.rejects(ledger.listPendingRefreshTasks({ now: new Date('bad') }), /timestamp/);
    await assert.rejects(ledger.finishRefreshAttempt(1, { status: 'pending' }), /completion status/);
    await assert.rejects(ledger.skipRefreshTask(0), /positive integer/);
    await assert.rejects(claim(0), /positive integer/);
    await assert.rejects(ledger.deferRefreshTask(0), /positive integer/);
    await assert.rejects(ledger.recoverStaleRefreshAttempts({ before: 'bad' }), /timestamp/);
    console.log('[PASS] order_game_info_refresh_db_test: scoped durable attempts, migration, history and concurrency');
}

main().then(() => fs.rmSync(dir, { recursive: true, force: true })).catch(error => {
    console.error(error.stack || error.message);process.exitCode = 1;
});
