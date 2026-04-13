#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-order-worker-task-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');
process.env.ORDER_DB_FILE_PATH = path.join(tempDir, 'rent_robot_order.db');
process.env.STATS_DB_FILE_PATH = path.join(tempDir, 'rent_robot_stats.db');
process.env.PRICE_DB_FILE_PATH = path.join(tempDir, 'rent_robot_price.db');

const { getRuntimeTaskByTaskId } = require('../database/runtime_task_db');
const { openRuntimeDatabase } = require('../database/sqlite_client');

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row || null);
        });
    });
}

async function main() {
    const child = spawn(process.execPath, ['order/order_worker.js'], {
        cwd: path.join(__dirname, '..'),
        env: process.env,
        stdio: 'ignore'
    });
    const code = await new Promise((resolve) => child.on('exit', (c) => resolve(Number(c ?? 0))));
    if (code !== 0) throw new Error(`order_worker exit code=${code}`);

    const db = openRuntimeDatabase();
    try {
        const row = await get(db, `
            SELECT task_id, task_type, status, stage
            FROM runtime_task
            WHERE task_type = 'order_sync' AND is_deleted = 0
            ORDER BY id DESC
            LIMIT 1
        `);
        if (!row) throw new Error('未生成 order_sync runtime_task');
        if (String(row.status || '') !== 'success') throw new Error(`order_sync status 非 success: ${row.status}`);
        const stored = await getRuntimeTaskByTaskId(String(row.task_id || ''));
        if (!stored) throw new Error('无法按 task_id 读取 order_sync 任务');
        console.log(`[PASS] order_worker_runtime_task_smoke_test temp_dir=${tempDir}`);
    } finally {
        db.close();
    }
}

main().catch((err) => {
    console.error(`[FAIL] order_worker_runtime_task_smoke_test: ${err.message}`);
    process.exit(1);
});
