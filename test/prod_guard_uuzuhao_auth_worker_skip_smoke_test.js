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
delete require.cache[probePath];
require.cache[probePath] = {
    id: probePath,
    filename: probePath,
    loaded: true,
    exports: {
        resolveUuzuhaoAuthByUser: async () => ({ app_key: 'k', app_secret: 's' }),
        resolveUuzuhaoAuthAbnormalByUserAndAccount: async () => ({
            hit: true,
            off_type: 'AUTHORIZE_ERROR',
            reason: '授权失效',
            label: '需重新授权'
        }),
        queryOnlineStatusCached: async () => {
            throw new Error('should_not_query_online_when_auth_abnormal');
        },
        setForbiddenPlayWithSnapshot: async () => {
            throw new Error('should_not_set_forbidden_when_auth_abnormal');
        }
    }
};

delete require.cache[require.resolve('../product/prod_status_guard')];
const { runSheepFixWorkerOnce, RISK_TYPE_ONLINE_NON_RENTING, TASK_TYPE_SHEEP_FIX } = require('../product/prod_status_guard');
const { createUserByAdmin } = require('../database/user_db');
const { upsertOpenRiskEvent } = require('../database/prod_risk_event_db');
const { upsertGuardTask, initProdGuardTaskDb } = require('../database/prod_guard_task_db');
const { openDatabase } = require('../database/sqlite_client');

async function getTaskRow(taskId) {
    const db = openDatabase();
    try {
        const row = await new Promise((resolve, reject) => {
            db.get('SELECT status, desc FROM prod_guard_task WHERE id = ?', [taskId], (err, data) => err ? reject(err) : resolve(data || null));
        });
        return row;
    } finally {
        db.close();
    }
}

async function main() {
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
    assert.strictEqual(String(taskRow.status || ''), 'done', '授权异常任务应直接 done');
    assert.ok(String(taskRow.desc || '').includes('skip_by_uuzuhao_auth_abnormal'), 'desc 应标记授权异常跳过');

    console.log(`[PASS] prod_guard_uuzuhao_auth_worker_skip_smoke_test temp_dir=${tempDir}`);
}

main().catch((err) => {
    console.error(`[FAIL] prod_guard_uuzuhao_auth_worker_skip_smoke_test: ${err.message}`);
    process.exit(1);
});
