#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-stats-history-total-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');
process.env.STATS_DB_FILE_PATH = path.join(tempDir, 'rent_robot_stats.db');
process.env.ORDER_DB_FILE_PATH = path.join(tempDir, 'rent_robot_order.db');

const { openDatabase, openStatsDatabase } = require('../database/sqlite_client');
const { initUserGameAccountDb } = require('../database/user_game_account_db');
const { initOrderStatsDailyDb } = require('../database/order_stats_daily_db');
const { initOrderStatsWeeklySnapshotDb } = require('../database/order_stats_weekly_snapshot_db');
const { getOrderStatsDashboardByUser } = require('../stats/order_stats');

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
}

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

async function seedAccounts(userId) {
    await initUserGameAccountDb();
    const db = openDatabase();
    try {
        await run(db, `
            INSERT INTO user_game_account
            (user_id, game_account, account_remark, game_id, game_name, channel_status, channel_prd_info, "switch",
             purchase_price, purchase_date, asset_status, sold_at, lifecycle_income_amount, modify_date, is_deleted, desc)
            VALUES
            (?, 'active_peace_001', '活跃和平', '2', '和平精英', '{}', '{}', '{}',
             100, '2026-01-01', 'active', '', 0, '2026-06-01 00:00:00', 0, 'stats history total smoke active'),
            (?, 'sold_peace_001', '已售和平', '2', '和平精英', '{}', '{}', '{}',
             100, '2026-01-01', 'sold', '2026-05-18', 50, '2026-06-01 00:00:00', 0, 'stats history total smoke sold')
        `, [userId, userId]);
    } finally {
        db.close();
    }
}

async function seedStats(userId) {
    await initOrderStatsDailyDb();
    await initOrderStatsWeeklySnapshotDb();
    const db = openStatsDatabase();
    try {
        await run(db, `
            INSERT INTO order_stats_daily
            (stat_date, user_id, game_name, channel, game_account, role_name, purchase_price, purchase_date,
             order_cnt_total, order_cnt_effective, order_cnt_progress, order_cnt_done, order_cnt_refund, order_cnt_cancel,
             order_cnt_zero_rec, rent_hour_sum, amount_order_sum, amount_rec_sum, amount_refund_sum,
             create_date, modify_date, is_deleted, desc)
            VALUES
            ('2026-05-18', ?, '和平精英', 'uuzuhao', 'sold_peace_001', '已售和平', 100, '2026-01-01',
             1, 1, 0, 1, 0, 0, 0, 1, 50, 50, 0, '2026-05-18 12:00:00', '2026-05-18 12:00:00', 0, 'sold income'),
            ('2026-06-02', ?, '和平精英', 'uuzuhao', 'active_peace_001', '活跃和平', 100, '2026-01-01',
             1, 1, 0, 1, 0, 0, 0, 1, 100, 100, 0, '2026-06-02 12:00:00', '2026-06-02 12:00:00', 0, 'active income')
        `, [userId, userId]);
    } finally {
        db.close();
    }
}

async function main() {
    const userId = 88008;
    const now = new Date('2026-06-17T12:00:00');
    await seedAccounts(userId);
    await seedStats(userId);

    const month = await getOrderStatsDashboardByUser(userId, {
        period: 'month',
        game_name: '和平精英',
        now
    });
    const last30 = await getOrderStatsDashboardByUser(userId, {
        period: 'last30',
        game_name: '和平精英',
        now
    });

    assertEqual(Number(month.summary.total_rec_amount_all_time || 0), 150, '本月顶部历史总收入包含已售账号历史收入');
    assertEqual(Number(last30.summary.total_rec_amount_all_time || 0), 150, '近30天顶部历史总收入包含已售账号历史收入');
    assertEqual(Number(month.summary.total_rec_amount_all_time || 0), Number(last30.summary.total_rec_amount_all_time || 0), '不同周期顶部历史总收入保持一致');
    assertEqual(month.by_account.length, 1, '本月卡片仍隐藏周期内无收入的已售账号');
    assertEqual(last30.by_account.length, 2, '近30天卡片仍展示周期内有收入的已售账号');

    console.log(`[OrderStatsHistoricalTotalScopeSmoke] ok temp_dir=${tempDir}`);
}

main().catch((err) => {
    console.error(`[OrderStatsHistoricalTotalScopeSmoke] failed: ${err.message}`);
    process.exit(1);
});
