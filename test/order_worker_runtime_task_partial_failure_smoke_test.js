#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-order-worker-partial-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');
process.env.ORDER_DB_FILE_PATH = path.join(tempDir, 'rent_robot_order.db');
process.env.STATS_DB_FILE_PATH = path.join(tempDir, 'rent_robot_stats.db');
process.env.PRICE_DB_FILE_PATH = path.join(tempDir, 'rent_robot_price.db');

const orderMod = require('../order/order');
const { openRuntimeDatabase } = require('../database/sqlite_client');
const original = orderMod.syncOrdersForAllUsers;
orderMod.syncOrdersForAllUsers = async () => ({
    total_users: 2,
    processed_users: 2,
    ok_users: 1,
    failed_users: 1,
    results: []
});

async function getLatestOrderTask() {
    const db = openRuntimeDatabase();
    try {
        return await new Promise((resolve, reject) => {
            db.get(`
                SELECT * FROM runtime_task
                WHERE task_type = 'order_sync' AND is_deleted = 0
                ORDER BY id DESC LIMIT 1
            `, [], (error, row) => error ? reject(error) : resolve(row || null));
        });
    } finally {
        db.close();
    }
}

async function main() {
    delete require.cache[require.resolve('../order/order_worker')];
    const worker = require('../order/order_worker');
    await worker.main();
    const row = await getLatestOrderTask();
    assert.ok(row, '应创建 order_sync 任务');
    assert.strictEqual(row.status, 'partial_failed', '部分用户失败应记录 partial_failed');
    assert.strictEqual(row.stage, 'done', '部分失败仍应完成主流程');
    assert.ok(String(row.progress_text || '').includes('部分失败'), '进度文案应说明部分失败');
    orderMod.syncOrdersForAllUsers = original;
    delete require.cache[require.resolve('../order/order_worker')];
    console.log(`[PASS] order_worker_runtime_task_partial_failure_smoke_test temp_dir=${tempDir}`);
}

main().catch((error) => {
    console.error(`[FAIL] order_worker_runtime_task_partial_failure_smoke_test: ${error.message}`);
    process.exit(1);
});
