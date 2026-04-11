#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-schema-migration-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');

const { openDatabase } = require('../database/sqlite_client');
const { initOrderDb } = require('../database/order_db');
const { runPendingMigrations, listPendingMigrations } = require('../database/migration_runner');
const { listAppliedSchemaMigrations } = require('../database/schema_migration_db');

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

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
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

function assertTrue(cond, msg) {
    if (!cond) fail(msg);
    pass(msg);
}

function assertEqual(actual, expected, msg) {
    if (actual !== expected) fail(`${msg} | expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
    pass(msg);
}

async function createLegacyUserOrder() {
    const db = openDatabase();
    try {
        await run(db, `
            CREATE TABLE user_order (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                channel TEXT NOT NULL DEFAULT '',
                order_no TEXT NOT NULL DEFAULT '',
                game_id TEXT NOT NULL DEFAULT '',
                game_name TEXT NOT NULL DEFAULT '',
                game_account TEXT NOT NULL DEFAULT '',
                role_name TEXT NOT NULL DEFAULT '',
                order_status TEXT NOT NULL DEFAULT '',
                create_time TEXT NOT NULL DEFAULT '',
                order_amount REAL NOT NULL DEFAULT 0,
                rec_amount REAL NOT NULL DEFAULT 0,
                start_time TEXT NOT NULL DEFAULT '',
                end_time TEXT NOT NULL DEFAULT '',
                ren_hour INTEGER NOT NULL DEFAULT 0,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        await run(db, `
            INSERT INTO user_order
            (user_id, channel, order_no, game_id, game_name, game_account, role_name, order_status, create_time, order_amount, rec_amount, start_time, end_time, ren_hour, modify_date, is_deleted, desc)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        `, [
            501,
            'uuzuhao',
            'LEGACY_1',
            '1',
            '王者荣耀',
            'legacy_acc',
            'LegacyRole',
            '出租中',
            '2026-04-11 08:00:00',
            20,
            5,
            '2026-04-11 09:00:00',
            '2026-04-11 11:00:00',
            2,
            '2026-04-11 11:10:00',
            'legacy row'
        ]);
    } finally {
        db.close();
    }
}

async function main() {
    await createLegacyUserOrder();

    await initOrderDb();
    const db1 = openDatabase();
    try {
        const legacyExists = await get(db1, `
            SELECT name FROM sqlite_master
            WHERE type='table' AND name='user_order'
        `);
        const migratedRow = await get(db1, `SELECT COUNT(*) AS total FROM "order" WHERE order_no = 'LEGACY_1'`);
        assertTrue(Boolean(legacyExists), '轻量 initOrderDb 不再隐式迁移 legacy 表');
        assertEqual(Number(migratedRow.total || 0), 0, '轻量 initOrderDb 不会偷偷回填 legacy 订单');
    } finally {
        db1.close();
    }

    const pendingBefore = await listPendingMigrations();
    assertTrue(pendingBefore.length > 0, '初始状态存在待执行 migration');

    const summary = await runPendingMigrations({ logger: console });
    assertEqual(summary.pending_before, 1, '首次执行应命中一个 pending migration');
    assertEqual(summary.pending_after, 0, '首次执行后不应残留 pending migration');

    const db2 = openDatabase();
    try {
        const legacyExistsAfter = await get(db2, `
            SELECT name FROM sqlite_master
            WHERE type='table' AND name='user_order'
        `);
        const migrated = await get(db2, `
            SELECT game_name, game_id, order_status, ren_way
            FROM "order"
            WHERE user_id = ? AND order_no = ?
            LIMIT 1
        `, [501, 'LEGACY_1']);
        const indexRows = await all(db2, `PRAGMA index_list("order")`);
        assertTrue(!legacyExistsAfter, 'migration 执行后 legacy 表被清理');
        assertEqual(String(migrated.game_name || ''), 'WZRY', 'migration 会规范化游戏名');
        assertEqual(String(migrated.game_id || ''), '1', 'migration 保留游戏 ID');
        assertEqual(String(migrated.order_status || ''), '租赁中', 'migration 会规范化订单状态');
        assertEqual(String(migrated.ren_way || ''), '时租', 'migration 会补默认租赁方式');
        assertTrue(indexRows.some((row) => String(row.name || '') === 'idx_order_user_account_start'), 'migration 会补充新索引');
    } finally {
        db2.close();
    }

    const applied = await listAppliedSchemaMigrations();
    assertEqual(applied.length, 1, 'schema_migration 记录一次已执行 migration');
    assertEqual(String(applied[0].version || ''), '20260411_001', '已执行 migration 版本正确');

    const summarySecond = await runPendingMigrations({ logger: console });
    assertEqual(summarySecond.pending_before, 0, '重复执行 migration 不应重复跑');
    assertEqual(summarySecond.applied.length, 0, '重复执行 migration 不应新增 applied 记录');

    console.log(`[SchemaMigrationSmoke] ok temp_dir=${tempDir}`);
}

main().catch((err) => {
    console.error(`[SchemaMigrationSmoke] failed: ${err.message}`);
    process.exit(1);
});
