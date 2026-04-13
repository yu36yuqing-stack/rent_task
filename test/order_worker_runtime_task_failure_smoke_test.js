#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-order-worker-fail-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');
process.env.ORDER_DB_FILE_PATH = path.join(tempDir, 'rent_robot_order.db');
process.env.STATS_DB_FILE_PATH = path.join(tempDir, 'rent_robot_stats.db');
process.env.PRICE_DB_FILE_PATH = path.join(tempDir, 'rent_robot_price.db');
process.env.ORDER_SYNC_FORCE = '1';

const orderMod = require('../order/order');
const { openRuntimeDatabase } = require('../database/sqlite_client');
const original = orderMod.syncOrdersForAllUsers;
orderMod.syncOrdersForAllUsers = async () => {
    throw new Error('stub_order_worker_boom');
};

async function getLatestOrderTask() {
    const db = openRuntimeDatabase();
    try {
        return await new Promise((resolve, reject) => {
            db.get(`
                SELECT *
                FROM runtime_task
                WHERE task_type = 'order_sync' AND is_deleted = 0
                ORDER BY id DESC
                LIMIT 1
            `, [], (err, row) => err ? reject(err) : resolve(row || null));
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
    assert.strictEqual(row.status, 'failed', '失败任务状态应为 failed');
    assert.strictEqual(row.stage, 'failed', '失败任务阶段应为 failed');
    const errs = JSON.parse(String(row.error_json || '[]'));
    assert.ok(Array.isArray(errs) && errs[0].includes('stub_order_worker_boom'), '失败错误信息不正确');
    orderMod.syncOrdersForAllUsers = original;
    delete require.cache[require.resolve('../order/order_worker')];
    console.log(`[PASS] order_worker_runtime_task_failure_smoke_test temp_dir=${tempDir}`);
}

main().catch((err) => {
    console.error(`[FAIL] order_worker_runtime_task_failure_smoke_test: ${err.message}`);
    process.exit(1);
});
