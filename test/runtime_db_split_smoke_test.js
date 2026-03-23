#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-runtime-smoke-'));
const mainDbFile = path.join(tempDir, 'rent_robot.db');
const runtimeDbFile = path.join(tempDir, 'rent_robot_runtime.db');

process.env.MAIN_DB_FILE_PATH = mainDbFile;
process.env.RUNTIME_DB_FILE_PATH = runtimeDbFile;

const {
    MAIN_DB_FILE,
    RUNTIME_DB_FILE,
    openMainDatabase,
    openRuntimeDatabase
} = require('../database/sqlite_client');
const { initUserDb, createUserByAdmin } = require('../database/user_db');
const {
    initUserSessionDb,
    createRefreshSession,
    verifyRefreshSession
} = require('../database/user_session_db');
const {
    initOrderSyncDb,
    getLastSyncTimestamp,
    setLastSyncTimestamp
} = require('../database/order_sync_db');
const {
    initOrderStatsJobStateDb,
    getLastRunDate,
    setLastRunDate
} = require('../database/order_stats_job_state_db');
const {
    initLockDb,
    tryAcquireLock,
    releaseLock
} = require('../database/lock_db');

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
}

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row || null);
        });
    });
}

function assertTrue(cond, msg) {
    if (!cond) throw new Error(msg);
}

function assertEqual(actual, expected, msg) {
    if (actual !== expected) {
        throw new Error(`${msg}: expected=${expected}, actual=${actual}`);
    }
}

async function countRows(openDb, tableName) {
    const db = openDb();
    try {
        const row = await get(db, `SELECT COUNT(*) AS total FROM ${tableName}`);
        return Number((row && row.total) || 0);
    } finally {
        db.close();
    }
}

async function main() {
    assertEqual(MAIN_DB_FILE, mainDbFile, '主库路径错误');
    assertEqual(RUNTIME_DB_FILE, runtimeDbFile, '运行时库路径错误');

    await initUserDb();
    await initUserSessionDb();
    await initOrderSyncDb();
    await initOrderStatsJobStateDb();
    await initLockDb();

    const user = await createUserByAdmin({
        account: `runtime_smoke_${Date.now()}`,
        password: 'Passw0rd!123',
        name: 'runtime smoke',
        user_type: '内部',
        desc: 'runtime split smoke'
    });
    const userId = Number(user && user.id || 0);
    assertTrue(userId > 0, '创建测试用户失败');

    await createRefreshSession(userId, 'runtime-refresh-token', 3600, 'runtime token');
    let verifyOut = await verifyRefreshSession('runtime-refresh-token');
    assertTrue(Boolean(verifyOut && verifyOut.ok), 'runtime session 校验失败');

    await setLastSyncTimestamp(userId, 'uuzuhao', 1773285601, 'runtime sync');
    assertEqual(await getLastSyncTimestamp(userId, 'uuzuhao'), 1773285601, 'runtime sync 状态写入失败');

    await setLastRunDate('runtime_smoke_job', '2026-03-12', 'runtime job');
    assertEqual(await getLastRunDate('runtime_smoke_job'), '2026-03-12', 'runtime stats 状态写入失败');

    const lock = await tryAcquireLock('runtime_smoke_lock', 120, 'runtime owner');
    assertTrue(Boolean(lock && lock.acquired), 'runtime lock 获取失败');
    assertTrue(await releaseLock('runtime_smoke_lock', 'runtime release'), 'runtime lock 释放失败');

    const runtimeDb = openRuntimeDatabase();
    try {
        await run(runtimeDb, `
            INSERT INTO lock_db (lock_key, lease_until, modify_date, is_deleted, desc)
            VALUES ('runtime_stale_pid_lock', ?, '2026-03-24 00:00:00', 0, 'cron/pipeline user_id=8 pid=999999')
        `, [Math.floor(Date.now() / 1000) + 600]);
    } finally {
        runtimeDb.close();
    }
    const reclaimed = await tryAcquireLock('runtime_stale_pid_lock', 120, 'runtime reclaim');
    assertTrue(Boolean(reclaimed && reclaimed.acquired), '应允许回收 owner pid 已不存在的 stale lock');
    assertTrue(await releaseLock('runtime_stale_pid_lock', 'runtime stale release'), 'stale lock 释放失败');

    assertEqual(await countRows(openMainDatabase, 'user'), 1, 'user 应落主库');
    assertEqual(await countRows(openRuntimeDatabase, 'user_session'), 1, 'user_session 应落运行时库');
    assertEqual(await countRows(openRuntimeDatabase, 'order_sync_state'), 1, 'order_sync_state 应落运行时库');
    assertEqual(await countRows(openRuntimeDatabase, 'order_stats_job_state'), 1, 'order_stats_job_state 应落运行时库');
    assertEqual(await countRows(openRuntimeDatabase, 'lock_db'), 2, 'lock_db 应落运行时库');

    const mainDb = openMainDatabase();
    try {
        await run(mainDb, `
            CREATE TABLE IF NOT EXISTS user_session (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                refresh_token_hash TEXT NOT NULL,
                expire_at TEXT NOT NULL,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        await run(mainDb, `
            CREATE TABLE IF NOT EXISTS order_sync_state (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                channel TEXT NOT NULL DEFAULT '',
                last_sync_ts INTEGER NOT NULL DEFAULT 0,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        await run(mainDb, `
            CREATE TABLE IF NOT EXISTS order_stats_job_state (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                job_key TEXT NOT NULL DEFAULT '',
                last_run_date TEXT NOT NULL DEFAULT '',
                create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        await run(mainDb, `
            CREATE TABLE IF NOT EXISTS lock_db (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                lock_key TEXT NOT NULL,
                lease_until INTEGER NOT NULL DEFAULT 0,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        await run(mainDb, `
            INSERT INTO user_session (user_id, refresh_token_hash, expire_at, modify_date, is_deleted, desc)
            VALUES (?, ?, ?, '2026-03-12 10:16:39', 0, 'legacy main session')
        `, [userId, 'legacy_hash', '2026-03-19T02:16:39.884Z']);
        await run(mainDb, `
            INSERT INTO order_sync_state (user_id, channel, last_sync_ts, modify_date, is_deleted, desc)
            VALUES (?, 'zuhaowang', 1773285609, '2026-03-12 11:20:11', 0, 'legacy sync')
        `, [userId]);
        await run(mainDb, `
            INSERT INTO order_stats_job_state (job_key, last_run_date, create_date, modify_date, is_deleted, desc)
            VALUES ('legacy_job', '2026-03-11', '2026-03-11 17:55:00', '2026-03-11 17:55:17', 0, 'legacy stats')
        `);
        await run(mainDb, `
            INSERT INTO lock_db (lock_key, lease_until, modify_date, is_deleted, desc)
            VALUES ('legacy_lock', 1773286000, '2026-03-12 11:20:12', 0, 'legacy lock')
        `);
    } finally {
        mainDb.close();
    }

    execFileSync(process.execPath, [path.join(__dirname, '..', 'scripts', 'migrate_runtime_db.js')], {
        cwd: path.join(__dirname, '..'),
        env: process.env,
        stdio: 'pipe'
    });

    assertEqual(await countRows(openRuntimeDatabase, 'user_session'), 1, '迁移后 user_session 行数错误');
    assertEqual(await countRows(openRuntimeDatabase, 'order_sync_state'), 1, '迁移后 order_sync_state 行数错误');
    assertEqual(await countRows(openRuntimeDatabase, 'order_stats_job_state'), 1, '迁移后 order_stats_job_state 行数错误');
    assertEqual(await countRows(openRuntimeDatabase, 'lock_db'), 0, '默认不应迁移旧 lock_db');

    verifyOut = await verifyRefreshSession('runtime-refresh-token');
    assertTrue(!verifyOut.ok, '迁移后应读到主库导入的新 session 数据');
    assertEqual(await getLastSyncTimestamp(userId, 'zuhaowang'), 1773285609, '迁移后未读到主库 sync 状态');
    assertEqual(await getLastRunDate('legacy_job'), '2026-03-11', '迁移后未读到主库 job 状态');

    console.log(`[RuntimeDbSplitSmoke] ok main=${mainDbFile} runtime=${runtimeDbFile}`);
}

main().catch((err) => {
    console.error(`[RuntimeDbSplitSmoke] failed: ${err.message}`);
    process.exit(1);
});
