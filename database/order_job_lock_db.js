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
            resolve(row || null);
        });
    });
}

async function initOrderJobLockDb() {
    const db = openDatabase();
    try {
        await run(db, `
            CREATE TABLE IF NOT EXISTS order_job_lock (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                lock_key TEXT NOT NULL,
                lease_until INTEGER NOT NULL DEFAULT 0,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        await run(db, `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_order_job_lock_alive
            ON order_job_lock(lock_key, is_deleted)
        `);
    } finally {
        db.close();
    }
}

async function tryAcquireOrderJobLock(lockKey, leaseSec = 1800, owner = '') {
    await initOrderJobLockDb();
    const key = String(lockKey || '').trim();
    const lease = Math.max(60, Number(leaseSec || 1800));
    const nowSec = Math.floor(Date.now() / 1000);
    const untilSec = nowSec + lease;
    if (!key) throw new Error('lock_key 不能为空');

    const db = openDatabase();
    try {
        await run(db, 'BEGIN IMMEDIATE TRANSACTION');
        const row = await get(db, `
            SELECT id, lease_until
            FROM order_job_lock
            WHERE lock_key = ? AND is_deleted = 0
            LIMIT 1
        `, [key]);

        if (!row) {
            await run(db, `
                INSERT INTO order_job_lock (lock_key, lease_until, modify_date, is_deleted, desc)
                VALUES (?, ?, ?, 0, ?)
            `, [key, untilSec, nowText(), owner]);
            await run(db, 'COMMIT');
            return { acquired: true, lock_key: key, lease_until: untilSec };
        }

        const currentLease = Number(row.lease_until || 0);
        if (currentLease > nowSec) {
            await run(db, 'COMMIT');
            return { acquired: false, lock_key: key, lease_until: currentLease };
        }

        await run(db, `
            UPDATE order_job_lock
            SET lease_until = ?, modify_date = ?, desc = ?
            WHERE id = ?
        `, [untilSec, nowText(), owner, Number(row.id)]);
        await run(db, 'COMMIT');
        return { acquired: true, lock_key: key, lease_until: untilSec };
    } catch (e) {
        try { await run(db, 'ROLLBACK'); } catch (_) {}
        throw e;
    } finally {
        db.close();
    }
}

async function releaseOrderJobLock(lockKey, owner = '') {
    await initOrderJobLockDb();
    const key = String(lockKey || '').trim();
    if (!key) return false;

    const db = openDatabase();
    try {
        const r = await run(db, `
            UPDATE order_job_lock
            SET lease_until = 0, modify_date = ?, desc = ?
            WHERE lock_key = ? AND is_deleted = 0
        `, [nowText(), owner, key]);
        return Number(r.changes || 0) > 0;
    } finally {
        db.close();
    }
}

module.exports = {
    initOrderJobLockDb,
    tryAcquireOrderJobLock,
    releaseOrderJobLock
};
