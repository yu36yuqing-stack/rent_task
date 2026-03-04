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

async function inTx(db, fn) {
    await run(db, 'BEGIN');
    try {
        const out = await fn();
        await run(db, 'COMMIT');
        return out;
    } catch (e) {
        try { await run(db, 'ROLLBACK'); } catch (_) {}
        throw e;
    }
}

function normalizeSource(input) {
    return String(input || '').trim().toLowerCase();
}

function normalizeGameAccount(input) {
    return String(input || '').trim();
}

function toBoolInt(v, fallback = 0) {
    if (v === undefined || v === null || v === '') return Number(fallback) ? 1 : 0;
    return Boolean(v) ? 1 : 0;
}

function safeJson(input, fallback = {}) {
    if (input === undefined || input === null || input === '') return JSON.stringify(fallback || {});
    if (typeof input === 'string') {
        const text = input.trim();
        if (!text) return JSON.stringify(fallback || {});
        try {
            const obj = JSON.parse(text);
            return JSON.stringify(obj && typeof obj === 'object' ? obj : fallback || {});
        } catch {
            return JSON.stringify(fallback || {});
        }
    }
    if (typeof input === 'object') return JSON.stringify(input || fallback || {});
    return JSON.stringify(fallback || {});
}

function rowToSource(row = {}) {
    let detail = {};
    try { detail = JSON.parse(String(row.detail || '{}')) || {}; } catch { detail = {}; }
    return {
        id: Number(row.id || 0),
        user_id: Number(row.user_id || 0),
        game_account: normalizeGameAccount(row.game_account),
        source: normalizeSource(row.source),
        active: Number(row.active || 0) > 0,
        reason: String(row.reason || '').trim(),
        priority: Number(row.priority || 0),
        detail,
        expire_at: String(row.expire_at || '').trim(),
        create_date: String(row.create_date || '').trim(),
        modify_date: String(row.modify_date || '').trim(),
        is_deleted: Number(row.is_deleted || 0),
        desc: String(row.desc || '').trim()
    };
}

async function initUserBlacklistSourceDb() {
    const db = openDatabase();
    try {
        await run(db, `
            CREATE TABLE IF NOT EXISTS user_blacklist_source (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                game_account TEXT NOT NULL,
                source TEXT NOT NULL,
                active INTEGER NOT NULL DEFAULT 0,
                reason TEXT NOT NULL DEFAULT '',
                priority INTEGER NOT NULL DEFAULT 0,
                detail TEXT NOT NULL DEFAULT '{}',
                expire_at TEXT NOT NULL DEFAULT '',
                create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        await run(db, `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_user_blacklist_source_alive
            ON user_blacklist_source(user_id, game_account, source, is_deleted)
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_user_blacklist_source_user_alive
            ON user_blacklist_source(user_id, active, modify_date, is_deleted)
        `);
    } finally {
        db.close();
    }
}

async function upsertBlacklistSource(userId, gameAccount, source, patch = {}, opts = {}) {
    await initUserBlacklistSourceDb();
    const uid = Number(userId || 0);
    const acc = normalizeGameAccount(gameAccount);
    const src = normalizeSource(source);
    if (!uid) throw new Error('user_id 非法');
    if (!acc) throw new Error('game_account 不能为空');
    if (!src) throw new Error('source 不能为空');

    const active = toBoolInt(patch.active, 0);
    const reason = String(patch.reason || '').trim();
    const priority = Number.isFinite(Number(patch.priority)) ? Number(patch.priority) : 0;
    const detail = safeJson(patch.detail, {});
    const expireAt = String(patch.expire_at || '').trim();
    const desc = String(opts.desc || '').trim();

    const db = openDatabase();
    try {
        return await inTx(db, async () => {
            const now = nowText();
            const oldRow = await get(db, `
                SELECT *
                FROM user_blacklist_source
                WHERE user_id = ? AND game_account = ? AND source = ? AND is_deleted = 0
                LIMIT 1
            `, [uid, acc, src]);

            if (!oldRow) {
                await run(db, `
                    INSERT INTO user_blacklist_source
                    (user_id, game_account, source, active, reason, priority, detail, expire_at, create_date, modify_date, is_deleted, desc)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
                `, [uid, acc, src, active, reason, priority, detail, expireAt, now, now, desc]);
            } else {
                await run(db, `
                    UPDATE user_blacklist_source
                    SET active = ?, reason = ?, priority = ?, detail = ?, expire_at = ?, modify_date = ?, desc = ?, is_deleted = 0
                    WHERE id = ?
                `, [active, reason, priority, detail, expireAt, now, desc, Number(oldRow.id)]);
            }

            const latest = await get(db, `
                SELECT *
                FROM user_blacklist_source
                WHERE user_id = ? AND game_account = ? AND source = ? AND is_deleted = 0
                LIMIT 1
            `, [uid, acc, src]);
            return rowToSource(latest || {});
        });
    } finally {
        db.close();
    }
}

async function listBlacklistSourcesByUser(userId, options = {}) {
    await initUserBlacklistSourceDb();
    const uid = Number(userId || 0);
    if (!uid) return [];
    const activeOnly = options.active_only === undefined ? false : Boolean(options.active_only);

    const db = openDatabase();
    try {
        const rows = await all(db, `
            SELECT *
            FROM user_blacklist_source
            WHERE user_id = ?
              AND is_deleted = 0
              ${activeOnly ? 'AND active = 1' : ''}
            ORDER BY game_account ASC, priority DESC, source ASC
        `, [uid]);
        return rows.map(rowToSource);
    } finally {
        db.close();
    }
}

async function listBlacklistSourcesByUserAndAccounts(userId, accounts = [], options = {}) {
    await initUserBlacklistSourceDb();
    const uid = Number(userId || 0);
    const uniq = Array.from(new Set((Array.isArray(accounts) ? accounts : [])
        .map((x) => normalizeGameAccount(x))
        .filter(Boolean)));
    if (!uid || uniq.length === 0) return [];
    const activeOnly = options.active_only === undefined ? false : Boolean(options.active_only);

    const placeholders = uniq.map(() => '?').join(',');
    const db = openDatabase();
    try {
        const rows = await all(db, `
            SELECT *
            FROM user_blacklist_source
            WHERE user_id = ?
              AND is_deleted = 0
              ${activeOnly ? 'AND active = 1' : ''}
              AND game_account IN (${placeholders})
            ORDER BY game_account ASC, priority DESC, source ASC
        `, [uid, ...uniq]);
        return rows.map(rowToSource);
    } finally {
        db.close();
    }
}

async function listActiveBlacklistSourcesByUser(userId) {
    return listBlacklistSourcesByUser(userId, { active_only: true });
}

async function softDeleteBlacklistSource(userId, gameAccount, source, opts = {}) {
    await initUserBlacklistSourceDb();
    const uid = Number(userId || 0);
    const acc = normalizeGameAccount(gameAccount);
    const src = normalizeSource(source);
    if (!uid || !acc || !src) return false;
    const now = nowText();
    const desc = String(opts.desc || '').trim();

    const db = openDatabase();
    try {
        const r = await run(db, `
            UPDATE user_blacklist_source
            SET is_deleted = 1, modify_date = ?, desc = ?
            WHERE user_id = ? AND game_account = ? AND source = ? AND is_deleted = 0
        `, [now, desc, uid, acc, src]);
        return Number(r.changes || 0) > 0;
    } finally {
        db.close();
    }
}

module.exports = {
    initUserBlacklistSourceDb,
    upsertBlacklistSource,
    listBlacklistSourcesByUser,
    listBlacklistSourcesByUserAndAccounts,
    listActiveBlacklistSourcesByUser,
    softDeleteBlacklistSource
};
