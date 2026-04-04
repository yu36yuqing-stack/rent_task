#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-uhaozu-pending-'));
const mainDbFile = path.join(tempDir, 'rent_robot.db');
const runtimeDbFile = path.join(tempDir, 'rent_robot_runtime.db');
const statsDbFile = path.join(tempDir, 'rent_robot_stats.db');

process.env.MAIN_DB_FILE_PATH = mainDbFile;
process.env.RUNTIME_DB_FILE_PATH = runtimeDbFile;
process.env.STATS_DB_FILE_PATH = statsDbFile;

const { initOrderDb, upsertOrder } = require('../database/order_db');
const { mapUhaozuOrderToOrder } = require('../order/order_mapping');
const { listOrdersForUser } = require('../order/order');

function fail(msg) {
    console.error(`[FAIL] ${msg}`);
    process.exit(1);
}

function pass(msg) {
    console.log(`[PASS] ${msg}`);
}

function assertEqual(actual, expected, msg) {
    if (actual !== expected) fail(`${msg} | expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
    pass(msg);
}

async function main() {
    await initOrderDb();

    const mapped = mapUhaozuOrderToOrder({
        id: 'U_PENDING_1',
        status: 10,
        gameId: '1',
        gameName: '王者荣耀',
        rent: 1200,
        actualRent: 0,
        rentNum: 1,
        rentWay: 10,
        createTime: '2026-04-04 09:00:00',
        startTime: '2026-04-04 10:00:00',
        endTime: '2026-04-04 11:00:00'
    }, {
        game_account: 'acc_pending',
        role_name: 'role_pending'
    });
    assertEqual(mapped.order_status, '待支付', 'uhaozu 10 映射为待支付');

    await upsertOrder({
        user_id: 101,
        channel: 'uhaozu',
        order_no: 'U_PENDING_1',
        game_id: '1',
        game_name: 'WZRY',
        game_account: 'acc_pending',
        role_name: 'role_pending',
        order_status: 10,
        order_amount: 12,
        rent_hour: 1,
        ren_way: '时租',
        rec_amount: 0,
        start_time: '2026-04-04 10:00:00',
        end_time: '2026-04-04 11:00:00',
        create_date: '2026-04-04 09:00:00',
        desc: 'pending smoke'
    });
    await upsertOrder({
        user_id: 101,
        channel: 'uhaozu',
        order_no: 'U_DONE_1',
        game_id: '1',
        game_name: 'WZRY',
        game_account: 'acc_done',
        role_name: 'role_done',
        order_status: '已完成',
        order_amount: 20,
        rent_hour: 2,
        ren_way: '时租',
        rec_amount: 8,
        start_time: '2026-04-04 08:00:00',
        end_time: '2026-04-04 12:00:00',
        create_date: '2026-04-04 07:00:00',
        desc: 'done smoke'
    });
    await upsertOrder({
        user_id: 101,
        channel: 'uuzuhao',
        order_no: 'U_PROGRESS_1',
        game_id: '1',
        game_name: 'WZRY',
        game_account: 'acc_progress',
        role_name: 'role_progress',
        order_status: '租赁中',
        order_amount: 15,
        rent_hour: 2,
        ren_way: '时租',
        rec_amount: 0,
        start_time: '2026-04-04 06:00:00',
        end_time: '2026-04-04 18:00:00',
        create_date: '2026-04-04 05:00:00',
        desc: 'progress smoke'
    });

    const all = await listOrdersForUser(101, {
        game_name: 'WZRY',
        quick_filter: 'today',
        status_filter: 'all'
    });
    assertEqual(Number((all.stats || {}).progress || 0), 1, 'progress 统计仅计算租赁中');
    assertEqual(Number((all.stats || {}).done || 0), 1, 'done 统计不包含待支付');
    assertEqual(Number((all.stats || {}).done_zero || 0), 0, 'done_zero 统计不包含待支付 0 收订单');

    const doneOnly = await listOrdersForUser(101, {
        game_name: 'WZRY',
        quick_filter: 'today',
        status_filter: 'done'
    });
    assertEqual(Number(doneOnly.total || 0), 1, 'done 筛选不包含待支付');
    assertEqual(String((((doneOnly.list || [])[0]) || {}).order_no || ''), 'U_DONE_1', 'done 列表仅返回已完成单');

    console.log(`[UhaozuPendingStatusSmoke] ok temp_dir=${tempDir}`);
}

main().catch((err) => {
    console.error(`[UhaozuPendingStatusSmoke] failed: ${err.message}`);
    process.exit(1);
});
