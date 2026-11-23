'use strict';
const { promisify } = require('node:util');
const { openOrderDatabase } = require('./sqlite_client');

const SOURCE_GAME_FIELDS = ['source_game_id','source_game_name','source_game_logo'];
const SOURCE_GAME_COLUMNS = SOURCE_GAME_FIELDS.map(field => `${field} TEXT NOT NULL DEFAULT ''`);

async function withDb(action) {
    const db = openOrderDatabase();
    const call = method => promisify(db[method]).bind(db);
    try { return await action(call('run'), call('all'), call('get')); }
    finally { await call('close')(); }
}

let ready;
function initRentalDeviceOrderDb() {
    if (ready) return ready;
    ready = withDb(async run => {
        await run(`CREATE TABLE IF NOT EXISTS rental_device_order (
            id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, source TEXT NOT NULL DEFAULT 'uuzuhao_device',
            order_no TEXT NOT NULL, device_id TEXT NOT NULL, device_no TEXT NOT NULL, device_name TEXT NOT NULL,
            source_status INTEGER NOT NULL, order_status TEXT NOT NULL, order_type TEXT NOT NULL,
            placed_at TEXT NOT NULL, start_time TEXT NOT NULL, end_time TEXT NOT NULL, rent_hour REAL NOT NULL,
            receivable_cent INTEGER, settlement_cent INTEGER, refund_cent INTEGER, booked_cent INTEGER NOT NULL,
            ${SOURCE_GAME_COLUMNS.join(',')},
            create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            is_deleted INTEGER NOT NULL DEFAULT 0, desc TEXT NOT NULL DEFAULT '', UNIQUE(user_id,source,order_no)
        )`);
        await run('CREATE INDEX IF NOT EXISTS idx_rental_device_order_user_end ON rental_device_order(user_id,end_time)');
        await run(`CREATE TABLE IF NOT EXISTS rental_device_stats_dirty_day (
            id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, stat_date TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
            create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            is_deleted INTEGER NOT NULL DEFAULT 0, desc TEXT NOT NULL DEFAULT '', UNIQUE(user_id,stat_date)
        )`);
    }).catch(error => { ready = null; throw error; });
    return ready;
}

async function ensureRentalDeviceOrderGameColumns() {
    await initRentalDeviceOrderDb();
    return withDb(async (run,all) => {
        await run('BEGIN IMMEDIATE');
        try {
            const existing = new Set((await all('PRAGMA table_info(rental_device_order)')).map(r=>r.name));
            for (const [index,field] of SOURCE_GAME_FIELDS.entries()) {
                if (!existing.has(field)) await run(`ALTER TABLE rental_device_order ADD COLUMN ${SOURCE_GAME_COLUMNS[index]}`);
            }
            await run('COMMIT');
        } catch (err) { await run('ROLLBACK'); throw err; }
    });
}

const FACT_FIELDS = ['device_id','device_no','device_name','source_status','order_status','order_type',
    'placed_at','start_time','end_time','rent_hour','receivable_cent','settlement_cent','refund_cent','booked_cent'];
const FIELDS = [...FACT_FIELDS,...SOURCE_GAME_FIELDS];

function upsertRentalDeviceOrders(uid, orders) {
    return withDb(async (run, _, get) => {
        const dates = new Set();
        let changed = 0;
        await run('BEGIN IMMEDIATE');
        try {
            for (const order of orders) {
                const args = FIELDS.map(key => order[key]);
                const existing = await get('SELECT * FROM rental_device_order WHERE user_id=? AND source=? AND order_no=?',
                    [uid,'uuzuhao_device',order.order_no]);
                const sameFact = existing?.is_deleted === 0 && FACT_FIELDS.every(key => existing[key] === order[key]);
                if (sameFact && SOURCE_GAME_FIELDS.every(key => existing[key] === order[key])) continue;
                await run(`INSERT INTO rental_device_order(user_id,order_no,${FIELDS.join(',')})
                    VALUES(${args.map(() => '?').concat('?', '?').join(',')})
                    ON CONFLICT(user_id,source,order_no) DO UPDATE SET
                    ${FIELDS.map(key => key + '=excluded.' + key).join(',')}, is_deleted=0, modify_date=CURRENT_TIMESTAMP`,
                    [uid,order.order_no,...args]);
                changed++;
                if (!sameFact) {
                    for (const date of [existing?.end_time,order.end_time]) if (date) dates.add(date.slice(0,10));
                }
            }
            for (const date of dates) {
                await run(`INSERT INTO rental_device_stats_dirty_day(user_id,stat_date) VALUES(?,?)
                    ON CONFLICT(user_id,stat_date) DO UPDATE SET revision=revision+1,modify_date=CURRENT_TIMESTAMP`, [uid,date]);
            }
            await run('COMMIT');
            return changed;
        } catch (err) { await run('ROLLBACK'); throw err; }
    });
}

function listDirtyDeviceDates(uid, through) {
    return withDb((_, all) => all(`SELECT id,stat_date,revision FROM rental_device_stats_dirty_day
        WHERE user_id=? AND stat_date<=? ORDER BY stat_date`,[uid,through]));
}

function clearDirtyDeviceDates(uid, rows) {
    return withDb(async run => {
        for (const row of rows) {
            await run('DELETE FROM rental_device_stats_dirty_day WHERE user_id=? AND id=? AND revision=?',
                [uid,row.id,row.revision]);
        }
    });
}

function listDeviceOrderIdentities(uid) {
    return withDb((_, all) => all(`SELECT game_account,device_no,device_name
        FROM (SELECT CASE WHEN device_id='' THEN 'device:unlinked' ELSE 'device:'||device_id END AS game_account,
            device_no, device_name, ROW_NUMBER() OVER (PARTITION BY device_id ORDER BY placed_at DESC,id DESC) AS rn
            FROM rental_device_order WHERE user_id=? AND is_deleted=0) WHERE rn=1`,[uid]));
}

function readDailyDeviceOrderStats(uid, day) {
    return withDb((_, all) => all(`SELECT 'uuzuhao_device' AS channel, 'GTA6' AS game_name,
        CASE WHEN device_id='' THEN 'device:unlinked' ELSE 'device:'||device_id END AS game_account,
        MAX(device_name) AS role_name, COUNT(*) AS order_cnt_total,
        SUM(source_status=3000 OR booked_cent>0) AS order_cnt_effective,
        SUM(source_status=3000) AS order_cnt_progress, SUM(source_status=4000) AS order_cnt_done,
        SUM(CASE WHEN refund_cent>0 THEN 1 ELSE 0 END) AS order_cnt_refund,
        SUM(source_status IN (4200,9900)) AS order_cnt_cancel, SUM(booked_cent<=0) AS order_cnt_zero_rec,
        SUM(CASE WHEN source_status=3000 OR booked_cent>0 THEN rent_hour ELSE 0 END) AS rent_hour_sum,
        SUM(CASE WHEN source_status=3000 OR booked_cent>0 THEN COALESCE(receivable_cent,0) ELSE 0 END)/100.0 AS amount_order_sum,
        SUM(booked_cent)/100.0 AS amount_rec_sum, SUM(COALESCE(refund_cent,0))/100.0 AS amount_refund_sum
        FROM rental_device_order WHERE user_id=? AND is_deleted=0 AND end_time>=? AND end_time<? GROUP BY device_id`,
        [uid,day,day+'~']));
}

module.exports = { initRentalDeviceOrderDb, ensureRentalDeviceOrderGameColumns, upsertRentalDeviceOrders, listDirtyDeviceDates, clearDirtyDeviceDates,
    listDeviceOrderIdentities, readDailyDeviceOrderStats };
