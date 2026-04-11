#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-order-command-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');

const {
    initOrderCommandService,
    upsertOrder,
    getOrderByKey,
    updateOrderRecAmount,
    upsertOrderDetail,
    getOrderDetailByOrder,
    listPendingUhaozuOrderDetailsByUser,
    upsertOrderComplaint,
    getOrderComplaintByOrder,
    getLastSyncTimestamp,
    setLastSyncTimestamp
} = require('../order/service/order_command_service');

function fail(msg) {
    console.error(`[FAIL] ${msg}`);
    process.exit(1);
}

function pass(msg) {
    console.log(`[PASS] ${msg}`);
}

function assertTrue(cond, msg) {
    if (!cond) fail(msg);
    pass(msg);
}

function assertEqual(actual, expected, msg) {
    if (actual !== expected) {
        fail(`${msg} | expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
    }
    pass(msg);
}

async function main() {
    await initOrderCommandService();

    await upsertOrder({
        user_id: 201,
        channel: 'uhaozu',
        order_no: 'CMD_ORDER_1',
        game_id: '1',
        game_name: 'WZRY',
        game_account: 'cmd_acc',
        role_name: 'CmdRole',
        order_status: '已完成',
        order_amount: 66.6,
        rent_hour: 6,
        rec_amount: 0,
        start_time: '2026-04-10 08:00:00',
        end_time: '2026-04-10 10:00:00',
        create_date: '2026-04-10 07:59:00',
        desc: 'command smoke order'
    });
    let orderRow = await getOrderByKey(201, 'uhaozu', 'CMD_ORDER_1');
    assertEqual(String(orderRow.game_account || ''), 'cmd_acc', '命令服务可写入并读取订单');

    await updateOrderRecAmount(201, 'uhaozu', 'CMD_ORDER_1', 48.88, 'updated rec');
    orderRow = await getOrderByKey(201, 'uhaozu', 'CMD_ORDER_1');
    assertEqual(Number(orderRow.rec_amount || 0), 48.88, '命令服务可更新订单实收');
    assertEqual(String(orderRow.desc || ''), 'updated rec', '命令服务更新实收时可覆盖备注');

    let pendingRows = await listPendingUhaozuOrderDetailsByUser(201, ['CMD_ORDER_1']);
    assertEqual(pendingRows.length, 1, '已完成 uhaozu 订单在无详情时进入待补详情列表');

    await upsertOrderDetail({
        user_id: 201,
        channel: 'uhaozu',
        order_no: 'CMD_ORDER_1',
        order_detail_no: 'DETAIL_1',
        detail_status: 'done',
        actual_rent_amount: 60,
        service_fee_amount: 10,
        net_rent_amount: 50,
        complete_time: '2026-04-10 10:05:00',
        complaint_result_text: 'none',
        detail_snapshot: { foo: 'bar' },
        desc: 'detail smoke'
    });
    const detailRow = await getOrderDetailByOrder(201, 'uhaozu', 'CMD_ORDER_1');
    assertEqual(String(detailRow.order_detail_no || ''), 'DETAIL_1', '命令服务可写入并读取订单详情');
    assertEqual(String((detailRow.detail_snapshot || {}).foo || ''), 'bar', '订单详情快照会反序列化');

    pendingRows = await listPendingUhaozuOrderDetailsByUser(201, ['CMD_ORDER_1']);
    assertEqual(pendingRows.length, 0, '净收入已回填的订单不再属于待补详情');

    await upsertOrderComplaint({
        user_id: 201,
        channel: 'uhaozu',
        order_no: 'CMD_ORDER_1',
        complaint_status: 1,
        complaint_id: 'CMP_1',
        complaint_type: 2,
        complaint_type_desc: 'late',
        complaint_context: 'smoke context',
        complaint_start_time_raw: 1712800000,
        first_log_time_raw: 1712800300,
        rent_duration: '2h',
        check_result_desc: 'pass',
        complaint_attachment: 'http://example.com/a.png',
        raw_payload: { source: 'smoke' }
    }, {
        desc: 'complaint smoke'
    });
    const complaintRow = await getOrderComplaintByOrder(201, 'uhaozu', 'CMD_ORDER_1');
    assertEqual(String(complaintRow.complaint_id || ''), 'CMP_1', '命令服务可写入并读取投诉信息');
    assertTrue(String(complaintRow.raw_payload || '').includes('smoke'), '投诉原始载荷被保留');

    await setLastSyncTimestamp(201, 'uhaozu', 1712800400, 'sync smoke');
    assertEqual(await getLastSyncTimestamp(201, 'uhaozu'), 1712800400, '命令服务可写入并读取同步游标');

    console.log(`[OrderCommandServiceSmoke] ok temp_dir=${tempDir}`);
}

main().catch((err) => {
    console.error(`[OrderCommandServiceSmoke] failed: ${err.message}`);
    process.exit(1);
});
