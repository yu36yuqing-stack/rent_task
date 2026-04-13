#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-h5-runtime-task-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');
process.env.ORDER_DB_FILE_PATH = path.join(tempDir, 'rent_robot_order.db');
process.env.STATS_DB_FILE_PATH = path.join(tempDir, 'rent_robot_stats.db');
process.env.PRICE_DB_FILE_PATH = path.join(tempDir, 'rent_robot_price.db');
process.env.SHEEP_FIX_ENABLE = '0';
const port = 18080 + Math.floor(Math.random() * 1000);
process.env.H5_PORT = String(port);
process.env.USER_PIPELINE_LOCK_WAIT_MS = '0';
process.env.STATS_REFRESH_LOCK_POLL_MS = '200';
process.env.BL_V2_INSPECTOR_ENABLE = '0';

const { createUserByAdmin } = require('../database/user_db');
const { createAccessToken } = require('../user/auth_token');
const { createRuntimeTask } = require('../database/runtime_task_db');
const { tryAcquireLock, releaseLock } = require('../database/lock_db');
const { bootstrap } = require('../h5/local_h5_server');
const { stopProdRiskTaskWorker } = require('../product/prod_status_guard');

function assertTrue(cond, msg) {
    if (!cond) throw new Error(msg);
}

async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPing(baseUrl, headers = {}, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${baseUrl}/api/ping`, { headers });
            if (res.ok) return;
        } catch {}
        await sleep(200);
    }
    throw new Error('waitForPing timeout');
}

async function main() {
    const user = await createUserByAdmin({
        account: 'h5_task_user',
        password: '123456',
        name: 'H5 Task User',
        user_type: '外部',
        status: 'enabled',
        desc: 'h5 runtime task smoke'
    });
    const token = createAccessToken(user);
    const headers = {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
    };
    const productTask = await createRuntimeTask({
        user_id: user.id,
        task_type: 'product_sync',
        trigger_source: 'manual',
        status: 'running',
        stage: 'sync_accounts',
        progress_text: '同步中',
        desc: 'seed active product task'
    });
    const orderTask = await createRuntimeTask({
        user_id: user.id,
        task_type: 'order_sync',
        trigger_source: 'manual',
        status: 'running',
        stage: 'sync_orders',
        progress_text: '同步中',
        desc: 'seed active order task'
    });
    const productLockKey = `pipeline_user_${user.id}`;
    const productLock = await tryAcquireLock(productLockKey, 300, `test_product_lock pid=${process.pid}`);
    const orderLock = await tryAcquireLock('order_sync_all_users', 300, `test_order_lock pid=${process.pid}`);
    assertTrue(Boolean(productLock && productLock.acquired), '种子商品锁获取失败');
    assertTrue(Boolean(orderLock && orderLock.acquired), '种子订单锁获取失败');

    const server = await bootstrap();

    try {
        const baseUrl = `http://127.0.0.1:${port}`;
        await waitForPing(baseUrl, headers);

        const queryRes = await fetch(`${baseUrl}/api/runtime-task?task_id=${encodeURIComponent(productTask.task_id)}`, {
            headers
        });
        const queryJson = await queryRes.json();
        assertTrue(queryRes.ok && queryJson.ok, '查询 runtime_task 失败');
        assertTrue(String(queryJson.task.task_id || '') === String(productTask.task_id), '查询的 task_id 不匹配');

        const productRes = await fetch(`${baseUrl}/api/products/sync`, {
            method: 'POST',
            headers,
            body: '{}'
        });
        const productJson = await productRes.json();
        assertTrue(productRes.ok, '商品同步接口应返回 200');
        assertTrue(Boolean(productJson.reused), '商品同步应复用活动任务');
        assertTrue(String(productJson.task_id || '') === String(productTask.task_id), '商品同步复用 task_id 不匹配');

        const orderRes = await fetch(`${baseUrl}/api/orders/sync`, {
            method: 'POST',
            headers,
            body: '{}'
        });
        const orderJson = await orderRes.json();
        assertTrue(orderRes.ok, '订单同步接口应返回 200');
        assertTrue(Boolean(orderJson.reused), '订单同步应复用活动任务');
        assertTrue(String(orderJson.task_id || '') === String(orderTask.task_id), '订单同步复用 task_id 不匹配');

        console.log(`[PASS] h5_runtime_task_smoke_test temp_dir=${tempDir}`);
    } finally {
        try { await new Promise((resolve) => server.close(resolve)); } catch {}
        try { stopProdRiskTaskWorker(); } catch {}
        try { await releaseLock(productLockKey, 'release by h5_runtime_task_smoke_test'); } catch {}
        try { await releaseLock('order_sync_all_users', 'release by h5_runtime_task_smoke_test'); } catch {}
    }
}

main().catch((err) => {
    console.error(`[FAIL] h5_runtime_task_smoke_test: ${err.message}`);
    process.exit(1);
});
