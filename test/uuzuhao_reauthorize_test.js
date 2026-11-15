'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-reauthorize-'));
for (const name of ['MAIN', 'RUNTIME', 'ORDER', 'STATS', 'PRICE']) process.env[`${name}_DB_FILE_PATH`] = path.join(dir, `${name}.db`);
global.fetch = async () => { throw new Error('unexpected external request'); };
const api = require('../uuzuhao/uuzuhao_api');
const storage = require('../database/uuzuhao_reauthorize_db');
const tasks = require('../database/runtime_task_db');
const accountDb = require('../database/user_game_account_db');
const userDb = require('../database/user_db');
const authDb = require('../database/user_platform_auth_db');
const { openMainDatabase, openRuntimeDatabase } = require('../database/sqlite_client');
const { recordUuzuhaoAuthObservation } = require('../database/uuzuhao_auth_state_db');
const { createRecoveryService, startReauthorizeWorker, listRecoveryViews } = require('../product/uuzuhao_reauthorize_service');
const auth = { app_key: 'fixture-key', app_secret: 'fixture-secret', api_base: 'https://fixture.invalid' };
const sql = async (statement, params = [], runtime = false) => {
    const db = runtime ? openRuntimeDatabase() : openMainDatabase();
    try { return await new Promise((resolve, reject) => db.all(statement, params, (e, r) => e ? reject(e) : resolve(r))); }
    finally { db.close(); }
};
const log = [];
const logger = { log: x => log.push(x), error: x => log.push(x) };
let now = Date.now(), creates = 0, queries = 0, result = 1, createFail = false;
const deps = { enabled: () => true, now: () => now, logger,
    createReauthorizeTask: async account => { creates++; if (createFail) throw new Error('secret=do-not-log');
        return { task_id: `remote-${account}`, game_union_id: `1_${account}` }; },
    queryReauthorizeTask: async () => { queries++; if (result === 'timeout') throw new Error('secret=do-not-log'); return { status: result }; } };
const service = () => createRecoveryService(deps);
async function seed(account, gameId = '1', userId = 8, rawOnly = false) {
    await accountDb.upsertUserGameAccount({ user_id: userId, game_account: account, game_id: gameId,
        channel_status: { uuzuhao: '下架', uhaozu: '上架' },
        channel_prd_info: { uuzuhao: { prd_id: `p-${account}`, off_type: 'AUTHORIZE_ERROR', reason: '授权失效', hourPrice: 2.5 },
            uhaozu: { prd_id: 'other', reason: 'other reason' } }, switch: { prod_guard_enabled: false } });
    if (!rawOnly) await recordUuzuhaoAuthObservation(userId, { game_account: account, game_id: gameId },
        { required: true, request_started_at: now, error_code: '12115012', reason: '上架授权失效' });
    const row = (await storage.listRecoveryAccounts()).find(x => x.game_account === account && x.user_id === userId && x.game_id === gameId);
    return row;
}
const latest = async row => (await storage.listRecoveryTasks()).get(row.id);
async function clearFixtures() {
    await sql('DELETE FROM runtime_task', [], true);
    await sql('DELETE FROM user_game_account');
    creates = queries = 0; createFail = false; result = 1;
}
async function apiTests() {
    const calls = [];
    let response = { code: 0, data: { taskId: 'remote', gameUnionId: '1_123' } };
    global.fetch = async (url, options) => { const body = JSON.parse(options.body); calls.push({ url, body });
        assert.strictEqual(body.sign, api._internals.createSign(body, auth.app_secret));
        return { ok: true, status: 200, text: async () => JSON.stringify(response) }; };
    for (const options of [{}, { game_id: 0 }, { game_id: 4 }, { game_id: 1.5 }]) {
        await assert.rejects(api.createReauthorizeTask('123', options), /gameId/);
    }
    await assert.rejects(api.createReauthorizeTask('', { game_id: 1 }), /accountNo/);
    for (const game_id of [1, 2, 3]) {
        response.data.gameUnionId = `${game_id}_123`;
        assert.strictEqual((await api.createReauthorizeTask('123', { game_id, auth })).task_id, 'remote');
        assert.strictEqual(calls.at(-1).body.scene, 'reauthorize');
        assert.ok(calls.at(-1).url.endsWith('/hosting/create'));
    }
    response.data.gameUnionId = '1_other';
    await assert.rejects(api.createReauthorizeTask('123', { game_id: 1, auth }), /身份/);
    response = { code: 0, data: {} };
    await assert.rejects(api.createReauthorizeTask('123', { game_id: 1, auth }), /taskId/);
    await assert.rejects(api.queryReauthorizeTask('123', '', { game_id: 1, auth }), /taskId/);
    for (const status of [-1, 1, 2, 3]) {
        response = { code: 0, data: { status, errorMessage: 'password=hidden', captchaUrl: 'https://secret.invalid' } };
        assert.deepStrictEqual(await api.queryReauthorizeTask('123', 'remote', { game_id: 1, auth }), { status });
        assert.ok(calls.at(-1).url.endsWith('/hosting/status'));
        assert.strictEqual(calls.at(-1).body.taskId, 'remote');
        assert.strictEqual(calls.at(-1).body.accountNo, '123');
    }
    response = { code: 0, data: { status: '2' } };
    await assert.rejects(api.queryReauthorizeTask('123', 'remote', { game_id: 1, auth }), /未知/);
    response = { code: 100, msg: 'failure' };
    await assert.rejects(api.createReauthorizeTask('123', { game_id: 1, auth }), /code=100/);
    global.fetch = async () => { throw new Error('offline'); };
}
async function main() {
    await apiTests();
    await userDb.initUserDb();
    await accountDb.initUserGameAccountDb();
    await tasks.initRuntimeTaskDb();
    for (const id of [8, 12]) {
        await sql("INSERT INTO user(id,account,password,status) VALUES (?,?,?,'enabled')", [id, `fixture-${id}`, 'fixture']);
        await authDb.upsertUserPlatformAuth({ user_id: id, platform: 'uuzuhao', auth_type: 'token', auth_status: 'valid', auth_payload: auth });
    }
    assert.deepStrictEqual(storage.object('bad'), {});
    assert.deepStrictEqual(storage.object('[]'), {});
    assert.deepStrictEqual(storage.object('null'), {});
    assert.deepStrictEqual(storage.object({ a: 1 }), { a: 1 });
    assert.deepStrictEqual(await createRecoveryService({ enabled: () => false }).tick(), { skipped: true, reason: 'disabled' });
    assert.strictEqual((await createRecoveryService({ enabled: () => true, tryAcquireLock: async () => ({ acquired: false }) }).tick()).reason, 'locked');
    const row = await seed('first');
    const before = await storage.getRecoveryAccount(row.id);
    await service().tick();
    assert.strictEqual(creates, 1); assert.strictEqual(queries, 0);
    assert.strictEqual((await latest(row)).state.next_query_at, now + 90000);
    await service().tick(); assert.strictEqual(creates, 1);
    now += 89999; await service().tick(); assert.strictEqual(queries, 0);
    now++; result = 2; await service().tick();
    assert.strictEqual(queries, 1);
    const recovered = await storage.getRecoveryAccount(row.id);
    assert.strictEqual(recovered.uuzuhao_auth_state.required, false);
    assert.strictEqual(recovered.channel_prd_info.uuzuhao.off_type, '');
    assert.strictEqual(recovered.channel_prd_info.uuzuhao.hourPrice, 2.5);
    assert.deepStrictEqual(recovered.channel_prd_info.uhaozu, before.channel_prd_info.uhaozu);
    assert.strictEqual(recovered.channel_status, before.channel_status);
    assert.strictEqual(recovered.switch, before.switch);
    assert.strictEqual((await latest(row)).stage, 'recovered');
    assert.strictEqual((await listRecoveryViews(8))['1::first'].query_count, 1);
    assert.deepStrictEqual(await listRecoveryViews(12), {});
    await service().tick(); assert.strictEqual(queries, 1);
    for (const status of [1, -1, 3, 'timeout']) {
        await clearFixtures(); result = status;
        const failed = await seed(`failed-${status}`);
        await service().tick();
        for (let i = 1; i <= 3; i++) {
            now += 90000; await service().tick();
            assert.strictEqual(queries, i);
            assert.strictEqual((await storage.getRecoveryAccount(failed.id)).uuzuhao_auth_state.required, true);
        }
        assert.strictEqual((await latest(failed)).stage, 'manual_required');
        assert.strictEqual((await latest(failed)).status, 'manual_required');
        now += 90000 * 5; await service().tick();
        assert.strictEqual(creates, 1); assert.strictEqual(queries, 3);
        // Ordinary detector rewrites cannot reset manual intervention or the query budget.
        await recordUuzuhaoAuthObservation(8, { game_id: '1', game_account: failed.game_account },
            { required: true, request_started_at: now, error_code: '12115012' });
        await service().tick(); assert.strictEqual(creates, 1);
    }
    assert.ok(!log.join('\n').includes('do-not-log'));
    const manual = (await storage.listRecoveryAccounts())[0];
    await sql("UPDATE runtime_task SET create_date='2000-01-01 00:00:00' WHERE task_type=?", [storage.TASK_TYPE], true);
    await require('../maintenance/runtime_task_prune_service').pruneRuntimeTaskRows(1);
    assert.strictEqual((await latest(manual)).stage, 'manual_required');
    await recordUuzuhaoAuthObservation(8, { game_id: '1', game_account: manual.game_account },
        { required: false, request_started_at: now + 1 });
    await recordUuzuhaoAuthObservation(8, { game_id: '1', game_account: manual.game_account },
        { required: true, request_started_at: now + 2, error_code: '12115012' });
    await service().tick();
    assert.strictEqual(creates, 2, 'a new incident must not inherit the previous manual-intervention stop');
    await clearFixtures();
    let third = await seed('third'); await service().tick();
    for (let i = 0; i < 3; i++) { now += 90000; result = i === 2 ? 2 : 1; await service().tick(); }
    assert.strictEqual((await latest(third)).stage, 'recovered');
    assert.strictEqual(queries, 3);
    await seed('third'); await service().tick(); assert.strictEqual(creates, 2, 'a new failure after recovery starts a new episode');
    await clearFixtures(); createFail = true;
    let failed = await seed('create-fail'); await service().tick(); await service().tick();
    assert.strictEqual(creates, 1); assert.strictEqual(queries, 0);
    assert.strictEqual((await latest(failed)).stage, 'manual_required');
    await clearFixtures();
    const raw = await seed('raw-only', '1', 8, true);
    await service().tick(); result = 2; now += 90000; await service().tick();
    assert.strictEqual(storage.hasAuthorizationError(await storage.getRecoveryAccount(raw.id)), false);
    await clearFixtures();
    const superseded = await seed('newer'); await service().tick();
    now += 90000;
    await recordUuzuhaoAuthObservation(8, { game_id: '1', game_account: 'newer' },
        { required: true, request_started_at: now + 10, error_code: '12115014' });
    result = 2; await service().tick();
    assert.strictEqual((await latest(superseded)).stage, 'superseded');
    assert.strictEqual((await storage.getRecoveryAccount(superseded.id)).uuzuhao_auth_state.required, true);
    await clearFixtures();
    const interrupted = await seed('interrupted'); await service().tick();
    let t = await latest(interrupted);
    await tasks.updateRuntimeTask(t.task_id, { stage: 'submitting', result_json: { ...t.state, remote_task_id: '' } });
    await service().tick(); assert.strictEqual((await latest(interrupted)).stage, 'manual_required');
    assert.strictEqual(creates, 1);
    await clearFixtures();
    const checking = await seed('last-query-crash'); await service().tick(); t = await latest(checking);
    await tasks.updateRuntimeTask(t.task_id, { stage: 'checking', result_json: { ...t.state, query_count: 3 } });
    now += 90000; await service().tick(); assert.strictEqual(queries, 0);
    assert.strictEqual((await latest(checking)).stage, 'manual_required');
    await clearFixtures();
    const external = await seed('external'); await service().tick();
    await sql("UPDATE user_game_account SET uuzuhao_auth_state='{}',channel_prd_info='{}' WHERE id=?", [external.id]);
    await service().tick(); assert.strictEqual((await latest(external)).stage, 'external_recovered');
    await clearFixtures();
    const conflict = await seed('conflict');
    const revoke = await tasks.createRuntimeTask({ user_id: 8, task_type: 'uuzuhao_auth_revoke',
        result_json: { input: { game_id: '1', game_account: conflict.game_account } } });
    await service().tick(); assert.strictEqual(creates, 0);
    assert.strictEqual(await storage.hasAuthorizationConflict(conflict, 'revoke'), false, 'queued recovery must not deadlock a revoke task');
    await tasks.markRuntimeTaskFinished(revoke.task_id);
    await service().tick(); assert.strictEqual(creates, 1);
    assert.strictEqual(await storage.hasAuthorizationConflict(conflict, 'revoke'), true);
    await storage.withAuthorizationLock(conflict, async () => {
        const nested = await storage.withAuthorizationLock(conflict, async () => assert.fail('must not run'));
        assert.strictEqual(nested.acquired, false);
    });
    await clearFixtures();
    const unsupported = await seed('csgo', '4'); await service().tick();
    assert.strictEqual(creates, 0); assert.strictEqual((await latest(unsupported)).stage, 'manual_required');
    await clearFixtures();
    const blocked = await seed('disabled');
    for (const change of ["UPDATE user_platform_auth SET channel_enabled=0", "UPDATE user SET status='disabled'",
        "UPDATE user_game_account SET is_deleted=1", "UPDATE user_game_account SET manual_deleted=1",
        "UPDATE user_game_account SET asset_status='sold'", "UPDATE user_platform_auth SET auth_status='expired'",
        "UPDATE user_platform_auth SET expire_at='2000-01-01'", "UPDATE user_platform_auth SET auth_payload='{}'"]) {
        await sql(change); await service().tick(); assert.strictEqual(creates, 0);
        await sql("UPDATE user_platform_auth SET channel_enabled=1,auth_status='valid',expire_at='',auth_payload=?", [JSON.stringify(auth)]);
        await sql("UPDATE user SET status='enabled'");
        await sql("UPDATE user_game_account SET is_deleted=0,manual_deleted=0,asset_status='active'");
    }
    await service().tick(); assert.strictEqual(creates, 1);
    await sql('UPDATE user_platform_auth SET channel_enabled=0'); now += 90000; await service().tick();
    assert.strictEqual(queries, 0);
    await sql('UPDATE user_platform_auth SET channel_enabled=1'); result = 2; await service().tick(); assert.strictEqual(queries, 1);
    const deleted = await seed('delete-before-clear');
    await sql('UPDATE user_game_account SET is_deleted=1 WHERE id=?', [deleted.id]);
    assert.strictEqual(await storage.clearRecoveredAuthorization(deleted, now), false);
    assert.strictEqual(await storage.getRecoveryAccount(-100), null);
    await assert.rejects(createRecoveryService({ ...deps, touchLock: async () => false }).tick(), /lease lost/);
    assert.strictEqual((await createRecoveryService({ ...deps, listRecoveryAccounts: async () => [blocked],
        getRecoveryAccount: async () => { throw new Error('fixture'); } }).tick()).errors, 1);
    assert.strictEqual((await createRecoveryService({ ...deps, listRecoveryAccounts: async () => [blocked],
        getRecoveryAccount: async () => null }).tick()).processed, 0);
    await clearFixtures();
    const priceUpdate = await seed('price-update');
    await service().tick();
    await sql("UPDATE user_game_account SET channel_prd_info=json_set(channel_prd_info,'$.uuzuhao.hourPrice',3.2) WHERE id=?", [priceUpdate.id]);
    now += 90000; result = 2; await service().tick();
    assert.strictEqual((await latest(priceUpdate)).stage, 'recovered');
    assert.strictEqual((await storage.getRecoveryAccount(priceUpdate.id)).channel_prd_info.uuzuhao.hourPrice, 3.2);
    await clearFixtures();
    const identityUpdate = await seed('identity-update'); await service().tick();
    await sql("UPDATE user_game_account SET channel_prd_info=json_set(channel_prd_info,'$.uuzuhao.prd_id','new-product') WHERE id=?", [identityUpdate.id]);
    now += 90000; result = 2; await service().tick();
    assert.strictEqual((await latest(identityUpdate)).stage, 'superseded');
    assert.strictEqual((await storage.getRecoveryAccount(identityUpdate.id)).uuzuhao_auth_state.required, true);
    await clearFixtures();
    const rollback = await seed('rollback');
    await sql("CREATE TRIGGER fixture_fail_recovery BEFORE UPDATE ON user_game_account BEGIN SELECT RAISE(ABORT,'fixture failure'); END");
    await assert.rejects(storage.clearRecoveredAuthorization(rollback, now), /fixture failure/);
    await sql('DROP TRIGGER fixture_fail_recovery');
    assert.strictEqual((await storage.getRecoveryAccount(rollback.id)).uuzuhao_auth_state.required, true);
    await clearFixtures();
    const persistent = await seed('restore-crash');
    await service().tick(); now += 90000; result = 2;
    await createRecoveryService({ ...deps, clearRecoveredAuthorization: async () => { throw new Error('DB busy'); } }).tick();
    assert.strictEqual((await latest(persistent)).stage, 'restoring');
    assert.strictEqual(queries, 1);
    await service().tick();
    assert.strictEqual(queries, 1, 'a durable successful response is restored without a duplicate query');
    assert.strictEqual((await latest(persistent)).stage, 'recovered');
    await httpTests();
    await revokeConflictTests();
    await timerTests();
    await frontendTests();
    console.log('[PASS] reauthorize: API signatures, 90s/3 queries, persistence, recovery/manual, restart, isolation and UI');
}
async function revokeConflictTests() {
    await clearFixtures();
    const row = await seed('manual-revoke-conflict');
    await service().tick();
    const revoke = require('../order/auth_revoke_task_service');
    const task = await revoke.enqueueManualAuthRevokeTask(8, { game_id: '1', game_account: row.game_account }, { start_worker: false });
    assert.strictEqual((await revoke.processAuthRevokeTasks()).deferred, 1);
    assert.strictEqual((await tasks.getRuntimeTaskByTaskId(task.task.task_id)).stage, 'waiting_reauthorization');
    await storage.withAuthorizationLock(row, async () => {
        assert.strictEqual((await revoke.processAuthRevokeTasks()).deferred, 1);
    });
    assert.strictEqual(queries, 0);
    assert.strictEqual(creates, 1);
}
async function httpTests() {
    await clearFixtures(); result = 1;
    process.env.H5_PORT = '0'; process.env.SHEEP_FIX_ENABLE = '0'; process.env.BL_V2_INSPECTOR_ENABLE = '0';
    process.env.UUZUHAO_AUTO_REAUTHORIZE_ENABLED = '0';
    const row = await seed('http-progress');
    await service().tick();
    const { bootstrap } = require('../h5/local_h5_server');
    const server = await bootstrap();
    const { createAccessToken } = require('../user/auth_token');
    const http = require('http');
    const list = uid => new Promise((resolve, reject) => {
        http.get({ hostname: '127.0.0.1', port: server.address().port, path: '/api/products?game_name=ALL',
            headers: { Authorization: `Bearer ${createAccessToken({ id: uid, account: `fixture-${uid}` })}` } }, res => {
            let text = ''; res.on('data', chunk => { text += chunk; }); res.on('end', () => {
                try { assert.strictEqual(res.statusCode, 200, text); resolve(JSON.parse(text)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
    try {
        let item = (await list(8)).list.find(x => x.game_account === row.game_account);
        assert.strictEqual(item.uuzuhao_recovery.stage, 'waiting_result');
        assert.strictEqual(item.uuzuhao_auth_state.required, true);
        assert.strictEqual((await list(12)).list.some(x => x.game_account === row.game_account), false);
        for (let i = 0; i < 3; i++) { now += 90000; await service().tick(); }
        item = (await list(8)).list.find(x => x.game_account === row.game_account);
        assert.strictEqual(item.uuzuhao_recovery.stage, 'manual_required');
        assert.strictEqual(item.uuzuhao_recovery.query_count, 3);
        assert.strictEqual(item.uuzuhao_auth_state.required, true);
        assert.ok(!JSON.stringify(item.uuzuhao_recovery).includes('fixture-secret'));
    } finally {
        await new Promise(resolve => server.close(resolve));
        require('../product/prod_status_guard').stopProdRiskTaskWorker();
    }
}
async function timerTests() {
    assert.strictEqual(startReauthorizeWorker({ enabled: () => false }).started, false);
    let callback, stopped = false, release;
    const worker = startReauthorizeWorker({ enabled: () => true, logger,
        service: { tick: () => new Promise(resolve => { release = resolve; }) },
        setInterval: (fn, ms) => { callback = fn; assert.strictEqual(ms, 15000); return { unref() {} }; },
        clearInterval: () => { stopped = true; } });
    await callback(); release(); await new Promise(setImmediate); worker.stop(); assert.strictEqual(stopped, true);
    const fail = startReauthorizeWorker({ enabled: () => true, logger, service: { tick: async () => { throw new Error('fixture'); } },
        setInterval: fn => ({ unref() {} }), clearInterval() {} });
    await new Promise(setImmediate); fail.stop(); assert.ok(log.includes('[UuzuhaoReauthorize] error=worker_failed'));
}
async function frontendTests() {
    const context = vm.createContext({ window: {} });
    for (const file of ['ui/channel_price_summary.js', 'ui/uuzuhao_auth_status.js', 'menu_products.js']) {
        const filename = path.resolve(__dirname, '../h5/public/js', file);
        vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    }
    for (const game_id of ['1','2','3','4']) {
        const item = { game_id, uuzuhao_auth_state: { required: true }, uuzuhao_recovery: { stage: 'waiting_result', query_count: 1 },
            price_ladder: { uuzuhao: { current_tier: 2, hour_price: 2.5 } } };
        assert.strictEqual(context.window.UuzuhaoAuthStatus.recoveryLabel(item), '授权异常，自动恢复中（已查询1/3次）');
        assert.ok(context.platformBadges(item)[0].text.includes('2档 · ¥2.50/时'));
        item.uuzuhao_recovery.stage = 'manual_required';
        assert.strictEqual(context.window.UuzuhaoAuthStatus.messageFor(item), '授权异常，需人工介入');
        assert.ok(context.platformBadges(item)[0].text.includes('需人工介入'));
        item.uuzuhao_auth_state.required = false;
        assert.strictEqual(context.window.UuzuhaoAuthStatus.recoveryLabel(item), '');
        item.platform_status_norm = { uuzuhao: { code: 'auth_abnormal' } };
        assert.strictEqual(context.window.UuzuhaoAuthStatus.recoveryLabel(item), '授权异常，需人工介入');
        item.uuzuhao_recovery.stage = 'recovered';
        assert.strictEqual(context.window.UuzuhaoAuthStatus.recoveryLabel(item), '');
        item.uuzuhao_recovery.stage = 'manual_required'; item.asset_status = 'sold';
        assert.strictEqual(context.window.UuzuhaoAuthStatus.recoveryLabel(item), '');
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
