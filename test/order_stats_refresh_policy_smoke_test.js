#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-stats-refresh-'));
const mainDbFile = path.join(tempDir, 'rent_robot.db');
const runtimeDbFile = path.join(tempDir, 'rent_robot_runtime.db');
const statsDbFile = path.join(tempDir, 'rent_robot_stats.db');
const orderDbFile = path.join(tempDir, 'rent_robot_order.db');

process.env.MAIN_DB_FILE_PATH = mainDbFile;
process.env.RUNTIME_DB_FILE_PATH = runtimeDbFile;
process.env.STATS_DB_FILE_PATH = statsDbFile;
process.env.ORDER_DB_FILE_PATH = orderDbFile;

const {
    initUserDb,
    createUserByAdmin
} = require('../database/user_db');
const {
    initUserGameAccountDb,
    upsertUserGameAccount
} = require('../database/user_game_account_db');
const {
    initOrderDb,
    upsertOrder
} = require('../database/order_db');
const {
    initOrderStatsDailyDb,
    listOrderStatsRows
} = require('../database/order_stats_daily_db');
const {
    initOrderStatsWeeklySnapshotDb,
    listWeeklySnapshotsByUser
} = require('../database/order_stats_weekly_snapshot_db');
const {
    normalizeStatsRefreshRange,
    refreshOrderStatsDailyByUser,
    getOrderStatsDashboardByUser
} = require('../stats/order_stats');

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
    if (actual !== expected) fail(`${msg} | expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
    pass(msg);
}

function toDateText(d) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function addDays(base, offset) {
    const d = new Date(base);
    d.setDate(d.getDate() + offset);
    return d;
}

function toDateTimeText(d, hour = 12) {
    const pad = (n) => String(n).padStart(2, '0');
    return `${toDateText(d)} ${pad(hour)}:00:00`;
}

async function seedUserAndOrders(now) {
    await initUserDb();
    await initUserGameAccountDb();
    await initOrderDb();
    await initOrderStatsDailyDb();
    await initOrderStatsWeeklySnapshotDb();

    const user = await createUserByAdmin({
        account: `stats_smoke_${Date.now()}`,
        password: 'Passw0rd!123',
        name: 'stats smoke',
        user_type: '内部',
        desc: 'stats refresh smoke'
    });
    const userId = Number(user && user.id || 0);
    assertTrue(userId > 0, '创建统计测试用户成功');

    await upsertUserGameAccount({
        user_id: userId,
        game_account: 'acc_wzry_1',
        game_name: 'WZRY',
        purchase_price: 100,
        purchase_date: '2026-01-01',
        desc: 'stats smoke account'
    });

    for (let i = 0; i < 30; i += 1) {
        const day = addDays(now, -i);
        await upsertOrder({
            user_id: userId,
            channel: 'uuzuhao',
            order_no: `SMOKE_${i}`,
            game_id: '1',
            game_name: 'WZRY',
            game_account: 'acc_wzry_1',
            role_name: 'SmokeRole',
            order_status: '已完成',
            order_amount: 10 + i,
            rent_hour: 2,
            ren_way: 'hour',
            rec_amount: 5 + i,
            start_time: toDateTimeText(day, 10),
            end_time: toDateTimeText(day, 12),
            create_date: toDateTimeText(day, 9),
            desc: `smoke order day-${i}`
        });
    }
    return { userId };
}

async function main() {
    const now = new Date('2026-03-25T00:00:00');
    const { userId } = await seedUserAndOrders(now);

    const normal60 = normalizeStatsRefreshRange({ mode: 'normal', days: 60, now });
    assertEqual(normal60.days, 14, 'normal 模式 60 天被截断到 14');

    const backfill60 = normalizeStatsRefreshRange({ mode: 'backfill', days: 60, now });
    assertEqual(backfill60.days, 60, 'backfill 模式 60 天保持不变');

    let normalStartErr = '';
    try {
        normalizeStatsRefreshRange({ mode: 'normal', start_date: '2026-03-01', now });
    } catch (e) {
        normalStartErr = String(e && e.message ? e.message : e);
    }
    assertTrue(normalStartErr.includes('start_date'), 'normal 模式拒绝 start_date');

    const outNormal = await refreshOrderStatsDailyByUser(userId, {
        mode: 'normal',
        days: 60,
        game_name: 'WZRY',
        now,
        desc: 'smoke normal 60'
    });
    assertEqual(outNormal.days, 14, '单用户 normal 60 实际返回 14');
    assertEqual((outNormal.touched || []).length, 14, '单用户 normal 60 实际重算 14 天');
    assertEqual(String((outNormal.touched || [])[13].stat_date || ''), '2026-03-12', 'normal 14 天起点正确');

    const outBackfill = await refreshOrderStatsDailyByUser(userId, {
        mode: 'backfill',
        days: 21,
        game_name: 'WZRY',
        now,
        desc: 'smoke backfill 21'
    });
    assertEqual(outBackfill.days, 21, '单用户 backfill 21 实际返回 21');
    assertEqual((outBackfill.touched || []).length, 21, '单用户 backfill 21 实际重算 21 天');
    assertEqual(String((outBackfill.touched || [])[20].stat_date || ''), '2026-03-05', 'backfill 21 天起点正确');

    const rows14 = await listOrderStatsRows(userId, '2026-03-12', '2026-03-25', 'WZRY');
    assertTrue(rows14.length > 0, 'normal/backfill 后统计表可读');
    const weeklyRows = await listWeeklySnapshotsByUser(userId, 'WZRY', '2026-03-25');
    assertTrue(weeklyRows.length > 0, '刷新后已生成周累计快照');
    const dashboard = await getOrderStatsDashboardByUser(userId, {
        game_name: 'WZRY',
        period: 'last7',
        now
    });
    assertTrue(Number((((dashboard || {}).summary || {}).total_rec_amount_all_time || 0)) > 0, '看板返回历史总收入 KPI');
    assertTrue(Number(((((dashboard || {}).by_account || [])[0] || {}).total_rec_amount_all_time || 0)) > 0, '看板返回账号历史总收入');

    const workerOut = execFileSync(process.execPath, [path.join(__dirname, '..', 'stats', 'order_stats_worker.js')], {
        cwd: path.join(__dirname, '..'),
        env: {
            ...process.env,
            ORDER_STATS_DAILY_RECALC_DAYS: '60'
        },
        encoding: 'utf8'
    });
    assertTrue(workerOut.includes('recalc_days=14 requested_days=60'), 'worker 会把 60 天请求截断到 14');

    const rebuildOut = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'rebuild_order_stats.js'), '--user_id', String(userId), '--game_name', 'WZRY', '--days', '21'], {
        cwd: path.join(__dirname, '..'),
        env: process.env,
        encoding: 'utf8'
    });
    const rebuildJson = JSON.parse(rebuildOut);
    assertEqual(Number(rebuildJson.refresh_range.days || 0), 21, '通用重建脚本支持 backfill 21 天');

    const rebuild90Out = execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'rebuild_order_stats_90d.js')], {
        cwd: path.join(__dirname, '..'),
        env: process.env,
        encoding: 'utf8'
    });
    const rebuild90Json = JSON.parse(rebuild90Out);
    assertEqual(Number(rebuild90Json.days || 0), 90, '90 天脚本保持 90 天');
    assertTrue(Number((rebuild90Json.summary || {}).ok_users || 0) >= 1, '90 天脚本可正常执行');

    console.log(`[OrderStatsRefreshPolicySmoke] ok temp_dir=${tempDir}`);
}

main().catch((err) => {
    console.error(`[OrderStatsRefreshPolicySmoke] failed: ${err.message}`);
    process.exit(1);
});
