#!/usr/bin/env node
'use strict';

const fs = require('fs');
const {
    MAIN_DB_FILE,
    RUNTIME_DB_FILE,
    openMainDatabase,
    openRuntimeDatabase
} = require('../database/sqlite_client');
const { initLockDb } = require('../database/lock_db');
const { initOrderSyncDb } = require('../database/order_sync_db');
const { initOrderStatsJobStateDb } = require('../database/order_stats_job_state_db');
const { initUserSessionDb } = require('../database/user_session_db');

const TABLES = [
    { table_name: 'lock_db', order_by: 'id ASC' },
    { table_name: 'order_sync_state', order_by: 'id ASC' },
    { table_name: 'order_stats_job_state', order_by: 'id ASC' },
    { table_name: 'user_session', order_by: 'id ASC' }
];

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i += 1) {
        const cur = argv[i];
        if (!cur.startsWith('--')) continue;
        const key = cur.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('--')) {
            out[key] = next;
            i += 1;
        } else {
            out[key] = 'true';
        }
    }
    return out;
}

function toBool(v, fallback = false) {
    if (v === undefined) return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase());
}

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

async function tableExists(db, tableName) {
    const row = await get(db, `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = ?
        LIMIT 1
    `, [tableName]);
    return Boolean(row && row.name);
}

async function countRows(db, tableName) {
    const row = await get(db, `SELECT COUNT(*) AS total FROM ${tableName}`);
    return Number((row && row.total) || 0);
}

async function loadColumns(db, tableName) {
    const rows = await all(db, `PRAGMA table_info(${tableName})`);
    return rows.map((row) => String(row.name || '').trim()).filter(Boolean);
}

async function copyTable(sourceDb, targetDb, tableName, orderBy) {
    const columns = await loadColumns(targetDb, tableName);
    if (columns.length === 0) throw new Error(`目标表缺少列: ${tableName}`);

    const sourceCount = await countRows(sourceDb, tableName);
    await run(targetDb, `DELETE FROM ${tableName}`);
    if (sourceCount === 0) {
        return { source_count: 0, target_count: 0 };
    }

    const rows = await all(sourceDb, `SELECT ${columns.join(', ')} FROM ${tableName} ORDER BY ${orderBy}`);
    const placeholders = columns.map(() => '?').join(', ');
    const insertSql = `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES (${placeholders})`;
    await run(targetDb, 'BEGIN IMMEDIATE TRANSACTION');
    try {
        for (const row of rows) {
            await run(targetDb, insertSql, columns.map((column) => row[column]));
        }
        await run(targetDb, 'COMMIT');
    } catch (err) {
        try { await run(targetDb, 'ROLLBACK'); } catch (_) {}
        throw err;
    }
    return {
        source_count: sourceCount,
        target_count: await countRows(targetDb, tableName)
    };
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const initOnly = toBool(args.init_only, false);
    const copyLocks = toBool(args.copy_locks, false);

    await initLockDb();
    await initOrderSyncDb();
    await initOrderStatsJobStateDb();
    await initUserSessionDb();

    if (initOnly) {
        console.log(`[RuntimeMigrate] init_only=true runtime_db=${RUNTIME_DB_FILE}`);
        return;
    }
    if (!fs.existsSync(MAIN_DB_FILE)) {
        throw new Error(`主库不存在: ${MAIN_DB_FILE}`);
    }

    const sourceDb = openMainDatabase();
    const targetDb = openRuntimeDatabase();
    try {
        console.log(`[RuntimeMigrate] main_db=${MAIN_DB_FILE}`);
        console.log(`[RuntimeMigrate] runtime_db=${RUNTIME_DB_FILE}`);
        console.log(`[RuntimeMigrate] copy_locks=${copyLocks}`);

        for (const item of TABLES) {
            if (!await tableExists(sourceDb, item.table_name)) {
                console.log(`[RuntimeMigrate] table=${item.table_name} skipped source_missing=true`);
                continue;
            }
            if (item.table_name === 'lock_db' && !copyLocks) {
                await run(targetDb, 'DELETE FROM lock_db');
                console.log(`[RuntimeMigrate] table=lock_db copied=false source=${await countRows(sourceDb, 'lock_db')} target=0`);
                continue;
            }
            const summary = await copyTable(sourceDb, targetDb, item.table_name, item.order_by);
            console.log(`[RuntimeMigrate] table=${item.table_name} copied=true source=${summary.source_count} target=${summary.target_count}`);
        }
    } finally {
        sourceDb.close();
        targetDb.close();
    }
}

main().catch((err) => {
    console.error(`[RuntimeMigrate] failed: ${err.message}`);
    process.exit(1);
});
