'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-online-auth-guard-'));
for (const name of ['MAIN', 'RUNTIME', 'ORDER', 'STATS', 'PRICE']) process.env[`${name}_DB_FILE_PATH`] = path.join(dir, `${name}.db`);
process.env.SHEEP_FIX_ENABLE = '1';
const { createUserByAdmin } = require('../database/user_db');
const { upsertUserGameAccount } = require('../database/user_game_account_db');
const { upsertUserPlatformAuth } = require('../database/user_platform_auth_db');
const { upsertOpenRiskEvent } = require('../database/prod_risk_event_db');
const { upsertGuardTask } = require('../database/prod_guard_task_db');
const { initOrderDb } = require('../database/order_db');
const { openDatabase } = require('../database/sqlite_client');
const { getUuzuhaoAuthState } = require('../database/uuzuhao_auth_state_db');
const { queryOnlineStatusCached } = require('../product/prod_probe_cache_service');
const guard = require('../product/prod_status_guard');
const auth = { app_key: 'fixture', app_secret: 'fixture', api_base: 'https://fixture.invalid' };
const key = { game_account: '2256481878', game_id: '1', game_name: 'WZRY' };
const failureCode = Number(process.env.ONLINE_AUTH_FAILURE_CODE || 201010027);
const failureReason = failureCode === 12101001 ? '悠悠商品不存在' : 'QQ鉴权失败';
let response = { code: failureCode, msg: failureCode === 12101001 ? '商品不存在' : '查询失败，请稍后重试' };
let calls = 0;
const originalFetch = global.fetch;
global.fetch = async url => {
    assert.ok(String(url).startsWith(auth.api_base));
    calls++;
    return { ok: true, status: 200, text: async () => JSON.stringify(response) };
};
async function sql(query, params = []) {
    const db = openDatabase();
    try {
        return await new Promise((resolve, reject) => db.all(query, params, (error, rows) => error ? reject(error) : resolve(rows)));
    } finally { db.close(); }
}
const logger = { log() {}, warn() {}, error() {} };
async function main() {
    try {
        await initOrderDb();
        const user = await createUserByAdmin({ account: 'auth-guard-fixture', password: 'fixture-only', user_type: '内部', status: 'enabled' });
        await upsertUserGameAccount({ user_id: user.id, ...key, channel_status: { uuzuhao: '上架' } });
        await upsertUserPlatformAuth({ user_id: user.id, platform: 'uuzuhao', auth_type: 'token', auth_status: 'valid', auth_payload: auth });
        const event = await upsertOpenRiskEvent(user.id, key, guard.RISK_TYPE_ONLINE_NON_RENTING, {});
        const task = await upsertGuardTask({ user_id: user.id, ...key, task_type: guard.TASK_TYPE_SHEEP_FIX,
            risk_type: guard.RISK_TYPE_ONLINE_NON_RENTING, event_id: event.id, status: 'watching', next_check_at: 1 });
        await guard.runSheepFixWorkerOnce({ logger });
        assert.strictEqual(calls, 1);
        const state = await getUuzuhaoAuthState(user.id, key);
        assert.strictEqual(state.required, true);
        assert.strictEqual(state.error_code, String(failureCode));
        assert.strictEqual(state.reason, failureReason);
        const getTask = async () => (await sql('SELECT * FROM prod_guard_task WHERE id=?', [task.id]))[0];
        let row = await getTask();
        assert.strictEqual(row.status, 'watching');
        assert.strictEqual(row.last_error, 'waiting_authorization');
        assert.strictEqual(row.retry_count, 0);
        assert.strictEqual(row.probe_loop_count, 0);
        assert.strictEqual((await sql('SELECT status FROM prod_risk_event WHERE id=?', [event.id]))[0].status, 'open');
        for (let i = 0; i < 3; i++) {
            await sql('UPDATE prod_guard_task SET next_check_at=1 WHERE id=?', [task.id]);
            await guard.runSheepFixWorkerOnce({ logger });
        }
        assert.strictEqual(calls, 1, 'waiting tasks must not send more requests');
        assert.ok((await getTask()).desc.includes(failureReason), 'waiting must retain the actual reason');
        const account = { account: key.game_account, game_id: '1', game_name: 'WZRY', online_tag: 'ON' };
        const probe = await guard.probeProdOnlineStatus(user, [account], { logger, include_rows: true });
        assert.strictEqual(probe.skipped, true);
        const alert = await guard.alertOnlineConflictIfNeeded(user, [account], { logger });
        assert.strictEqual(alert.risk_enqueued.queued, 0, 'a stale online snapshot must not create another risk task');
        assert.strictEqual(calls, 1);
        response = { code: 0, data: { gameOnline: true } };
        await queryOnlineStatusCached(user.id, key.game_account, { auth, manual: true, force_refresh: true });
        await sql('UPDATE prod_guard_task SET next_check_at=1 WHERE id=?', [task.id]);
        await guard.runSheepFixWorkerOnce({ logger });
        row = await getTask();
        assert.strictEqual(row.last_error, '');
        assert.strictEqual(row.status, 'watching');
        console.log(`[PASS] online auth guard (${failureCode}): first failure pauses without retry increments, zero follow-up requests, no false risk resolution and manual recovery`);
    } finally { global.fetch = originalFetch; guard.stopProdRiskTaskWorker(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
