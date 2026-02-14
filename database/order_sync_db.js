const { openDatabase } = require('./sqlite_client');

function nowText() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
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
            resolve(row);
        });
    });
}

async function initOrderSyncDb() {
    const db = openDatabase();
    try {
        await run(db, `
            ALTER TABLE user_order_sync_state RENAME TO order_sync_state
        `).catch(() => {});
        await run(db, `
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
        await run(db, `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_order_sync_state_alive
            ON order_sync_state(user_id, channel, is_deleted)
        `);
    } finally {
        db.close();
    }
}

async function getLastSyncTimestamp(userId, channel) {
    await initOrderSyncDb();
    const uid = Number(userId || 0);
    const ch = String(channel || '').trim().toLowerCase();
    if (!uid) throw new Error('user_id 不合法');
    if (!ch) throw new Error('channel 不能为空');

    const db = openDatabase();
    try {
        const row = await get(db, `
            SELECT last_sync_ts
            FROM order_sync_state
            WHERE user_id = ? AND channel = ? AND is_deleted = 0
            LIMIT 1
        `, [uid, ch]);
        return Number(row?.last_sync_ts || 0);
    } finally {
        db.close();
    }
}

async function setLastSyncTimestamp(userId, channel, ts, desc = '') {
    await initOrderSyncDb();
    const uid = Number(userId || 0);
    const ch = String(channel || '').trim().toLowerCase();
    const syncTs = Number(ts || 0);
    if (!uid) throw new Error('user_id 不合法');
    if (!ch) throw new Error('channel 不能为空');
    if (!Number.isFinite(syncTs) || syncTs <= 0) throw new Error('last_sync_ts 不合法');

    const db = openDatabase();
    try {
        const row = await get(db, `
            SELECT id
            FROM order_sync_state
            WHERE user_id = ? AND channel = ? AND is_deleted = 0
            LIMIT 1
        `, [uid, ch]);

        if (!row) {
            await run(db, `
                INSERT INTO order_sync_state
                (user_id, channel, last_sync_ts, modify_date, is_deleted, desc)
                VALUES (?, ?, ?, ?, 0, ?)
            `, [uid, ch, syncTs, nowText(), String(desc || '')]);
        } else {
            await run(db, `
                UPDATE order_sync_state
                SET last_sync_ts = ?, modify_date = ?, desc = ?
                WHERE id = ?
            `, [syncTs, nowText(), String(desc || ''), Number(row.id)]);
        }
    } finally {
        db.close();
    }
}

module.exports = {
    initOrderSyncDb,
    getLastSyncTimestamp,
    setLastSyncTimestamp
};
