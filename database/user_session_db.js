const crypto = require('crypto');
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

async function initUserSessionDb() {
    const db = openDatabase();
    try {
        await run(db, `
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
        await run(db, `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_user_session_token_alive
            ON user_session(refresh_token_hash, is_deleted)
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_user_session_user_alive
            ON user_session(user_id, is_deleted)
        `);
    } finally {
        db.close();
    }
}

function tokenHash(token) {
    return crypto.createHash('sha256').update(String(token || ''), 'utf8').digest('hex');
}

function isExpired(expireAt) {
    const ts = Date.parse(String(expireAt || ''));
    if (Number.isNaN(ts)) return false;
    return ts <= Date.now();
}

async function createRefreshSession(userId, refreshToken, ttlSec, desc = '') {
    await initUserSessionDb();
    const uid = Number(userId);
    if (!uid) throw new Error('user_id 不合法');
    const expireAt = new Date(Date.now() + Number(ttlSec || 0) * 1000).toISOString();
    const hash = tokenHash(refreshToken);

    const db = openDatabase();
    try {
        await run(db, `
            INSERT INTO user_session
            (user_id, refresh_token_hash, expire_at, modify_date, is_deleted, desc)
            VALUES (?, ?, ?, ?, 0, ?)
        `, [uid, hash, expireAt, nowText(), String(desc || '')]);
    } finally {
        db.close();
    }
}

async function verifyRefreshSession(refreshToken) {
    await initUserSessionDb();
    const hash = tokenHash(refreshToken);
    const db = openDatabase();
    try {
        const row = await get(db, `
            SELECT * FROM user_session
            WHERE refresh_token_hash = ? AND is_deleted = 0
            ORDER BY id DESC
            LIMIT 1
        `, [hash]);
        if (!row) return { ok: false, user_id: 0, reason: 'refresh_token 不存在' };
        if (isExpired(row.expire_at)) return { ok: false, user_id: Number(row.user_id || 0), reason: 'refresh_token 已过期' };
        return { ok: true, user_id: Number(row.user_id || 0), reason: '' };
    } finally {
        db.close();
    }
}

async function revokeRefreshSession(refreshToken) {
    await initUserSessionDb();
    const hash = tokenHash(refreshToken);
    const db = openDatabase();
    try {
        const r = await run(db, `
            UPDATE user_session
            SET is_deleted = 1, modify_date = ?
            WHERE refresh_token_hash = ? AND is_deleted = 0
        `, [nowText(), hash]);
        return Number(r.changes || 0) > 0;
    } finally {
        db.close();
    }
}

module.exports = {
    initUserSessionDb,
    createRefreshSession,
    verifyRefreshSession,
    revokeRefreshSession
};
