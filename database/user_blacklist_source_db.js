const { openDatabase } = require('./sqlite_client');
const { normalizeGameProfile } = require('../common/game_profile');

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
    await run(db, 'BEGIN IMMEDIATE');
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

function normalizeGameIdentity(gameId, gameName) {
    const normalized = normalizeGameProfile(gameId, gameName, { preserveUnknown: true });
    return {
        game_id: String(normalized.game_id || '1').trim() || '1',
        game_name: String(normalized.game_name || 'WZRY').trim() || 'WZRY'
    };
}

function normalizeAccountKey(input, fallback = {}) {
    if (input && typeof input === 'object' && !Array.isArray(input)) {
        const gameAccount = normalizeGameAccount(input.game_account || input.account);
        const game = normalizeGameIdentity(input.game_id || fallback.game_id, input.game_name || fallback.game_name);
        return {
            game_account: gameAccount,
            game_id: game.game_id,
            game_name: game.game_name
        };
    }
    const game = normalizeGameIdentity(fallback.game_id, fallback.game_name);
    return {
        game_account: normalizeGameAccount(input),
        game_id: game.game_id,
        game_name: game.game_name
    };
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
        game_id: String(row.game_id || '1').trim() || '1',
        game_name: String(row.game_name || 'WZRY').trim() || 'WZRY',
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

async function tableColumns(db, tableName) {
    const rows = await all(db, `PRAGMA table_info(${tableName})`);
    return rows.map((row) => String((row && row.name) || '').trim());
}

async function rebuildUserBlacklistSourceTable(db) {
    const cols = await tableColumns(db, 'user_blacklist_source');
    const expected = [
        'id', 'user_id', 'game_account', 'game_id', 'game_name', 'source', 'active', 'reason', 'priority',
        'detail', 'expire_at', 'create_date', 'modify_date', 'is_deleted', 'desc'
    ];
    if (cols.length === expected.length && cols.every((name, idx) => name === expected[idx])) return;

    await run(db, `ALTER TABLE user_blacklist_source RENAME TO user_blacklist_source_old`);
    await run(db, `
        CREATE TABLE user_blacklist_source (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            game_account TEXT NOT NULL,
            game_id TEXT NOT NULL DEFAULT '1',
            game_name TEXT NOT NULL DEFAULT 'WZRY',
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

    const oldRows = await all(db, `SELECT * FROM user_blacklist_source_old ORDER BY id ASC`);
    for (const row of oldRows) {
        const linked = await all(db, `
            SELECT game_id, game_name
            FROM user_game_account
            WHERE user_id = ?
              AND game_account = ?
              AND is_deleted = 0
            ORDER BY id DESC
        `, [Number(row.user_id || 0), String(row.game_account || '').trim()]);
        const targets = linked.length > 0
            ? linked.map((x) => normalizeGameIdentity(x.game_id, x.game_name))
            : [normalizeGameIdentity(row.game_id, row.game_name)];
        for (const target of targets) {
            await run(db, `
                INSERT INTO user_blacklist_source
                (user_id, game_account, game_id, game_name, source, active, reason, priority, detail, expire_at, create_date, modify_date, is_deleted, desc)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                Number(row.user_id || 0),
                String(row.game_account || '').trim(),
                target.game_id,
                target.game_name,
                String(row.source || '').trim(),
                Number(row.active || 0),
                String(row.reason || '').trim(),
                Number(row.priority || 0),
                String(row.detail || '{}'),
                String(row.expire_at || '').trim(),
                String(row.create_date || '').trim() || nowText(),
                String(row.modify_date || '').trim() || nowText(),
                Number(row.is_deleted || 0),
                String(row.desc || '').trim()
            ]);
        }
    }
    await run(db, `DROP TABLE user_blacklist_source_old`);
}

async function backfillSourceGameIdentityByAccount(db) {
    const rows = await all(db, `
        SELECT id, user_id, game_account, source, game_id, game_name
        FROM user_blacklist_source
        WHERE is_deleted = 0
          AND COALESCE(game_id, '1') = '1'
    `);
    for (const row of rows) {
        const matches = await all(db, `
            SELECT DISTINCT game_id, game_name
            FROM user_game_account
            WHERE user_id = ?
              AND game_account = ?
              AND is_deleted = 0
        `, [Number(row.user_id || 0), String(row.game_account || '').trim()]);
        if (matches.length !== 1) continue;
        const one = normalizeGameIdentity(matches[0].game_id, matches[0].game_name);
        const current = normalizeGameIdentity(row.game_id, row.game_name);
        if (current.game_id === one.game_id && current.game_name === one.game_name) continue;
        const conflict = await get(db, `
            SELECT id
            FROM user_blacklist_source
            WHERE user_id = ?
              AND game_account = ?
              AND source = ?
              AND game_id = ?
              AND is_deleted = 0
              AND id <> ?
            LIMIT 1
        `, [
            Number(row.user_id || 0),
            String(row.game_account || '').trim(),
            String(row.source || '').trim(),
            one.game_id,
            Number(row.id || 0)
        ]);
        if (conflict) continue;
        await run(db, `
            UPDATE user_blacklist_source
            SET game_id = ?, game_name = ?, modify_date = ?
            WHERE id = ?
        `, [one.game_id, one.game_name, nowText(), Number(row.id || 0)]);
    }
}

async function initUserBlacklistSourceDb() {
    const db = openDatabase();
    try {
        await run(db, `
            CREATE TABLE IF NOT EXISTS user_blacklist_source (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                game_account TEXT NOT NULL,
                game_id TEXT NOT NULL DEFAULT '1',
                game_name TEXT NOT NULL DEFAULT 'WZRY',
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
        const cols = new Set(await tableColumns(db, 'user_blacklist_source'));
        if (!cols.has('game_id')) {
            await run(db, `ALTER TABLE user_blacklist_source ADD COLUMN game_id TEXT NOT NULL DEFAULT '1'`);
        }
        if (!cols.has('game_name')) {
            await run(db, `ALTER TABLE user_blacklist_source ADD COLUMN game_name TEXT NOT NULL DEFAULT 'WZRY'`);
        }
        await rebuildUserBlacklistSourceTable(db);
        await run(db, `DROP INDEX IF EXISTS uq_user_blacklist_source_alive`);
        await run(db, `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_user_blacklist_source_alive
            ON user_blacklist_source(user_id, game_id, game_account, source, is_deleted)
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_user_blacklist_source_user_alive
            ON user_blacklist_source(user_id, game_id, active, modify_date, is_deleted)
        `);
        await backfillSourceGameIdentityByAccount(db);
    } finally {
        db.close();
    }
}

async function upsertBlacklistSource(userId, gameAccount, source, patch = {}, opts = {}) {
    await initUserBlacklistSourceDb();
    const uid = Number(userId || 0);
    const key = normalizeAccountKey(gameAccount, patch);
    const acc = key.game_account;
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
        const loadLatest = async () => get(db, `
            SELECT *
            FROM user_blacklist_source
            WHERE user_id = ? AND game_id = ? AND game_account = ? AND source = ? AND is_deleted = 0
            LIMIT 1
        `, [uid, key.game_id, acc, src]);

        try {
            return await inTx(db, async () => {
                const now = nowText();
                await run(db, `
                    INSERT INTO user_blacklist_source
                    (user_id, game_account, game_id, game_name, source, active, reason, priority, detail, expire_at, create_date, modify_date, is_deleted, desc)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
                    ON CONFLICT(user_id, game_id, game_account, source, is_deleted)
                    DO UPDATE SET
                      game_name = excluded.game_name,
                      active = excluded.active,
                      reason = excluded.reason,
                      priority = excluded.priority,
                      detail = excluded.detail,
                      expire_at = excluded.expire_at,
                      modify_date = excluded.modify_date,
                      desc = excluded.desc
                `, [uid, acc, key.game_id, key.game_name, src, active, reason, priority, detail, expireAt, now, now, desc]);
                return rowToSource((await loadLatest()) || {});
            });
        } catch (e) {
            const msg = String(e && e.message ? e.message : e || '');
            if (!/UNIQUE constraint failed: user_blacklist_source\./i.test(msg)) throw e;
            const now = nowText();
            await run(db, `
                UPDATE user_blacklist_source
                SET game_name = ?, active = ?, reason = ?, priority = ?, detail = ?, expire_at = ?, modify_date = ?, desc = ?, is_deleted = 0
                WHERE user_id = ? AND game_id = ? AND game_account = ? AND source = ? AND is_deleted = 0
            `, [key.game_name, active, reason, priority, detail, expireAt, now, desc, uid, key.game_id, acc, src]);
            return rowToSource((await loadLatest()) || {});
        }
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
    const keys = Array.from(new Map((Array.isArray(accounts) ? accounts : [])
        .map((x) => normalizeAccountKey(x))
        .filter((x) => x.game_account)
        .map((x) => [`${x.game_id}::${x.game_account}`, x])).values());
    if (!uid || keys.length === 0) return [];
    const activeOnly = options.active_only === undefined ? false : Boolean(options.active_only);

    const tupleSql = keys.map(() => `(game_id = ? AND game_account = ?)`).join(' OR ');
    const db = openDatabase();
    try {
        const rows = await all(db, `
            SELECT *
            FROM user_blacklist_source
            WHERE user_id = ?
              AND is_deleted = 0
              ${activeOnly ? 'AND active = 1' : ''}
              AND (${tupleSql})
            ORDER BY game_account ASC, priority DESC, source ASC
        `, [uid, ...keys.flatMap((x) => [x.game_id, x.game_account])]);
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
    const key = normalizeAccountKey(gameAccount, opts);
    const acc = key.game_account;
    const src = normalizeSource(source);
    if (!uid || !acc || !src) return false;
    const now = nowText();
    const desc = String(opts.desc || '').trim();

    const db = openDatabase();
    try {
        const r = await run(db, `
            UPDATE user_blacklist_source
            SET is_deleted = 1, modify_date = ?, desc = ?
            WHERE user_id = ? AND game_id = ? AND game_account = ? AND source = ? AND is_deleted = 0
        `, [now, desc, uid, key.game_id, acc, src]);
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
