'use strict';

const { openPriceDatabase } = require('./sqlite_client');

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

async function initPriceLadderJobStateDb() {
    const db = openPriceDatabase();
    try {
        await run(db, `
            CREATE TABLE IF NOT EXISTS price_ladder_job_state (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                job_key TEXT NOT NULL,
                last_business_date TEXT NOT NULL DEFAULT '',
                create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        await run(db, `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_price_ladder_job_state_alive
            ON price_ladder_job_state(user_id, job_key, is_deleted)
        `);
    } finally {
        db.close();
    }
}

async function getPriceLadderJobBusinessDate(userId, jobKey) {
    await initPriceLadderJobStateDb();
    const uid = Number(userId || 0);
    const key = String(jobKey || '').trim();
    if (!uid || !key) return '';
    const db = openPriceDatabase();
    try {
        const row = await get(db, `
            SELECT last_business_date
            FROM price_ladder_job_state
            WHERE user_id = ? AND job_key = ? AND is_deleted = 0
            LIMIT 1
        `, [uid, key]);
        return String(row && row.last_business_date || '').slice(0, 10);
    } finally {
        db.close();
    }
}

async function setPriceLadderJobBusinessDate(userId, jobKey, businessDate, desc = '') {
    await initPriceLadderJobStateDb();
    const uid = Number(userId || 0);
    const key = String(jobKey || '').trim();
    const day = String(businessDate || '').slice(0, 10);
    if (!uid) throw new Error('user_id 不合法');
    if (!key || !day) throw new Error('阶梯任务状态参数不完整');
    const db = openPriceDatabase();
    try {
        const row = await get(db, `
            SELECT id
            FROM price_ladder_job_state
            WHERE user_id = ? AND job_key = ? AND is_deleted = 0
            LIMIT 1
        `, [uid, key]);
        const now = nowText();
        if (!row) {
            await run(db, `
                INSERT INTO price_ladder_job_state
                (user_id, job_key, last_business_date, create_date, modify_date, is_deleted, desc)
                VALUES (?, ?, ?, ?, ?, 0, ?)
            `, [uid, key, day, now, now, String(desc || '').trim()]);
        } else {
            await run(db, `
                UPDATE price_ladder_job_state
                SET last_business_date = ?, modify_date = ?, desc = ?
                WHERE id = ?
            `, [day, now, String(desc || '').trim(), Number(row.id)]);
        }
    } finally {
        db.close();
    }
}

module.exports = {
    initPriceLadderJobStateDb,
    getPriceLadderJobBusinessDate,
    setPriceLadderJobBusinessDate,
    _internal: { nowText, run, get }
};
