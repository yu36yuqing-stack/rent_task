#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-prod-guard-auth-skip-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');
process.env.ORDER_DB_FILE_PATH = path.join(tempDir, 'rent_robot_order.db');
process.env.STATS_DB_FILE_PATH = path.join(tempDir, 'rent_robot_stats.db');
process.env.PRICE_DB_FILE_PATH = path.join(tempDir, 'rent_robot_price.db');
process.env.SHEEP_FIX_ENABLE = '1';

const probePath = require.resolve('../product/prod_probe_cache_service');
let authAbnormal = true;
let failAt = '';
const pausedError = () => Object.assign(new Error('waiting authorization'), { code: 'UUZUHAO_AUTHORIZATION_PAUSED' });
for (const [file, exports] of [
    ['../blacklist/blacklist_source_gateway', { setGuardSourcesByProbeAndReconcile: async () => ({}) }],
    ['../blacklist/blacklist_release_guard', { REASON_ONLINE: '检测在线', deleteBlacklistWithGuard: async () => ({ done: true }) }]
]) {
    const id = require.resolve(file);
    require.cache[id] = { id, filename: id, loaded: true, exports };
}
delete require.cache[probePath];
require.cache[probePath] = {
    id: probePath,
    filename: probePath,
    loaded: true,
    exports: {
        resolveUuzuhaoAuthByUser: async () => ({ app_key: 'k', app_secret: 's' }),
        resolveUuzuhaoAuthAbnormalByUserAndAccount: async () => ({
            hit: authAbnormal,
            off_type: 'AUTHORIZE_ERROR',
            reason: '授权失效',
            label: '需重新授权'
        }),
        queryOnlineStatusCached: async () => {
            assert.strictEqual(authAbnormal, false);
            if (failAt === 'online') throw pausedError();
            return { online: false };
        },
        setForbiddenPlayWithSnapshot: async (_uid, _acc, enabled) => {
            assert.strictEqual(authAbnormal, false);
            if (failAt === (enabled ? 'enable' : 'disable')) throw pausedError();
            return { enabled };
        }
    }
};

delete require.cache[require.resolve('../product/prod_status_guard')];
const { runSheepFixWorkerOnce, RISK_TYPE_ONLINE_NON_RENTING, TASK_TYPE_SHEEP_FIX } = require('../product/prod_status_guard');
const { createUserByAdmin } = require('../database/user_db');
const { upsertOpenRiskEvent } = require('../database/prod_risk_event_db');
const { upsertGuardTask, initProdGuardTaskDb } = require('../database/prod_guard_task_db');
const { openDatabase } = require('../database/sqlite_client');
const { initOrderDb } = require('../database/order_db');
const { initUserGameAccountDb } = require('../database/user_game_account_db');

async function getTaskRow(taskId) {
    const db = openDatabase();
    try {
        const row = await new Promise((resolve, reject) => {
            db.get('SELECT status, desc, retry_count, last_error, next_check_at, forbidden_applied, finished_at FROM prod_guard_task WHERE id = ?', [taskId], (err, data) => err ? reject(err) : resolve(data || null));
        });
        return row;
    } finally {
        db.close();
    }
}

async function main() {
    await initOrderDb();
    await initUserGameAccountDb();
    const user = await createUserByAdmin({
        account: 'prod_guard_auth_skip',
        password: '123456',
        name: 'Prod Guard Auth Skip',
        user_type: '外部',
        status: 'enabled',
        desc: 'prod guard auth abnormal worker skip smoke'
    });
    const event = await upsertOpenRiskEvent(user.id, {
        game_account: 'auth_skip_acc',
        game_id: '1',
        game_name: 'WZRY'
    }, RISK_TYPE_ONLINE_NON_RENTING, {
        snapshot: { hit_at: '2026-04-19 10:00:00' },
        desc: 'seed risk event'
    });
    await initProdGuardTaskDb();
    const task = await upsertGuardTask({
        user_id: user.id,
        game_account: 'auth_skip_acc',
        game_id: '1',
        game_name: 'WZRY',
        risk_type: RISK_TYPE_ONLINE_NON_RENTING,
        task_type: TASK_TYPE_SHEEP_FIX,
        status: 'watching',
        event_id: event.id,
        next_check_at: 1,
        max_retry: 3
    }, {
        desc: 'seed guard task'
    });

    const ret = await runSheepFixWorkerOnce({ logger: { log() {}, warn() {}, error() {} } });
    assert.strictEqual(ret.ok, true, 'worker 返回 ok 应为 true');
    const taskRow = await getTaskRow(task.id);
    assert.strictEqual(taskRow.status, 'watching', '暂停时必须保留原有执行阶段');
    assert.strictEqual(taskRow.retry_count, 0, '等待授权不增加重试计数');
    assert.strictEqual(taskRow.last_error, 'waiting_authorization');
    assert.ok(taskRow.next_check_at > Date.now() / 1000);
    assert.strictEqual(taskRow.finished_at, '');
    const db = openDatabase();
    try {
        const risk = await new Promise((resolve, reject) => db.get('SELECT status FROM prod_risk_event WHERE id = ?', [event.id], (e, row) => e ? reject(e) : resolve(row)));
        assert.strictEqual(risk.status, 'open', '暂停不能把风险标记为已解决或忽略');
    } finally { db.close(); }

    authAbnormal = false;
    for (const phase of ['online', 'disable', 'enable', 'recovered']) {
        failAt = phase;
        const db = openDatabase();
        try {
            await new Promise((resolve, reject) => db.run('UPDATE prod_guard_task SET status=?, next_check_at=1 WHERE id=?',
                [phase === 'enable' ? 'pending' : 'watching', task.id], (e) => e ? reject(e) : resolve()));
        } finally { db.close(); }
        await runSheepFixWorkerOnce({ logger: { log() {}, warn() {}, error() {} } });
        const current = await getTaskRow(task.id);
        assert.strictEqual(current.retry_count, 0, '中途发现授权异常也不能消耗失败次数');
        assert.strictEqual(current.status, phase === 'recovered' ? 'done' : phase === 'enable' ? 'pending' : 'watching');
    }

    console.log(`[PASS] prod_guard_uuzuhao_auth_worker_skip_smoke_test temp_dir=${tempDir}`);
}

main().catch((err) => {
    console.error(`[FAIL] prod_guard_uuzuhao_auth_worker_skip_smoke_test: ${err.message}`);
    process.exit(1);
});
