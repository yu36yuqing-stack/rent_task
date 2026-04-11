#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-order-query-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');
process.env.ORDER_DB_FILE_PATH = path.join(tempDir, 'rent_robot_order.db');
process.env.ORDER_COUNT_TRACE = 'false';

const { openOrderDatabase } = require('../database/sqlite_client');

const { upsertOrder } = require('../database/order_db');
const {
    initOrderQueryService,
    ORDER_COUNT_MODE_NATURAL_DAY,
    listPaidCountByAccounts,
    listRentingWindowByAccounts,
    listActiveRentingOrdersByUser,
    listLatestEndedOrderSnapshotByAccounts,
    listActiveOrderSnapshotByAccounts,
    listLinkedOrderAccountsByUser,
    listRecentlyEndedAccountsByUser,
    getOrderStatusByOrderNo,
    getOrderEndTimeByOrderNo,
    queryDailyRowsFromOrders
} = require('../order/service/order_query_service');

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

function pad(n) {
    return String(n).padStart(2, '0');
}

function toDateTimeText(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function addMinutes(base, offset) {
    return new Date(base.getTime() + offset * 60 * 1000);
}

function addHours(base, offset) {
    return new Date(base.getTime() + offset * 3600 * 1000);
}

async function seedOrder(row) {
    await upsertOrder({
        user_id: 101,
        channel: 'uuzuhao',
        game_id: '1',
        game_name: 'WZRY',
        role_name: 'RoleA',
        order_amount: 10,
        rent_hour: 2,
        ren_way: 'hour',
        rec_amount: 0,
        start_time: '2026-04-10 07:00:00',
        end_time: '2026-04-10 08:00:00',
        create_date: '2026-04-10 06:59:00',
        desc: 'query smoke',
        ...row
    });
}

async function listOrderIndexNames() {
    const db = openOrderDatabase();
    try {
        return await new Promise((resolve, reject) => {
            db.all(`PRAGMA index_list("order")`, [], (err, rows) => {
                if (err) return reject(err);
                resolve((rows || []).map((row) => String(row.name || '')));
            });
        });
    } finally {
        db.close();
    }
}

async function main() {
    await initOrderQueryService();
    const indexNames = await listOrderIndexNames();
    assertTrue(indexNames.includes('idx_order_user_account_start'), '订单表包含账号起始时间索引');
    assertTrue(indexNames.includes('idx_order_user_account_end'), '订单表包含账号结束时间索引');
    assertTrue(indexNames.includes('idx_order_user_account_status_end'), '订单表包含账号状态结束时间索引');
    assertTrue(indexNames.includes('idx_order_user_order_no'), '订单表包含用户订单号索引');
    assertTrue(indexNames.includes('idx_order_user_game_account_end'), '订单表包含统计聚合索引');

    const now = new Date();
    const nowMinus3h = addHours(now, -3);
    const nowMinus2h = addHours(now, -2);
    const nowMinus90m = addMinutes(now, -90);
    const nowMinus30m = addMinutes(now, -30);
    const nowMinus5m = addMinutes(now, -5);
    const nowPlus30m = addMinutes(now, 30);
    const nowPlus60m = addMinutes(now, 60);
    const nowPlus120m = addMinutes(now, 120);
    const nowMinus25h = addHours(now, -25);
    const nowMinus24h = addHours(now, -24);
    const nowMinus50m = addMinutes(now, -50);
    const nowMinus40m = addMinutes(now, -40);

    await seedOrder({
        order_no: 'DAY_SETTLING',
        game_account: 'acc_day',
        order_status: '结算中',
        start_time: '2026-04-10 07:00:00',
        end_time: '2026-04-10 10:00:00'
    });
    await seedOrder({
        order_no: 'DAY_REC',
        game_account: 'acc_day',
        order_status: '已完成',
        rec_amount: 15,
        start_time: '2026-04-10 08:00:00',
        end_time: '2026-04-10 11:00:00',
        create_date: '2026-04-10 07:30:00',
        role_name: 'RoleB'
    });
    await seedOrder({
        order_no: 'DAY_BEFORE_6',
        game_account: 'acc_day',
        order_status: '已完成',
        rec_amount: 20,
        start_time: '2026-04-10 05:30:00',
        end_time: '2026-04-10 06:30:00'
    });
    await seedOrder({
        order_no: 'DAY_INVALID',
        game_account: 'acc_day',
        order_status: '已取消',
        start_time: '2026-04-10 09:00:00',
        end_time: '2026-04-10 10:30:00'
    });
    await seedOrder({
        order_no: 'DAY_CFM_REC',
        game_id: '3',
        game_name: 'CFM',
        game_account: 'acc_all',
        order_status: '已完成',
        rec_amount: 12,
        start_time: '2026-04-10 12:00:00',
        end_time: '2026-04-10 13:00:00'
    });
    await seedOrder({
        order_no: 'DAY_CFM_REFUND',
        game_id: '3',
        game_name: 'CFM',
        game_account: 'acc_all',
        order_status: '已退款',
        start_time: '2026-04-10 14:00:00',
        end_time: '2026-04-10 15:00:00'
    });

    await seedOrder({
        order_no: 'ROLL_ACTIVE',
        game_account: 'acc_roll',
        order_status: '租赁中',
        start_time: toDateTimeText(nowMinus2h),
        end_time: toDateTimeText(nowPlus60m)
    });
    await seedOrder({
        order_no: 'ROLL_REC',
        game_account: 'acc_roll',
        order_status: '已完成',
        rec_amount: 5,
        start_time: toDateTimeText(nowMinus3h),
        end_time: toDateTimeText(nowMinus2h)
    });
    await seedOrder({
        order_no: 'ROLL_OLD',
        game_account: 'acc_roll',
        order_status: '已完成',
        rec_amount: 8,
        start_time: toDateTimeText(nowMinus25h),
        end_time: toDateTimeText(nowMinus24h)
    });
    await seedOrder({
        order_no: 'ACTIVE_WINDOW',
        game_account: 'acc_window',
        order_status: '预约中',
        start_time: toDateTimeText(nowMinus30m),
        end_time: toDateTimeText(nowPlus30m)
    });
    await seedOrder({
        order_no: 'ACTIVE_TERMINAL',
        game_account: 'acc_terminal',
        order_status: '已退款',
        start_time: toDateTimeText(nowMinus30m),
        end_time: toDateTimeText(nowPlus30m)
    });
    await seedOrder({
        order_no: 'RENTING_DIRECT',
        game_id: '3',
        game_name: 'CFM',
        game_account: 'acc_renting',
        order_status: '租赁中',
        start_time: toDateTimeText(nowMinus90m),
        end_time: toDateTimeText(nowPlus120m)
    });
    await seedOrder({
        order_no: 'LATEST_OLD',
        game_account: 'acc_latest',
        order_status: '已完成',
        rec_amount: 3,
        start_time: toDateTimeText(nowMinus90m),
        end_time: toDateTimeText(nowMinus50m)
    });
    await seedOrder({
        order_no: 'LATEST_NEW_A',
        game_account: 'acc_latest',
        order_status: '已完成',
        rec_amount: 4,
        start_time: toDateTimeText(nowMinus50m),
        end_time: toDateTimeText(nowMinus40m)
    });
    await seedOrder({
        order_no: 'LATEST_NEW_B',
        game_account: 'acc_latest',
        order_status: '已完成',
        rec_amount: 6,
        start_time: toDateTimeText(nowMinus50m),
        end_time: toDateTimeText(nowMinus40m),
        create_date: toDateTimeText(nowMinus30m)
    });
    await seedOrder({
        order_no: 'RECENT_END',
        game_account: 'acc_recent',
        order_status: '已完成',
        rec_amount: 2,
        start_time: toDateTimeText(nowMinus30m),
        end_time: toDateTimeText(nowMinus5m)
    });
    await seedOrder({
        order_no: 'EMPTY_ACCOUNT',
        game_account: '',
        order_status: '租赁中',
        start_time: toDateTimeText(nowMinus30m),
        end_time: toDateTimeText(nowPlus60m)
    });
    await seedOrder({
        order_no: 'ZW_ORDER',
        channel: 'zuhaowang',
        game_account: 'acc_zw',
        order_status: '结算中',
        end_time: '2026-04-10 18:00:00'
    });

    const naturalCounts = await listPaidCountByAccounts(101, [
        { game_id: '1', game_account: 'acc_day' },
        { game_id: '3', game_account: 'acc_all' }
    ], {
        mode: ORDER_COUNT_MODE_NATURAL_DAY,
        dateText: '2026-04-10'
    });
    assertEqual(naturalCounts['1::acc_day'], 2, '自然日计数命中结算中与实收订单');
    assertEqual(naturalCounts['3::acc_all'], 1, '自然日计数过滤退款零实收订单');

    const rollingCounts = await listPaidCountByAccounts(101, [
        { game_id: '1', game_account: 'acc_roll' }
    ], {
        mode: 'rolling_24h'
    });
    assertEqual(rollingCounts['1::acc_roll'], 2, '滚动 24h 计数过滤 24h 之外订单');

    const rentingWindow = await listRentingWindowByAccounts(101, [
        { game_id: '1', game_account: 'acc_roll' },
        { game_id: '3', game_account: 'acc_renting' }
    ]);
    assertEqual(rentingWindow['1::acc_roll'].count, 1, '在租窗口按账号聚合数量');
    assertEqual(rentingWindow['3::acc_renting'].count, 1, '跨游戏在租窗口可读取');

    const activeRentingOrders = await listActiveRentingOrdersByUser(101);
    assertTrue(activeRentingOrders.some((row) => row.game_account === 'acc_roll'), '在租订单列表包含租赁中订单');
    assertTrue(activeRentingOrders.some((row) => row.game_account === 'acc_renting'), '在租订单列表包含第二个游戏订单');
    assertTrue(!activeRentingOrders.some((row) => !row.game_account), '在租订单列表过滤空账号');

    const latestEnded = await listLatestEndedOrderSnapshotByAccounts(101, [
        { game_id: '1', game_account: 'acc_latest' }
    ]);
    assertEqual(latestEnded['1::acc_latest'].order_no, 'LATEST_NEW_B', '最近结束快照在同结束时间下取最新 id');

    const activeSnapshot = await listActiveOrderSnapshotByAccounts(101, [
        { game_id: '1', game_account: 'acc_window' },
        { game_id: '1', game_account: 'acc_terminal' },
        { game_id: '3', game_account: 'acc_renting' }
    ]);
    assertEqual(activeSnapshot['1::acc_window'].order_no, 'ACTIVE_WINDOW', '活跃快照可按时间窗识别');
    assertTrue(!activeSnapshot['1::acc_terminal'], '活跃快照过滤终态订单');
    assertEqual(activeSnapshot['3::acc_renting'].order_no, 'RENTING_DIRECT', '活跃快照保留租赁中订单');

    const linkedAccounts = await listLinkedOrderAccountsByUser(101);
    const accDay = linkedAccounts.find((row) => String(row.game_account || '').trim() === 'acc_day');
    assertTrue(Boolean(accDay), '联动账号列表包含订单账号');
    assertEqual(String(accDay.role_name || '').trim(), 'RoleB', '联动账号列表聚合非空 role_name');

    const recentEnded = await listRecentlyEndedAccountsByUser(101, [
        { game_id: '1', game_account: 'acc_recent' },
        { game_id: '1', game_account: 'acc_latest' }
    ], 600);
    assertTrue(recentEnded.has('1::acc_recent'), '最近结束账号窗口命中近 10 分钟订单');
    assertTrue(!recentEnded.has('1::acc_latest'), '最近结束账号窗口过滤过旧订单');

    const statusByAlias = await getOrderStatusByOrderNo(101, 'ZW_ORDER', 'zuhaowang-yuanbao');
    assertEqual(statusByAlias, '结算中', '平台别名可归一化查询订单状态');
    const endTimeNoChannel = await getOrderEndTimeByOrderNo(101, 'ZW_ORDER');
    assertEqual(endTimeNoChannel, '2026-04-10 18:00:00', '省略渠道也可查询订单结束时间');
    assertEqual(await getOrderStatusByOrderNo(101, 'NOT_FOUND', 'uuzuhao'), '', '未知订单状态返回空串');

    const wzryDailyRows = await queryDailyRowsFromOrders(101, '2026-04-10', 'WZRY', [
        { game_account: 'acc_day' },
        { game_account: 'acc_all' }
    ]);
    assertEqual(wzryDailyRows.length, 1, '单游戏日统计只返回对应游戏');
    assertEqual(String(wzryDailyRows[0].game_account || ''), 'acc_day', '单游戏日统计返回正确账号');
    assertEqual(Number(wzryDailyRows[0].order_cnt_total || 0), 4, '单游戏日统计总单数正确');
    assertEqual(Number(wzryDailyRows[0].order_cnt_effective || 0), 2, '单游戏日统计有效单数正确');
    assertEqual(Number(wzryDailyRows[0].order_cnt_done || 0), 3, '单游戏日统计完成态单数正确');
    assertEqual(Number(wzryDailyRows[0].order_cnt_zero_rec || 0), 2, '单游戏日统计零实收单数正确');

    const allDailyRows = await queryDailyRowsFromOrders(101, '2026-04-10', '全部', [
        { game_account: 'acc_day' },
        { game_account: 'acc_all' }
    ]);
    assertEqual(allDailyRows.length, 2, '全部游戏日统计按账号返回多行');
    const accAllRow = allDailyRows.find((row) => String(row.game_account || '') === 'acc_all');
    assertEqual(Number(accAllRow.order_cnt_refund || 0), 1, '全部游戏日统计保留退款计数');

    console.log(`[OrderQueryServiceSmoke] ok temp_dir=${tempDir}`);
}

main().catch((err) => {
    console.error(`[OrderQueryServiceSmoke] failed: ${err.message}`);
    process.exit(1);
});
