#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-order-auth-revoke-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');
process.env.ORDER_DB_FILE_PATH = path.join(tempDir, 'rent_robot_order.db');

const { openOrderDatabase, openRuntimeDatabase } = require('../database/sqlite_client');
const { initOrderDb, upsertOrder } = require('../database/order_db');
const { upsertUserPlatformAuth } = require('../database/user_platform_auth_db');
const { upsertUserGameAccount } = require('../database/user_game_account_db');
const {
    AUTH_REVOKE_TASK_TYPE,
    buildAuthRevokeCandidate,
    buildAuthRevokeCandidateOnStatusChange,
    enqueueAuthRevokeTasks,
    enqueueManualAuthRevokeTask,
    listLatestAuthRevokeTaskViewsByUser,
    getAuthRevokeTaskViewByUser,
    processAuthRevokeTasks
} = require('../order/auth_revoke_task_service');
const {
    getRuntimeTaskByTaskId,
    claimRuntimeTask
} = require('../database/runtime_task_db');

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows || []));
    });
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(error) {
            if (error) return reject(error);
            resolve(this);
        });
    });
}

function order(channel, orderNo, status, account = '3387324805') {
    return {
        channel,
        order_no: orderNo,
        order_status: status,
        game_id: '1',
        game_name: 'WZRY',
        game_account: account,
        end_time: '2026-08-13 11:00:00'
    };
}

async function listTasks() {
    const db = openRuntimeDatabase();
    try {
        return await all(db, `
            SELECT * FROM runtime_task
            WHERE task_type = ? AND is_deleted = 0
            ORDER BY id ASC
        `, [AUTH_REVOKE_TASK_TYPE]);
    } finally {
        db.close();
    }
}

async function main() {
    await initOrderDb();
    const orderDb = openOrderDatabase();
    try {
        const columns = await all(orderDb, `PRAGMA table_info("order")`);
        const names = columns.map((row) => String(row.name || ''));
        assert.ok(!names.includes('auth_revoke_status'), '订单表不应增加解除授权状态字段');
        assert.ok(!names.includes('auth_revoke_at'), '订单表不应增加解除授权时间字段');
        assert.ok(!names.includes('auth_revoke_error'), '订单表不应增加解除授权错误字段');
    } finally {
        orderDb.close();
    }

    await upsertUserPlatformAuth({
        user_id: 8,
        platform: 'uuzuhao',
        auth_type: 'token',
        auth_status: 'valid',
        channel_enabled: false,
        auth_payload: {
            app_key: 'test-app-key',
            app_secret: 'test-app-secret',
            api_base: 'https://uuzuhao.example.test'
        }
    });
    await upsertUserGameAccount({
        user_id: 8,
        game_id: '1',
        game_name: 'WZRY',
        game_account: 'MANUAL001',
        account_remark: '手工解除测试账号',
        channel_status: {},
        channel_prd_info: {},
        desc: 'manual auth revoke test account'
    });
    await upsertUserGameAccount({
        user_id: 8,
        game_id: '1',
        game_name: 'WZRY',
        game_account: 'MANUAL002',
        account_remark: '并发手工解除测试账号',
        channel_status: {},
        channel_prd_info: {},
        desc: 'concurrent manual auth revoke test account'
    });

    assert.strictEqual(buildAuthRevokeCandidate(8, order('uuzuhao', 'ACTIVE', '租赁中')), null, '进行中订单不触发任务');
    assert.strictEqual(buildAuthRevokeCandidate(8, {
        ...order('5e', 'CS2_DONE', '已完成', 'steam_account'),
        game_id: '4',
        game_name: 'CSGO'
    }), null, 'CS2订单不触发解除授权任务');
    assert.ok(buildAuthRevokeCandidate(8, order('uuzuhao', 'CANCELLED', '已撤单')), '撤单同样属于订单结束');
    assert.strictEqual(
        buildAuthRevokeCandidateOnStatusChange(8, order('uuzuhao', 'UNCHANGED', '已完成'), { status_changed: false }),
        null,
        '订单状态未变化时不触发解除授权'
    );
    assert.ok(
        buildAuthRevokeCandidateOnStatusChange(8, order('uuzuhao', 'CHANGED', '已完成'), { status_changed: true }),
        '订单状态变化且新状态已结束时触发解除授权'
    );
    assert.strictEqual(
        buildAuthRevokeCandidateOnStatusChange(8, order('uuzuhao', 'ACTIVE_CHANGED', '租赁中'), { status_changed: true }),
        null,
        '订单状态变化但新状态未结束时不触发解除授权'
    );

    const firstCandidates = [
        order('uuzuhao', 'ORDER_UU', '已完成'),
        order('uuzuhao', 'ORDER_UU', '已完成'),
        order('uhaozu', 'ORDER_UH', '已退款'),
        order('zuhaowang', 'ORDER_ACTIVE', '租赁中')
    ];
    const first = await enqueueAuthRevokeTasks(8, firstCandidates, { trigger_task_id: 'order_sync_test' });
    assert.strictEqual(first.created, 1, '同一账号的两个结束订单只应创建一个任务');
    assert.strictEqual(first.existing, 1, '同账号后续订单应合并到已有任务');
    assert.strictEqual(first.skipped, 1, '进行中订单应跳过');
    assert.strictEqual(first.task_ids.length, 1, '同账号任务 ID 应收敛为一条');

    const repeated = await enqueueAuthRevokeTasks(8, firstCandidates);
    assert.strictEqual(repeated.created, 0, '重叠窗口不应重复创建同一订单任务');
    assert.strictEqual(repeated.existing, 2, '重叠窗口内两个订单触发都应复用已有任务');
    assert.strictEqual(repeated.task_ids.length, 1, '重复同步仍只返回一个任务 ID');

    let tasks = await listTasks();
    assert.strictEqual(tasks.length, 1, '同账号只应有一条解除授权任务');
    assert.ok(tasks.every((row) => row.status === 'pending'), '新任务状态应为 pending');
    const firstState = JSON.parse(tasks[0].result_json);
    assert.strictEqual(firstState.triggers.length, 2, '任务应记录两个不同订单触发来源');
    assert.strictEqual(firstState.coalesced_trigger_count, 3, '每次复用均应累计合并次数');

    const originalFetch = global.fetch;
    const captured = [];
    global.fetch = async (url, options = {}) => {
        captured.push({ url: String(url), body: JSON.parse(options.body) });
        return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ code: 0, msg: '成功', data: {} })
        };
    };

    try {
        const success = await processAuthRevokeTasks();
        assert.strictEqual(success.claimed, 1, 'Worker 应只领取一条账号级任务');
        assert.strictEqual(success.success, 1, '账号级任务应执行成功');
        assert.strictEqual(captured.length, 1, '同账号重叠订单只调用一次解除接口');
        assert.ok(captured.every((item) => item.body.accountNo === '3387324805'), '解除账号参数正确');
        assert.ok(captured.every((item) => item.body.gameId === 1), '解除游戏参数正确');

        tasks = await listTasks();
        assert.ok(tasks.every((row) => row.status === 'success'), '成功结果应记录在账号级任务中');

        const recentOrder = await enqueueAuthRevokeTasks(8, firstCandidates);
        assert.strictEqual(recentOrder.created, 0, '成功后 60 秒内不应重复建任务');
        assert.strictEqual(recentOrder.recent_success, 2, '成功后两个订单触发均应命中近期成功任务');
        const noRepeatRun = await processAuthRevokeTasks();
        assert.strictEqual(noRepeatRun.claimed, 0, '近期成功任务不应再次执行');

        const concurrentManual = await Promise.all([1, 2].map(() => enqueueManualAuthRevokeTask(8, {
            game_id: '1',
            game_name: 'WZRY',
            game_account: 'MANUAL002'
        }, { start_worker: false })));
        assert.strictEqual(concurrentManual.filter((item) => item.created).length, 1, '无任务时并发点击只能创建一条任务');
        assert.strictEqual(concurrentManual.filter((item) => item.reused).length, 1, '无任务时第二个并发点击应复用任务');
        assert.strictEqual(new Set(concurrentManual.map((item) => item.task.task_id)).size, 1, '并发创建应返回同一个任务 ID');
        const concurrentManualRun = await processAuthRevokeTasks();
        assert.strictEqual(concurrentManualRun.success, 1, '并发点击最终只应执行一次解除接口');

        const manualOrder = await enqueueAuthRevokeTasks(8, [order('uuzuhao', 'ORDER_MANUAL_OVERLAP', '已完成', 'MANUAL001')]);
        const manualResults = await Promise.all([1, 2].map(() => enqueueManualAuthRevokeTask(8, {
            game_id: '1',
            game_name: 'WZRY',
            game_account: 'MANUAL001'
        }, { start_worker: false })));
        assert.strictEqual(manualOrder.created, 1, '订单结束应先创建账号级任务');
        assert.ok(manualResults.every((item) => item.reused), '并发手工点击应复用订单创建的任务');
        assert.ok(manualResults.every((item) => item.task.task_id === manualOrder.task_ids[0]), '订单与手工触发应合并到同一任务');
        const manualRun = await processAuthRevokeTasks();
        assert.strictEqual(manualRun.success, 1, '订单与手工合并任务只应执行一次');
        let manualTask = await getRuntimeTaskByTaskId(manualOrder.task_ids[0]);
        assert.strictEqual(manualTask.status, 'success', '合并任务应成功');
        const manualState = JSON.parse(manualTask.result_json);
        assert.strictEqual(manualState.triggers.length, 3, '任务应保留一个订单和两个手工触发来源');
        assert.strictEqual(Number(manualTask.attached_manual_count), 2, '应记录两次手工附加触发');

        const recentManual = await enqueueManualAuthRevokeTask(8, {
            game_id: '1',
            game_name: 'WZRY',
            game_account: 'MANUAL001'
        }, { start_worker: false });
        assert.strictEqual(recentManual.reuse_reason, 'recent_success', '60 秒内再次点击应复用近期成功结果');
        assert.strictEqual(recentManual.worker.reason, 'recent_success', '复用近期成功结果时不应启动 Worker');

        const runtimeDb = openRuntimeDatabase();
        try {
            await run(runtimeDb, `UPDATE runtime_task SET finished_at = '2020-01-01 00:00:00' WHERE task_id = ?`, [manualTask.task_id]);
        } finally {
            runtimeDb.close();
        }
        const expiredManual = await enqueueManualAuthRevokeTask(8, {
            game_id: '1',
            game_name: 'WZRY',
            game_account: 'MANUAL001'
        }, { start_worker: false });
        assert.strictEqual(expiredManual.created, true, '近期成功窗口过后应允许创建新任务');
        assert.notStrictEqual(expiredManual.task.task_id, manualTask.task_id, '新一轮任务应使用新的任务 ID');
        const expiredRun = await processAuthRevokeTasks();
        assert.strictEqual(expiredRun.success, 1, '过窗口后的新任务应正常执行');

        const failedEnqueue = await enqueueAuthRevokeTasks(8, [order('zuhaowang', 'ORDER_FAIL', '已完成', '20002')]);
        global.fetch = async () => ({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ code: 201020002, msg: '无流量可用' })
        });
        const failed = await processAuthRevokeTasks();
        assert.strictEqual(failed.failed, 1, '业务失败应把独立任务标记为 failed');
        let failedTask = await getRuntimeTaskByTaskId(failedEnqueue.task_ids[0]);
        assert.strictEqual(failedTask.status, 'failed', '失败状态应落在 runtime_task');
        assert.strictEqual(JSON.parse(failedTask.result_json).attempt_count, 1, '首次失败尝试次数应为 1');

        global.fetch = async () => ({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ code: 0, msg: '成功', data: {} })
        });
        const retried = await processAuthRevokeTasks();
        assert.strictEqual(retried.success, 1, '下一轮应自动重试 failed 任务');
        failedTask = await getRuntimeTaskByTaskId(failedEnqueue.task_ids[0]);
        assert.strictEqual(failedTask.status, 'success', '失败重试后应转为 success');
        assert.strictEqual(JSON.parse(failedTask.result_json).attempt_count, 2, '重试成功尝试次数应累加');

        const guardedEnqueue = await enqueueAuthRevokeTasks(8, [order('uuzuhao', 'ORDER_GUARDED', '已完成', '40004')]);
        let guardedCalls = 0;
        global.fetch = async () => {
            guardedCalls += 1;
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({ code: 0, msg: '成功', data: {} })
            };
        };
        await upsertOrder({
            user_id: 8,
            ...order('uuzuhao', 'ORDER_ACTIVE_NOW', '租赁中', '40004'),
            start_time: '2026-08-15 10:00:00',
            create_date: '2026-08-15 10:00:00'
        });
        const deferred = await processAuthRevokeTasks();
        assert.strictEqual(deferred.deferred, 1, '账号有新租赁订单时应延后解除授权');
        assert.strictEqual(guardedCalls, 0, '延后任务不应调用解除接口');
        let guardedTask = await getRuntimeTaskByTaskId(guardedEnqueue.task_ids[0]);
        assert.strictEqual(guardedTask.status, 'pending', '延后任务应回到 pending');
        assert.strictEqual(guardedTask.stage, 'waiting_active_order', '延后原因应记录在任务阶段');
        const guardedView = await getAuthRevokeTaskViewByUser(8, guardedTask.task_id);
        assert.strictEqual(guardedView.status_text, '等待订单结束', '页面状态应明确展示等待订单结束');

        await upsertOrder({
            user_id: 8,
            ...order('uuzuhao', 'ORDER_ACTIVE_NOW', '已完成', '40004'),
            start_time: '2026-08-15 10:00:00',
            create_date: '2026-08-15 10:00:00'
        });
        const afterRental = await processAuthRevokeTasks();
        assert.strictEqual(afterRental.success, 1, '活跃订单结束后延后任务应继续执行');
        assert.strictEqual(guardedCalls, 1, '活跃订单结束后应调用一次解除接口');
        guardedTask = await getRuntimeTaskByTaskId(guardedEnqueue.task_ids[0]);
        assert.strictEqual(guardedTask.status, 'success', '延后任务最终应成功');

        const staleEnqueue = await enqueueAuthRevokeTasks(8, [order('uuzuhao', 'ORDER_STALE', '已完成', '30003')]);
        const claimed = await claimRuntimeTask(staleEnqueue.task_ids[0], AUTH_REVOKE_TASK_TYPE);
        assert.ok(claimed && claimed.status === 'running', '测试任务应先进入 running');
        const staleDb = openRuntimeDatabase();
        try {
            await run(staleDb, `
                UPDATE runtime_task
                SET started_at = '2020-01-01 00:00:00', modify_date = '2099-01-01 00:00:00'
                WHERE task_id = ?
            `, [staleEnqueue.task_ids[0]]);
        } finally {
            staleDb.close();
        }
        const staleMerged = await enqueueAuthRevokeTasks(8, [order('uhaozu', 'ORDER_STALE_MERGED', '已完成', '30003')]);
        assert.strictEqual(staleMerged.reused, 1, '运行中任务应继续接收新的订单触发');
        const recovered = await processAuthRevokeTasks({ stale_before: '2025-01-01 00:00:00' });
        assert.strictEqual(recovered.success, 1, '超时 running 任务应被回收并执行');
        const staleTask = await getRuntimeTaskByTaskId(staleEnqueue.task_ids[0]);
        assert.strictEqual(staleTask.status, 'success', '回收任务最终应成功');

        const latestViews = await listLatestAuthRevokeTaskViewsByUser(8);
        assert.strictEqual(latestViews['1::30003'].status, 'success', '批量页面状态应按游戏和账号返回最新任务');
        assert.strictEqual(latestViews['1::MANUAL001'].status, 'success', '批量页面状态应包含手工任务结果');
        assert.strictEqual(await getAuthRevokeTaskViewByUser(9, staleTask.task_id), null, '其他用户不能读取任务结果');
    } finally {
        global.fetch = originalFetch;
    }

    console.log(`[PASS] order_auth_revoke_smoke_test temp_dir=${tempDir}`);
}

main().catch((error) => {
    console.error(`[FAIL] order_auth_revoke_smoke_test: ${error.stack || error.message}`);
    process.exit(1);
});
