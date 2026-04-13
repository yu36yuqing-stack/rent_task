#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-main-task-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');
process.env.ORDER_DB_FILE_PATH = path.join(tempDir, 'rent_robot_order.db');
process.env.STATS_DB_FILE_PATH = path.join(tempDir, 'rent_robot_stats.db');
process.env.PRICE_DB_FILE_PATH = path.join(tempDir, 'rent_robot_price.db');

const { createUserByAdmin } = require('../database/user_db');
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
    await createUserByAdmin({
        account: 'cron_user',
        password: '123456',
        name: 'Cron User',
        user_type: '外部',
        status: 'enabled',
        desc: 'rent_robot_main runtime task smoke'
    });

    const child = spawn(process.execPath, ['rent_robot_main.js'], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env,
            ORDER_ASYNC_ENABLE: '0',
            ORDER_STATS_DAILY_ENABLE: '0',
            BL_V2_INSPECTOR_ENABLE: '0',
            ACTION_ENABLE: '0'
        },
        stdio: 'ignore'
    });
    const code = await new Promise((resolve) => child.on('exit', (c) => resolve(Number(c ?? 0))));
    if (code !== 0) throw new Error(`rent_robot_main exit code=${code}`);

    const db = openRuntimeDatabase();
    try {
        const row = await get(db, `
            SELECT task_type, status, stage, progress_text
            FROM runtime_task
            WHERE task_type = 'product_sync' AND is_deleted = 0
            ORDER BY id DESC
            LIMIT 1
        `);
        if (!row) throw new Error('未生成 product_sync runtime_task');
        if (!['failed', 'partial_failed', 'success'].includes(String(row.status || ''))) {
            throw new Error(`product_sync status 异常: ${row.status}`);
        }
        console.log(`[PASS] rent_robot_main_runtime_task_smoke_test temp_dir=${tempDir}`);
    } finally {
        db.close();
    }
}

main().catch((err) => {
    console.error(`[FAIL] rent_robot_main_runtime_task_smoke_test: ${err.message}`);
    process.exit(1);
});
