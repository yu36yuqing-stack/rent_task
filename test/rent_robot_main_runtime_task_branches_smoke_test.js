#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-main-branches-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');
process.env.ORDER_DB_FILE_PATH = path.join(tempDir, 'rent_robot_order.db');
process.env.STATS_DB_FILE_PATH = path.join(tempDir, 'rent_robot_stats.db');
process.env.PRICE_DB_FILE_PATH = path.join(tempDir, 'rent_robot_price.db');
process.env.ORDER_ASYNC_ENABLE = '0';
process.env.ORDER_STATS_DAILY_ENABLE = '0';
process.env.BL_V2_INSPECTOR_ENABLE = '0';
process.env.ACTION_ENABLE = '0';

const { createUserByAdmin } = require('../database/user_db');
const { tryAcquireLock, releaseLock } = require('../database/lock_db');
const { openRuntimeDatabase } = require('../database/sqlite_client');
const pipelineMod = require('../pipeline/user_pipeline');
const originalRunPipeline = pipelineMod.runFullUserPipeline;

async function listProductTasks() {
    const db = openRuntimeDatabase();
    try {
        return await new Promise((resolve, reject) => {
            db.all(`
                SELECT *
                FROM runtime_task
                WHERE task_type = 'product_sync' AND is_deleted = 0
                ORDER BY id DESC
            `, [], (err, rows) => err ? reject(err) : resolve(Array.isArray(rows) ? rows : []));
        });
    } finally {
        db.close();
    }
}

async function main() {
    const lockedUser = await createUserByAdmin({
        account: 'cron_skip_user',
        password: '123456',
        name: 'Cron Skip User',
        user_type: '外部',
        status: 'enabled',
        desc: 'cron skip user'
    });
    const failUser = await createUserByAdmin({
        account: 'cron_fail_user',
        password: '123456',
        name: 'Cron Fail User',
        user_type: '外部',
        status: 'enabled',
        desc: 'cron fail user'
    });

    const lockKey = `pipeline_user_${lockedUser.id}`;
    const lockRet = await tryAcquireLock(lockKey, 300, `test_main_lock pid=${process.pid}`);
    assert.ok(lockRet && lockRet.acquired, '种子锁获取失败');

    pipelineMod.runFullUserPipeline = async (user) => {
        if (Number(user && user.id || 0) === Number(failUser.id)) {
            throw new Error('stub_cron_pipeline_boom');
        }
        return {
            ok: true,
            sync: { ok: true },
            accounts_count: 1,
            action_result: { actions: [], errors: [], planned: 0 },
            notify_result: { ok: true },
            non_fatal_errors: []
        };
    };

    delete require.cache[require.resolve('../rent_robot_main')];
    const { runPipeline } = require('../rent_robot_main');
    const runRecord = { actions: [], errors: [] };
    try {
        await runPipeline(runRecord);
    } catch (err) {
        assert.ok(String(err.message || err).includes('stub_cron_pipeline_boom'), 'runPipeline 应抛出 stub_cron_pipeline_boom');
    }

    const rows = await listProductTasks();
    const skipRow = rows.find((row) => Number(row.user_id || 0) === Number(lockedUser.id));
    const failRow = rows.find((row) => Number(row.user_id || 0) === Number(failUser.id));
    assert.ok(skipRow, '应生成 skip 任务');
    assert.strictEqual(skipRow.status, 'skipped', 'skip 任务状态应为 skipped');
    assert.strictEqual(skipRow.stage, 'lock_skipped', 'skip 任务阶段不对');
    assert.ok(failRow, '应生成 fail 任务');
    assert.strictEqual(failRow.status, 'failed', 'fail 任务状态应为 failed');
    assert.strictEqual(failRow.stage, 'pipeline_failed', 'fail 任务阶段应为 pipeline_failed');
    const failErrs = JSON.parse(String(failRow.error_json || '[]'));
    assert.ok(Array.isArray(failErrs) && failErrs[0].includes('stub_cron_pipeline_boom'), 'fail 任务错误信息不对');

    pipelineMod.runFullUserPipeline = originalRunPipeline;
    delete require.cache[require.resolve('../rent_robot_main')];
    await releaseLock(lockKey, 'release by rent_robot_main_runtime_task_branches_smoke_test');
    console.log(`[PASS] rent_robot_main_runtime_task_branches_smoke_test temp_dir=${tempDir}`);
}

main().catch((err) => {
    console.error(`[FAIL] rent_robot_main_runtime_task_branches_smoke_test: ${err.message}`);
    process.exit(1);
});
