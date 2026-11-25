'use strict';

const { promisify } = require('node:util');
const { openStatsDatabase } = require('./sqlite_client');

async function withDb(action) {
    const db = openStatsDatabase();
    const call = (method) => promisify(db[method]).bind(db);
    try { return await action(call('run'), call('all')); }
    finally { await call('close')(); }
}

function initRentalDeviceDb() {
    return withDb(run => run(`CREATE TABLE IF NOT EXISTS rental_device (
        id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, platform TEXT NOT NULL DEFAULT 'uuzuhao',
        device_id TEXT NOT NULL, device_no TEXT NOT NULL, device_name TEXT NOT NULL, model_name TEXT NOT NULL,
        hour_price TEXT, max_hours INTEGER, status INTEGER, status_desc TEXT NOT NULL,
        create_date TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        modify_date TEXT NOT NULL DEFAULT (datetime('now','localtime')), is_deleted INTEGER NOT NULL DEFAULT 0,
        desc TEXT NOT NULL DEFAULT '', UNIQUE(user_id,platform,device_id)
    )`));
}

function replaceDeviceSnapshot(uid, devices) {
    return withDb(async run => {
        await run('BEGIN IMMEDIATE');
        try {
            await run("UPDATE rental_device SET is_deleted=1 WHERE user_id=? AND platform='uuzuhao' AND is_deleted=0", [uid]);
            for (const d of devices) {
                await run(`INSERT INTO rental_device
                    (user_id,device_id,device_no,device_name,model_name,hour_price,max_hours,status,status_desc)
                    VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,platform,device_id) DO UPDATE SET
                    device_no=excluded.device_no,device_name=excluded.device_name,model_name=excluded.model_name,
                    hour_price=excluded.hour_price,max_hours=excluded.max_hours,status=excluded.status,
                    status_desc=excluded.status_desc,modify_date=datetime('now','localtime'),is_deleted=0`,
                [uid, d.deviceId, d.deviceNo || '', d.deviceName || '', d.deviceModelName || '',
                    d.supplyHourPrice ?? null, d.maxRentHours ?? null, d.status ?? null, d.statusDesc || '']);
            }
            await run('COMMIT');
        } catch (e) { await run('ROLLBACK'); throw e; }
    });
}

function listDeviceCards(uid, identity, { includeInactive = false } = {}) {
    return withDb((_, all) => all(`SELECT d.id, 'device' AS product_kind, 'GTA6' AS game_id, 'GTA6' AS game_name,
        'device:' || d.device_id AS game_account, coalesce(nullif(d.device_name,''),nullif(d.device_no,''),d.device_id) AS role_name,
        d.device_name,d.device_no,d.model_name,d.hour_price,d.max_hours,d.status,d.status_desc,d.modify_date AS synced_at,d.is_deleted AS inactive,
        coalesce(sum(c.cost_amount),0) AS total_cost_amount,
        max(CASE WHEN c.cost_type='purchase' THEN c.cost_amount END) AS purchase_price,
        max(CASE WHEN c.cost_type='purchase' THEN c.cost_date END) AS purchase_date
        FROM rental_device d LEFT JOIN account_cost_record c ON c.user_id=d.user_id AND c.game_id='GTA6'
            AND c.game_account='device:' || d.device_id AND c.is_deleted=0
        WHERE d.user_id=? AND d.platform='uuzuhao' ${includeInactive ? '' : 'AND d.is_deleted=0'}
        ${identity === undefined ? '' : "AND 'device:' || d.device_id=?"}
        GROUP BY d.id ORDER BY length(d.device_id) DESC,d.device_id DESC`, identity === undefined ? [uid] : [uid, identity]));
}

module.exports = { initRentalDeviceDb, replaceDeviceSnapshot, listDeviceCards };
