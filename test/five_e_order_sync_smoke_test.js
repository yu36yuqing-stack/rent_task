#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-five-e-order-sync-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');
process.env.ORDER_DB_FILE_PATH = path.join(tempDir, 'rent_robot_order.db');
process.env.STATS_DB_FILE_PATH = path.join(tempDir, 'rent_robot_stats.db');

const { openOrderDatabase, openRuntimeDatabase } = require('../database/sqlite_client');
const { upsertUserPlatformAuth } = require('../database/user_platform_auth_db');
const { upsertUserGameAccount } = require('../database/user_game_account_db');
const { getOrderByKey } = require('../order/service/order_command_service');
const { syncOrdersByUser } = require('../order/order');
const { buildAuthRevokeCandidate } = require('../order/auth_revoke_task_service');
const { initRuntimeTaskDb } = require('../database/runtime_task_db');

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows || []));
    });
}

function buildRawOrder({ childNo, refund = false, expireTime, revenue = '1.5' }) {
    return {
        orderNo: 'PARENT-SHARED',
        orderChildNo: childNo,
        paySuccessTime: String(expireTime - 7200),
        accountNo: 'CS5819323392',
        totalTimeLength: '7200',
        buyTimeType: 1,
        buyCount: 2,
        buyUnitPrice: '2.5',
        rentCount: 1,
        orderAmount: '5',
        discountAmount: '0',
        realAmount: '5',
        channelDivide: 30,
        channelRevenue: revenue,
        orderStatus: 2,
        isRefund: refund ? 1 : 0,
        refundReason: refund ? '账号环境异常' : '',
        isOperate: refund ? 1 : 0,
        rentExpireTime: String(expireTime),
        orderCreateTime: String(expireTime - 7210),
        cashStatus: refund ? -1 : 1,
        isAccountOwner: true
    };
}

async function main() {
    const uid = 808;
    const nowSec = Math.floor(Date.now() / 1000);
    await upsertUserPlatformAuth({
        user_id: uid,
        platform: '5e',
        auth_type: 'token',
        auth_status: 'valid',
        auth_payload: { token: 'five-e-order-test-token' },
        desc: 'five e order sync test auth'
    });
    await upsertUserGameAccount({
        user_id: uid,
        game_id: '4',
        game_name: 'CSGO',
        game_account: 'jorjinagorohov169',
        account_remark: '5E测试账号',
        channel_status: { '5e': '上架' },
        channel_prd_info: {
            '5e': {
                prd_id: 'CS5819323392',
                account_no: 'CS5819323392'
            }
        },
        desc: 'five e order sync test product'
    });

    const rawOrders = [
        buildRawOrder({ childNo: 'CHILD-DONE', expireTime: nowSec - 3600, revenue: '1.5' }),
        buildRawOrder({ childNo: 'CHILD-REFUND', refund: true, expireTime: nowSec - 1800, revenue: '1.5' }),
        buildRawOrder({ childNo: 'CHILD-RENTING', expireTime: nowSec + 3600, revenue: '3' })
    ];
    const requestedPages = [];
    const requestedBodies = [];
    const fetchOrders = async (url, options) => {
        assert.ok(String(url).endsWith('/rentinterface/http/v1/rent/merchant/order/list'));
        assert.strictEqual(options.headers.authorization, 'Bearer five-e-order-test-token');
        const body = JSON.parse(options.body);
        requestedPages.push(body.page);
        requestedBodies.push(body);
        assert.strictEqual(body.accountNo, 'CS5819323392');
        const start = (body.page - 1) * body.pageSize;
        const items = rawOrders.slice(start, start + body.pageSize);
        return {
            ok: true,
            status: 200,
            async text() {
                return JSON.stringify({
                    status: true,
                    code: 0,
                    data: { totalSize: rawOrders.length, items },
                    success: true,
                    traceId: `trace-${body.page}`
                });
            }
        };
    };

    const first = await syncOrdersByUser(uid, {
        '5e': { page_size: 2, fetch_impl: fetchOrders, now_sec: nowSec },
        defer_auth_revoke_worker: true
    });
    assert.strictEqual(first.ok, true);
    assert.strictEqual(first.platforms['5e'].pulled, 3);
    assert.strictEqual(first.platforms['5e'].upserted, 3);
    assert.strictEqual(first.platforms['5e'].linked, 3);
    assert.deepStrictEqual(requestedPages, [1, 2]);
    assert.ok(requestedBodies.every((body) => body.payStartAt === nowSec - 24 * 3600));
    assert.ok(requestedBodies.every((body) => body.payEndAt === nowSec));
    assert.strictEqual(first.platforms['5e'].window.mode, 'pay_time_range_by_account');
    assert.strictEqual(first.platforms['5e'].window.lookback_sec, 24 * 3600);
    assert.strictEqual(first.order_3_off_gate.can_reconcile, true);
    assert.strictEqual(first.auth_revoke.skipped, true);
    assert.strictEqual(first.auth_revoke.reason, 'no_auth_revoke_platform');

    const done = await getOrderByKey(uid, '5e', 'CHILD-DONE');
    const refunded = await getOrderByKey(uid, '5e', 'CHILD-REFUND');
    const renting = await getOrderByKey(uid, '5e', 'CHILD-RENTING');
    assert.strictEqual(done.game_account, 'jorjinagorohov169');
    assert.strictEqual(done.game_id, '4');
    assert.strictEqual(done.order_status, '已完成');
    assert.strictEqual(Number(done.rec_amount), 1.5);
    assert.strictEqual(refunded.order_status, '已退款');
    assert.strictEqual(Number(refunded.rec_amount), 0);
    assert.strictEqual(renting.order_status, '租赁中');
    assert.strictEqual(Number(renting.rec_amount), 3);

    const orderDb = openOrderDatabase();
    try {
        const rows = await all(orderDb, `SELECT order_no, desc FROM "order" WHERE user_id = ? AND channel = '5e' ORDER BY order_no`, [uid]);
        assert.strictEqual(rows.length, 3, '相同父订单下三个子订单应分别保存');
        assert.ok(rows.every((row) => String(row.desc || '').includes('parent_order_no=PARENT-SHARED')));
    } finally {
        orderDb.close();
    }

    requestedPages.length = 0;
    requestedBodies.length = 0;
    const second = await syncOrdersByUser(uid, {
        '5e': { page_size: 2, fetch_impl: fetchOrders, full_sync: true },
        defer_auth_revoke_worker: true
    });
    assert.strictEqual(second.ok, true);
    assert.strictEqual(second.platforms['5e'].window.mode, 'full_by_account');
    assert.ok(requestedBodies.every((body) => !Object.hasOwn(body, 'payStartAt') && !Object.hasOwn(body, 'payEndAt')));
    const orderDbAfter = openOrderDatabase();
    try {
        const rows = await all(orderDbAfter, `SELECT id FROM "order" WHERE user_id = ? AND channel = '5e'`, [uid]);
        assert.strictEqual(rows.length, 3, '重复同步不应新增重复订单');
    } finally {
        orderDbAfter.close();
    }

    assert.strictEqual(buildAuthRevokeCandidate(uid, {
        channel: '5e',
        order_no: 'CHILD-DONE',
        game_id: '4',
        game_name: 'CSGO',
        game_account: 'jorjinagorohov169',
        order_status: '已完成'
    }), null, 'CS2结束订单不得创建解除授权任务');

    const runtimeDb = openRuntimeDatabase();
    try {
        await initRuntimeTaskDb();
        const tasks = await all(runtimeDb, `SELECT id FROM runtime_task WHERE task_type = 'auth_revoke' AND is_deleted = 0`);
        assert.strictEqual(tasks.length, 0, '5E订单同步不得落解除授权任务');
    } finally {
        runtimeDb.close();
    }

    console.log(`[PASS] five_e_order_sync_smoke_test temp_dir=${tempDir}`);
}

main().catch((error) => {
    console.error(`[FAIL] five_e_order_sync_smoke_test: ${error.stack || error.message}`);
    process.exit(1);
});
