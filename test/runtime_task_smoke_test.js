#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-runtime-task-'));
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.ORDER_DB_FILE_PATH = path.join(tempDir, 'rent_robot_order.db');

const {
    initRuntimeTaskDb,
    createRuntimeTask,
    getRuntimeTaskByTaskId,
    findLatestActiveRuntimeTask,
    markRuntimeTaskRunning,
    markRuntimeTaskFinished,
    attachManualToRuntimeTask,
    TASK_STATUS_SUCCESS
} = require('../database/runtime_task_db');
const { shouldTriggerOrderSyncNow } = require('../order/order');

function fail(msg) {
    console.error(`[FAIL] ${msg}`);
    process.exit(1);
}

function assertTrue(cond, msg) {
    if (!cond) fail(msg);
    console.log(`[PASS] ${msg}`);
}

function assertEqual(actual, expected, msg) {
    if (actual !== expected) fail(`${msg} | expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
    console.log(`[PASS] ${msg}`);
}

async function main() {
    await initRuntimeTaskDb();
    const created = await createRuntimeTask({
        user_id: 7,
        task_type: 'product_sync',
        trigger_source: 'manual',
        status: 'pending',
        stage: 'queued',
        progress_text: '等待执行',
        desc: 'runtime task smoke'
    });
    assertTrue(Boolean(created && created.task_id), '创建 runtime_task 成功');

    const active = await findLatestActiveRuntimeTask(7, 'product_sync');
    assertEqual(String(active && active.task_id || ''), String(created.task_id), '可查询到最新活动任务');

    const attached = await attachManualToRuntimeTask(created.task_id);
    assertEqual(Number(attached && attached.attached_manual_count || 0), 1, '手工附着计数递增');

    const running = await markRuntimeTaskRunning(created.task_id, {
        stage: 'sync_accounts',
        progress_text: '同步账号中'
    });
    assertEqual(String(running && running.status || ''), 'running', '任务进入 running');
    assertEqual(String(running && running.stage || ''), 'sync_accounts', '任务阶段更新成功');

    const finished = await markRuntimeTaskFinished(created.task_id, {
        status: TASK_STATUS_SUCCESS,
        stage: 'done',
        progress_text: '任务完成',
        result_json: { ok: true }
    });
    assertEqual(String(finished && finished.status || ''), 'success', '任务完成状态写入成功');

    const stored = await getRuntimeTaskByTaskId(created.task_id);
    assertTrue(String(stored && stored.finished_at || '').trim().length > 0, '任务完成时间已写入');

    const inWindowHit = shouldTriggerOrderSyncNow({
        now: new Date('2026-04-13T00:00:10'),
        interval_min: 5,
        window_sec: 20
    });
    const outWindowMiss = shouldTriggerOrderSyncNow({
        now: new Date('2026-04-13T00:02:30'),
        interval_min: 5,
        window_sec: 20
    });
    assertEqual(inWindowHit, true, '无错峰时 00:00:10 命中订单窗口');
    assertEqual(outWindowMiss, false, '无错峰时 00:02:30 不命中订单窗口');

    console.log(`[RuntimeTaskSmoke] ok temp_dir=${tempDir}`);
}

main().catch((err) => {
    console.error(`[FAIL] runtime_task_smoke_test: ${err.message}`);
    process.exit(1);
});
