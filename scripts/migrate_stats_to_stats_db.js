#!/usr/bin/env node
const { openMainDatabase, openStatsDatabase, MAIN_DB_FILE, STATS_DB_FILE } = require('../database/sqlite_client');
const { initOrderStatsDailyDb } = require('../database/order_stats_daily_db');
const { initOrderStatsCostDailyDb } = require('../database/order_stats_cost_daily_db');

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
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

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
}

async function tableExists(db, tableName) {
    const row = await get(db, `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = ?
        LIMIT 1
    `, [String(tableName || '').trim()]);
    return Boolean(row && row.name);
}

async function migrateTable(mainDb, statsDb, tableName, columns = []) {
    const exists = await tableExists(mainDb, tableName);
    if (!exists) {
        return { table: tableName, copied: 0, skipped: true };
    }
    const cols = columns.join(', ');
    const placeholders = columns.map(() => '?').join(', ');
    const rows = await all(mainDb, `SELECT ${cols} FROM ${tableName} ORDER BY id ASC`);
    await run(statsDb, 'BEGIN IMMEDIATE');
    try {
        await run(statsDb, `DELETE FROM ${tableName}`);
        for (const row of rows) {
            await run(statsDb, `
                INSERT INTO ${tableName} (${cols})
                VALUES (${placeholders})
            `, columns.map((col) => row[col]));
        }
        await run(statsDb, 'COMMIT');
    } catch (e) {
        try { await run(statsDb, 'ROLLBACK'); } catch (_) {}
        throw e;
    }
    return { table: tableName, copied: rows.length, skipped: false };
}

async function main() {
    await initOrderStatsDailyDb();
    await initOrderStatsCostDailyDb();

    const mainDb = openMainDatabase();
    const statsDb = openStatsDatabase();
    try {
        const daily = await migrateTable(mainDb, statsDb, 'order_stats_daily', [
            'id',
            'stat_date',
            'user_id',
            'game_name',
            'channel',
            'game_account',
            'role_name',
            'purchase_price',
            'purchase_date',
            'order_cnt_total',
            'order_cnt_effective',
            'order_cnt_progress',
            'order_cnt_done',
            'order_cnt_refund',
            'order_cnt_cancel',
            'order_cnt_zero_rec',
            'rent_hour_sum',
            'amount_order_sum',
            'amount_rec_sum',
            'amount_refund_sum',
            'create_date',
            'modify_date',
            'is_deleted',
            'desc'
        ]);
        const cost = await migrateTable(mainDb, statsDb, 'order_stats_cost_daily', [
            'id',
            'stat_date',
            'user_id',
            'game_name',
            'cost_base',
            'account_count',
            'create_date',
            'modify_date',
            'is_deleted',
            'desc'
        ]);
        console.log(JSON.stringify({
            ok: true,
            main_db: MAIN_DB_FILE,
            stats_db: STATS_DB_FILE,
            results: [daily, cost]
        }, null, 2));
    } finally {
        mainDb.close();
        statsDb.close();
    }
}

main().catch((err) => {
    console.error('[migrate_stats_to_stats_db] failed:', err && err.stack ? err.stack : err);
    process.exit(1);
});
