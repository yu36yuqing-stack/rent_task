const { openDatabase } = require('./sqlite_client');
const { normalizeGameProfile } = require('../common/game_profile');

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

function normalizeRestrictKey(input, fallback = {}) {
    if (input && typeof input === 'object' && !Array.isArray(input)) {
        const normalizedGame = normalizeGameProfile(
            input.game_id === undefined ? fallback.game_id : input.game_id,
            input.game_name === undefined ? fallback.game_name : input.game_name,
            { preserveUnknown: true }
        );
        return {
            game_account: String(input.game_account || input.account || '').trim(),
            game_id: String(normalizedGame.game_id || '1').trim() || '1',
            game_name: String(normalizedGame.game_name || 'WZRY').trim() || 'WZRY'
        };
    }
    const normalizedGame = normalizeGameProfile(fallback.game_id, fallback.game_name, { preserveUnknown: true });
    return {
        game_account: String(input || '').trim(),
        game_id: String(normalizedGame.game_id || '1').trim() || '1',
        game_name: String(normalizedGame.game_name || 'WZRY').trim() || 'WZRY'
    };
}

function isActiveRestrictUniqueConstraintError(err) {
    const msg = String(err && err.message ? err.message : err || '');
    return /UNIQUE constraint failed:\s*user_platform_restrict\.user_id,\s*user_platform_restrict\.game_id,\s*user_platform_restrict\.game_account,\s*user_platform_restrict\.platform/i.test(msg);
}

async function initUserPlatformRestrictDb() {
    const db = openDatabase();
    try {
        await run(db, `
            CREATE TABLE IF NOT EXISTS user_platform_restrict (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                game_account TEXT NOT NULL DEFAULT '',
                game_id TEXT NOT NULL DEFAULT '1',
                game_name TEXT NOT NULL DEFAULT 'WZRY',
                platform TEXT NOT NULL DEFAULT '',
                reason TEXT NOT NULL DEFAULT '',
                detail TEXT NOT NULL DEFAULT '{}',
                create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        const cols = await all(db, `PRAGMA table_info("user_platform_restrict")`);
        const hasGameId = cols.some((x) => String(x.name || '').trim() === 'game_id');
        const hasGameName = cols.some((x) => String(x.name || '').trim() === 'game_name');
        if (!hasGameId) await run(db, `ALTER TABLE user_platform_restrict ADD COLUMN game_id TEXT NOT NULL DEFAULT '1'`);
        if (!hasGameName) await run(db, `ALTER TABLE user_platform_restrict ADD COLUMN game_name TEXT NOT NULL DEFAULT 'WZRY'`);
        await run(db, `
            UPDATE user_platform_restrict
            SET game_id = (
                SELECT COALESCE(MAX(uga.game_id), '1')
                FROM user_game_account uga
                WHERE uga.user_id = user_platform_restrict.user_id
                  AND uga.game_account = user_platform_restrict.game_account
                  AND uga.is_deleted = 0
            )
            WHERE TRIM(COALESCE(game_id, '')) = ''
               OR game_id = '1'
        `);
        await run(db, `
            UPDATE user_platform_restrict
            SET game_name = COALESCE((
                SELECT uga.game_name
                FROM user_game_account uga
                WHERE uga.user_id = user_platform_restrict.user_id
                  AND uga.game_account = user_platform_restrict.game_account
                  AND uga.game_id = user_platform_restrict.game_id
                  AND uga.is_deleted = 0
                ORDER BY uga.id DESC
                LIMIT 1
            ), game_name, 'WZRY')
            WHERE TRIM(COALESCE(game_name, '')) = ''
               OR game_name = 'WZRY'
        `);
        // 迁移说明：
        // 历史索引把 is_deleted 也纳入唯一约束，会导致 active -> deleted 逻辑删除时
        // 与既有 deleted 行冲突（UNIQUE constraint failed）。
        // 这里改为“仅 active 行唯一”的部分索引，允许保留多条历史 deleted 记录。
        await run(db, `DROP INDEX IF EXISTS uq_user_platform_restrict_alive`);
        await run(db, `DROP INDEX IF EXISTS uq_user_platform_restrict_active`);
        await run(db, `DROP INDEX IF EXISTS idx_user_platform_restrict_user`);
        await run(db, `
            CREATE UNIQUE INDEX uq_user_platform_restrict_active
            ON user_platform_restrict(user_id, game_id, game_account, platform)
            WHERE is_deleted = 0
        `);
        await run(db, `
            CREATE INDEX idx_user_platform_restrict_user
            ON user_platform_restrict(user_id, game_id, is_deleted)
        `);
    } finally {
        db.close();
    }
}

async function upsertPlatformRestrict(userId, gameAccount, platform, detail = {}, desc = '') {
    await initUserPlatformRestrictDb();
    const uid = Number(userId || 0);
    const key = normalizeRestrictKey(gameAccount);
    const acc = key.game_account;
    const gid = key.game_id;
    const gameName = key.game_name;
    const pf = normalizePlatform(platform);
    if (!uid) throw new Error('user_id 不合法');
    if (!acc) throw new Error('game_account 不能为空');
    if (!pf) throw new Error('platform 不合法');

    const db = openDatabase();
    try {
        const now = nowText();
        const payload = JSON.stringify(normalizeDetail(detail));
        let exists = await get(db, `
            SELECT id
            FROM user_platform_restrict
            WHERE user_id = ? AND game_id = ? AND game_account = ? AND platform = ? AND is_deleted = 0
            LIMIT 1
        `, [uid, gid, acc, pf]);
        if (!exists) {
            try {
                await run(db, `
                    INSERT INTO user_platform_restrict
                    (user_id, game_account, game_id, game_name, platform, reason, detail, create_date, modify_date, is_deleted, desc)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
                `, [uid, acc, gid, gameName, pf, RESTRICT_REASON, payload, now, now, String(desc || '').trim()]);
                return true;
            } catch (err) {
                // 并发场景下，另一请求可能在 exists 查询后已完成插入。
                // 这里回退为重查并更新，保证 upsert 幂等。
                if (!isActiveRestrictUniqueConstraintError(err)) throw err;
                exists = await get(db, `
                    SELECT id
                    FROM user_platform_restrict
                    WHERE user_id = ? AND game_id = ? AND game_account = ? AND platform = ? AND is_deleted = 0
                    LIMIT 1
                `, [uid, gid, acc, pf]);
                if (!exists) throw err;
            }
        }
        await run(db, `
            UPDATE user_platform_restrict
            SET game_name = ?, reason = ?, detail = ?, modify_date = ?, desc = ?
            WHERE id = ?
        `, [gameName, RESTRICT_REASON, payload, now, String(desc || '').trim(), Number(exists.id)]);
        return true;
    } finally {
        db.close();
    }
}

async function removePlatformRestrict(userId, gameAccount, platform, desc = '') {
    await initUserPlatformRestrictDb();
    const uid = Number(userId || 0);
    const key = normalizeRestrictKey(gameAccount);
    const acc = key.game_account;
    const gid = key.game_id;
    const pf = normalizePlatform(platform);
    if (!uid || !acc || !pf) return false;

    const db = openDatabase();
    try {
        const r = await run(db, `
            UPDATE user_platform_restrict
            SET is_deleted = 1, modify_date = ?, desc = ?
            WHERE user_id = ? AND game_id = ? AND game_account = ? AND platform = ? AND is_deleted = 0
        `, [nowText(), String(desc || '').trim(), uid, gid, acc, pf]);
        return Number(r.changes || 0) > 0;
    } finally {
        db.close();
    }
}

async function listPlatformRestrictByUserAndAccounts(userId, gameAccounts = []) {
    await initUserPlatformRestrictDb();
    const uid = Number(userId || 0);
    if (!uid) return [];
    const keys = Array.from(new Map((Array.isArray(gameAccounts) ? gameAccounts : [])
        .map((x) => normalizeRestrictKey(x))
        .filter((x) => x.game_account)
        .map((x) => [`${x.game_id}::${x.game_account}`, x])).values());
    if (keys.length === 0) return [];

    const db = openDatabase();
    try {
        const tupleSql = keys.map(() => `(game_id = ? AND game_account = ?)`).join(' OR ');
        const rows = await all(db, `
            SELECT user_id, game_account, game_id, game_name, platform, reason, detail, create_date, modify_date, desc
            FROM user_platform_restrict
            WHERE user_id = ? AND is_deleted = 0 AND (${tupleSql})
            ORDER BY id ASC
        `, [uid, ...keys.flatMap((x) => [x.game_id, x.game_account])]);
        return rows.map((r) => ({
            user_id: Number(r.user_id || 0),
            game_account: String(r.game_account || '').trim(),
            game_id: String(r.game_id || '1').trim() || '1',
            game_name: String(r.game_name || 'WZRY').trim() || 'WZRY',
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
