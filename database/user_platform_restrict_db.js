const { openDatabase } = require('./sqlite_client');

const RESTRICT_REASON = '平台限制上架';

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

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

function normalizePlatform(v) {
    const p = String(v || '').trim().toLowerCase();
    if (p === 'uuzuhao' || p === 'uhaozu' || p === 'zuhaowang') return p;
    return '';
}

function normalizeDetail(v) {
    if (v === null || v === undefined || v === '') return {};
    if (typeof v === 'string') {
        try { return JSON.parse(v) || {}; } catch { return {}; }
    }
    if (typeof v === 'object' && !Array.isArray(v)) return v;
    return {};
}

async function initUserPlatformRestrictDb() {
    const db = openDatabase();
    try {
        await run(db, `
            CREATE TABLE IF NOT EXISTS user_platform_restrict (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                game_account TEXT NOT NULL DEFAULT '',
                platform TEXT NOT NULL DEFAULT '',
                reason TEXT NOT NULL DEFAULT '',
                detail TEXT NOT NULL DEFAULT '{}',
                create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        await run(db, `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_user_platform_restrict_alive
            ON user_platform_restrict(user_id, game_account, platform, is_deleted)
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_user_platform_restrict_user
            ON user_platform_restrict(user_id, is_deleted)
        `);
    } finally {
        db.close();
    }
}

async function upsertPlatformRestrict(userId, gameAccount, platform, detail = {}, desc = '') {
    await initUserPlatformRestrictDb();
    const uid = Number(userId || 0);
    const acc = String(gameAccount || '').trim();
    const pf = normalizePlatform(platform);
    if (!uid) throw new Error('user_id 不合法');
    if (!acc) throw new Error('game_account 不能为空');
    if (!pf) throw new Error('platform 不合法');

    const db = openDatabase();
    try {
        const now = nowText();
        const exists = await get(db, `
            SELECT id
            FROM user_platform_restrict
            WHERE user_id = ? AND game_account = ? AND platform = ? AND is_deleted = 0
            LIMIT 1
        `, [uid, acc, pf]);
        const payload = JSON.stringify(normalizeDetail(detail));
        if (!exists) {
            await run(db, `
                INSERT INTO user_platform_restrict
                (user_id, game_account, platform, reason, detail, create_date, modify_date, is_deleted, desc)
                VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
            `, [uid, acc, pf, RESTRICT_REASON, payload, now, now, String(desc || '').trim()]);
        } else {
            await run(db, `
                UPDATE user_platform_restrict
                SET reason = ?, detail = ?, modify_date = ?, desc = ?
                WHERE id = ?
            `, [RESTRICT_REASON, payload, now, String(desc || '').trim(), Number(exists.id)]);
        }
        return true;
    } finally {
        db.close();
    }
}

async function removePlatformRestrict(userId, gameAccount, platform, desc = '') {
    await initUserPlatformRestrictDb();
    const uid = Number(userId || 0);
    const acc = String(gameAccount || '').trim();
    const pf = normalizePlatform(platform);
    if (!uid || !acc || !pf) return false;

    const db = openDatabase();
    try {
        const r = await run(db, `
            UPDATE user_platform_restrict
            SET is_deleted = 1, modify_date = ?, desc = ?
            WHERE user_id = ? AND game_account = ? AND platform = ? AND is_deleted = 0
        `, [nowText(), String(desc || '').trim(), uid, acc, pf]);
        return Number(r.changes || 0) > 0;
    } finally {
        db.close();
    }
}

async function listPlatformRestrictByUserAndAccounts(userId, gameAccounts = []) {
    await initUserPlatformRestrictDb();
    const uid = Number(userId || 0);
    if (!uid) return [];
    const accs = [...new Set((Array.isArray(gameAccounts) ? gameAccounts : [])
        .map((x) => String(x || '').trim())
        .filter(Boolean))];
    if (accs.length === 0) return [];

    const db = openDatabase();
    try {
        const placeholders = accs.map(() => '?').join(',');
        const rows = await all(db, `
            SELECT user_id, game_account, platform, reason, detail, create_date, modify_date, desc
            FROM user_platform_restrict
            WHERE user_id = ? AND is_deleted = 0 AND game_account IN (${placeholders})
            ORDER BY id ASC
        `, [uid, ...accs]);
        return rows.map((r) => ({
            user_id: Number(r.user_id || 0),
            game_account: String(r.game_account || '').trim(),
            platform: normalizePlatform(r.platform),
            reason: String(r.reason || '').trim(),
            detail: normalizeDetail(r.detail),
            create_date: String(r.create_date || '').trim(),
            modify_date: String(r.modify_date || '').trim(),
            desc: String(r.desc || '').trim()
        })).filter((r) => r.game_account && r.platform);
    } finally {
        db.close();
    }
}

module.exports = {
    RESTRICT_REASON,
    initUserPlatformRestrictDb,
    upsertPlatformRestrict,
    removePlatformRestrict,
    listPlatformRestrictByUserAndAccounts
};
