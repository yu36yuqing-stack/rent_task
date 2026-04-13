#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-h5-runtime-success-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');
process.env.ORDER_DB_FILE_PATH = path.join(tempDir, 'rent_robot_order.db');
process.env.STATS_DB_FILE_PATH = path.join(tempDir, 'rent_robot_stats.db');
process.env.PRICE_DB_FILE_PATH = path.join(tempDir, 'rent_robot_price.db');
process.env.SHEEP_FIX_ENABLE = '0';
process.env.H5_PORT = String(19080 + Math.floor(Math.random() * 1000));
process.env.USER_PIPELINE_LOCK_WAIT_MS = '0';
process.env.STATS_REFRESH_LOCK_POLL_MS = '200';
process.env.BL_V2_INSPECTOR_ENABLE = '0';

const pipelineMod = require('../pipeline/user_pipeline');
const orderMod = require('../order/order');
const originals = {
    runFullUserPipeline: pipelineMod.runFullUserPipeline,
    syncOrdersByUser: orderMod.syncOrdersByUser
};

pipelineMod.runFullUserPipeline = async (_user, options = {}) => {
    if (options && typeof options.onStage === 'function') {
        await options.onStage({ stage: 'sync_accounts', progress_text: '同步商品账号' });
        await options.onStage({ stage: 'done', progress_text: '任务完成', finished: true });
    }
    return {
        ok: true,
        sync: { ok: true },
        accounts_count: 2,
        action_result: { actions: [], errors: [], planned: 0 },
        notify_result: { ok: true },
        non_fatal_errors: ['warn:stub']
    };
};
orderMod.syncOrdersByUser = async () => ({
    ok: false,
    platforms: { uhaozu: { ok: false, error: 'stub_partial' } }
});

const { createUserByAdmin } = require('../database/user_db');
const { createAccessToken } = require('../user/auth_token');
const { createRuntimeTask, getRuntimeTaskByTaskId } = require('../database/runtime_task_db');
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

async function main() {
    const owner = await createUserByAdmin({
        account: 'h5_success_owner',
        password: '123456',
        name: 'H5 Success Owner',
        user_type: '外部',
        status: 'enabled',
        desc: 'h5 runtime task success smoke'
    });
    const other = await createUserByAdmin({
        account: 'h5_success_other',
        password: '123456',
        name: 'H5 Success Other',
        user_type: '外部',
        status: 'enabled',
        desc: 'h5 runtime task success smoke other'
    });
    const ownerHeaders = {
        'Authorization': `Bearer ${createAccessToken(owner)}`,
        'Content-Type': 'application/json'
    };
    const otherHeaders = {
        'Authorization': `Bearer ${createAccessToken(other)}`,
        'Content-Type': 'application/json'
    };
    const productTask = await createRuntimeTask({
        user_id: owner.id,
        task_type: 'product_sync',
        trigger_source: 'manual',
        status: 'running',
        stage: 'sync_accounts',
        progress_text: '运行中',
        desc: 'seed owner product task'
    });

    const server = await bootstrap();
    try {
        const baseUrl = `http://127.0.0.1:${process.env.H5_PORT}`;
        await waitForPing(baseUrl, ownerHeaders);

        const productRes = await fetch(`${baseUrl}/api/products/sync`, {
            method: 'POST',
            headers: ownerHeaders,
            body: '{}'
        });
        const productJson = await productRes.json();
        assert.strictEqual(productRes.status, 200, '商品同步应返回 200');
        assert.ok(productJson.ok, '商品同步应成功');
        assert.ok(productJson.task_id, '商品同步应返回 task_id');
        const productTaskRow = await getRuntimeTaskByTaskId(productJson.task_id);
        assert.strictEqual(productTaskRow.status, 'partial_failed', '商品同步应落 partial_failed');
        assert.strictEqual(productTaskRow.stage, 'done', '商品同步任务应完成');

        const orderRes = await fetch(`${baseUrl}/api/orders/sync`, {
            method: 'POST',
            headers: ownerHeaders,
            body: '{}'
        });
        const orderJson = await orderRes.json();
        assert.strictEqual(orderRes.status, 200, '订单同步应返回 200');
        assert.strictEqual(orderJson.skipped, false, '订单同步不应跳过');
        assert.ok(orderJson.task_id, '订单同步应返回 task_id');
        const orderTaskRow = await getRuntimeTaskByTaskId(orderJson.task_id);
        assert.strictEqual(orderTaskRow.status, 'partial_failed', '订单同步应落 partial_failed');
        assert.strictEqual(orderTaskRow.stage, 'done', '订单同步任务应完成');

        const forbiddenRes = await fetch(`${baseUrl}/api/runtime-task?task_id=${encodeURIComponent(productTask.task_id)}`, {
            headers: otherHeaders
        });
        const forbiddenJson = await forbiddenRes.json();
        assert.strictEqual(forbiddenRes.status, 403, '其他用户查询任务应返回 403');
        assert.strictEqual(forbiddenJson.ok, false, '403 返回 ok 应为 false');

        console.log(`[PASS] h5_runtime_task_success_smoke_test temp_dir=${tempDir}`);
    } finally {
        pipelineMod.runFullUserPipeline = originals.runFullUserPipeline;
        orderMod.syncOrdersByUser = originals.syncOrdersByUser;
        delete require.cache[require.resolve('../h5/local_h5_server')];
        try { await new Promise((resolve) => server.close(resolve)); } catch {}
        try { stopProdRiskTaskWorker(); } catch {}
    }
}

main().catch((err) => {
    console.error(`[FAIL] h5_runtime_task_success_smoke_test: ${err.message}`);
    process.exit(1);
});
