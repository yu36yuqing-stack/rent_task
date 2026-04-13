#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-h5-runtime-failure-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');
process.env.ORDER_DB_FILE_PATH = path.join(tempDir, 'rent_robot_order.db');
process.env.STATS_DB_FILE_PATH = path.join(tempDir, 'rent_robot_stats.db');
process.env.PRICE_DB_FILE_PATH = path.join(tempDir, 'rent_robot_price.db');
process.env.SHEEP_FIX_ENABLE = '0';
process.env.H5_PORT = String(20080 + Math.floor(Math.random() * 1000));
process.env.USER_PIPELINE_LOCK_WAIT_MS = '0';
process.env.STATS_REFRESH_LOCK_POLL_MS = '200';
process.env.BL_V2_INSPECTOR_ENABLE = '0';

const pipelineMod = require('../pipeline/user_pipeline');
const orderMod = require('../order/order');
const originals = {
    runFullUserPipeline: pipelineMod.runFullUserPipeline,
    syncOrdersByUser: orderMod.syncOrdersByUser
};

pipelineMod.runFullUserPipeline = async () => {
    throw new Error('stub_pipeline_boom');
};
orderMod.syncOrdersByUser = async () => {
    throw new Error('stub_order_boom');
};

const { createUserByAdmin } = require('../database/user_db');
const { createAccessToken } = require('../user/auth_token');
const { openRuntimeDatabase } = require('../database/sqlite_client');
delete require.cache[require.resolve('../h5/local_h5_server')];
const { bootstrap } = require('../h5/local_h5_server');
const { stopProdRiskTaskWorker } = require('../product/prod_status_guard');

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

async function getLatestTaskByType(taskType) {
    const db = openRuntimeDatabase();
    try {
        const row = await new Promise((resolve, reject) => {
            db.get(`
                SELECT *
                FROM runtime_task
                WHERE task_type = ? AND is_deleted = 0
                ORDER BY id DESC
                LIMIT 1
            `, [taskType], (err, data) => err ? reject(err) : resolve(data || null));
        });
        return row;
    } finally {
        db.close();
    }
}

async function main() {
    const user = await createUserByAdmin({
        account: 'h5_failure_owner',
        password: '123456',
        name: 'H5 Failure Owner',
        user_type: '外部',
        status: 'enabled',
        desc: 'h5 runtime task failure smoke'
    });
    const headers = {
        'Authorization': `Bearer ${createAccessToken(user)}`,
        'Content-Type': 'application/json'
    };

    const server = await bootstrap();
    try {
        const baseUrl = `http://127.0.0.1:${process.env.H5_PORT}`;
        await waitForPing(baseUrl, headers);

        const productRes = await fetch(`${baseUrl}/api/products/sync`, {
            method: 'POST',
            headers,
            body: '{}'
        });
        const productJson = await productRes.json();
        assert.strictEqual(productRes.status, 500, '商品同步异常应返回 500');
        assert.strictEqual(productJson.ok, false, '商品同步异常返回 ok 应为 false');
        assert.ok(productJson.message.includes('stub_pipeline_boom'), '商品同步异常文案不对');
        const productTaskRow = await getLatestTaskByType('product_sync');
        assert.strictEqual(productTaskRow.status, 'failed', '商品同步失败任务状态应为 failed');
        assert.strictEqual(productTaskRow.stage, 'pipeline_failed', '商品同步失败阶段应为 pipeline_failed');

        const orderRes = await fetch(`${baseUrl}/api/orders/sync`, {
            method: 'POST',
            headers,
            body: '{}'
        });
        const orderJson = await orderRes.json();
        assert.strictEqual(orderRes.status, 500, '订单同步异常应返回 500');
        assert.strictEqual(orderJson.ok, false, '订单同步异常返回 ok 应为 false');
        assert.ok(orderJson.message.includes('stub_order_boom'), '订单同步异常文案不对');
        const orderTaskRow = await getLatestTaskByType('order_sync');
        assert.strictEqual(orderTaskRow.status, 'failed', '订单同步失败任务状态应为 failed');
        assert.strictEqual(orderTaskRow.stage, 'failed', '订单同步失败阶段应为 failed');

        console.log(`[PASS] h5_runtime_task_failure_smoke_test temp_dir=${tempDir}`);
    } finally {
        pipelineMod.runFullUserPipeline = originals.runFullUserPipeline;
        orderMod.syncOrdersByUser = originals.syncOrdersByUser;
        delete require.cache[require.resolve('../h5/local_h5_server')];
        try { await new Promise((resolve) => server.close(resolve)); } catch {}
        try { stopProdRiskTaskWorker(); } catch {}
    }
}

main().catch((err) => {
    console.error(`[FAIL] h5_runtime_task_failure_smoke_test: ${err.message}`);
    process.exit(1);
});
