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

async function initOrderStatsJobStateDb() {
    const db = openDatabase();
    try {
        await run(db, `
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
        await run(db, `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_order_stats_job_state_alive
            ON order_stats_job_state(job_key, is_deleted)
        `);
    } finally {
        db.close();
    }
}

async function getLastRunDate(jobKey) {
    await initOrderStatsJobStateDb();
    const key = String(jobKey || '').trim();
    if (!key) throw new Error('job_key 不能为空');

    const db = openDatabase();
    try {
        const row = await get(db, `
            SELECT last_run_date
            FROM order_stats_job_state
            WHERE job_key = ? AND is_deleted = 0
            LIMIT 1
        `, [key]);
        return String((row && row.last_run_date) || '').slice(0, 10);
    } finally {
        db.close();
    }
}

async function setLastRunDate(jobKey, dateText, desc = '') {
    await initOrderStatsJobStateDb();
    const key = String(jobKey || '').trim();
    const day = String(dateText || '').slice(0, 10);
    if (!key) throw new Error('job_key 不能为空');
    if (!day) throw new Error('dateText 不能为空');

    const db = openDatabase();
    try {
        const row = await get(db, `
            SELECT id
            FROM order_stats_job_state
            WHERE job_key = ? AND is_deleted = 0
            LIMIT 1
        `, [key]);
        if (!row) {
            await run(db, `
                INSERT INTO order_stats_job_state
                (job_key, last_run_date, create_date, modify_date, is_deleted, desc)
                VALUES (?, ?, ?, ?, 0, ?)
            `, [key, day, nowText(), nowText(), String(desc || '')]);
        } else {
            await run(db, `
                UPDATE order_stats_job_state
                SET last_run_date = ?, modify_date = ?, desc = ?
                WHERE id = ?
            `, [day, nowText(), String(desc || ''), Number(row.id)]);
        }
    } finally {
        db.close();
    }
}

module.exports = {
    initOrderStatsJobStateDb,
    getLastRunDate,
    setLastRunDate
};
