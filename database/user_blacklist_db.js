const { openDatabase } = require('./sqlite_client');

const BL_MODE_LEGACY = 0;
const BL_MODE_DUAL_READ_OLD = 1;
const BL_MODE_DUAL_READ_NEW = 2;
const BL_MODE_V2 = 3;

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
    } catch (err) {
        try { await run(db, 'ROLLBACK'); } catch (_) {}
        throw err;
    }
}

function stableJson(v) {
    return JSON.stringify(v == null ? null : v);
}

function stableObjectJson(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return '{}';
    return JSON.stringify(v);
}

function parseJsonObject(text) {
    try {
        const obj = JSON.parse(String(text || '{}'));
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
        return obj;
    } catch {
        return {};
    }
}

function normalizeBlacklistV2Mode(input) {
    const n = Number(input);
    if (n === BL_MODE_LEGACY || n === BL_MODE_DUAL_READ_OLD || n === BL_MODE_DUAL_READ_NEW || n === BL_MODE_V2) return n;
    return BL_MODE_DUAL_READ_OLD;
}

function getBlacklistV2Mode() {
    return normalizeBlacklistV2Mode(process.env.BL_V2_MODE || BL_MODE_DUAL_READ_OLD);
}

function shouldSyncSourceShadow() {
    return getBlacklistV2Mode() >= BL_MODE_DUAL_READ_OLD;
}

function resolveSourcePriorityByReason(reason = '') {
    const text = String(reason || '').trim();
    if (text === '账号找回') return 1000;
    if (text === '维护中') return 900;
    if (text === '人工下架') return 850;
    if (text === '禁玩中') return 700;
    if (text === '检测在线') return 650;
    if (text === '冷却期下架') return 500;
    if (/^\d+单下架$/.test(text)) return 400;
    return 600;
}

function resolveSourceByLegacyWrite(reason = '', source = '') {
    const r = String(reason || '').trim();
    const s = String(source || '').trim().toLowerCase();
    if (s === 'order_cooldown' || r === '冷却期下架') return 'order_cooldown';
    if (s === 'order_3_off' || s === 'order_3_off_guard' || /^\d+单下架$/.test(r)) return 'order_n_off';
    if (r === '检测在线') return 'guard_online';
    if (r === '禁玩中') return 'guard_forbidden';
    if (s === 'h5_maintenance' || r === '维护中') return 'manual_maintenance';
    if (r === '账号找回') return 'manual_recover';
    if (s === 'h5' || r === '人工下架') return 'manual_block';
    return 'legacy_carryover';
}

async function mirrorSourceShadowUpsert(userId, gameAccount, reason, options = {}) {
    if (!shouldSyncSourceShadow()) return;
    const db = options.db;
    if (!db) return;
    // V2 投影写回 old 表时，不允许再次镜像回 source，避免 source 被反向污染。
    if (String(options.source || '').trim() === 'reconcile_blacklist_v2') return;
    const uid = Number(userId || 0);
    const acc = String(gameAccount || '').trim();
    const rs = String(reason || '').trim();
    if (!uid || !acc || !rs) return;
    const src = resolveSourceByLegacyWrite(rs, options.source);
    const now = String(options.now || '').trim() || nowText();
    const desc = String(options.desc || '').trim() || 'mirror from legacy blacklist upsert';
    const detail = stableObjectJson({
        from: 'legacy_blacklist_write',
        legacy_source: String(options.source || '').trim(),
        legacy_operator: String(options.operator || '').trim()
    });
    const priority = resolveSourcePriorityByReason(rs);
    const oldRow = await get(db, `
        SELECT id
        FROM user_blacklist_source
        WHERE user_id = ? AND game_account = ? AND source = ? AND is_deleted = 0
        LIMIT 1
    `, [uid, acc, src]);
    if (oldRow) {
        await run(db, `
            UPDATE user_blacklist_source
            SET active = 1, reason = ?, priority = ?, detail = ?, expire_at = '',
                modify_date = ?, is_deleted = 0, desc = ?
            WHERE id = ?
        `, [rs, priority, detail, now, desc, Number(oldRow.id)]);
        return;
    }
    await run(db, `
        INSERT INTO user_blacklist_source
        (user_id, game_account, source, active, reason, priority, detail, expire_at, create_date, modify_date, is_deleted, desc)
        VALUES (?, ?, ?, 1, ?, ?, ?, '', ?, ?, 0, ?)
    `, [uid, acc, src, rs, priority, detail, now, now, desc]);
}

async function mirrorSourceShadowClearByAccount(userId, gameAccount, options = {}) {
    if (!shouldSyncSourceShadow()) return;
    const db = options.db;
    if (!db) return;
    const uid = Number(userId || 0);
    const acc = String(gameAccount || '').trim();
    if (!uid || !acc) return;
    const now = String(options.now || '').trim() || nowText();
    const desc = String(options.desc || '').trim() || 'mirror clear from legacy blacklist hard_delete';
    const rows = await all(db, `
        SELECT id, reason, priority, detail, expire_at
        FROM user_blacklist_source
        WHERE user_id = ? AND game_account = ? AND is_deleted = 0
    `, [uid, acc]);
    for (const row of rows) {
        const detail = parseJsonObject(row && row.detail);
        await run(db, `
            UPDATE user_blacklist_source
            SET active = 0, reason = ?, priority = ?, detail = ?, expire_at = ?, modify_date = ?, is_deleted = 0, desc = ?
            WHERE id = ?
        `, [
            String((row && row.reason) || '').trim(),
            Number((row && row.priority) || 0),
            stableObjectJson({
                ...detail,
                cleared_by: 'legacy_blacklist_hard_delete'
            }),
            String((row && row.expire_at) || '').trim(),
            now,
            desc,
            Number((row && row.id) || 0)
        ]);
    }
}

async function tableColumnNamesInOrder(db, tableName) {
    const rows = await all(db, `PRAGMA table_info(${tableName})`);
    return rows.map((row) => String((row && row.name) || '').trim());
}

function normalizeUserId(userId) {
    return Number(userId || 0);
}

function normalizeBlacklistEntry(entry = {}) {
    return {
        game_account: String(entry.game_account || entry.account || '').trim(),
        remark: String(entry.remark || '').trim(),
        reason: String(entry.reason || '').trim()
    };
}

function rowToPublicEntry(row = {}) {
    return {
        game_account: String(row.game_account || '').trim(),
        remark: String(row.remark || '').trim(),
        reason: String(row.reason || '').trim(),
        create_date: String(row.create_date || '').trim()
    };
}

async function ensureUserBlacklistColumns(db) {
    const columns = await all(db, 'PRAGMA table_info(user_blacklist)');
    const names = new Set(columns.map((c) => String(c && c.name || '').trim()));
    if (!names.has('remark')) {
        await run(db, `ALTER TABLE user_blacklist ADD COLUMN remark TEXT NOT NULL DEFAULT ''`);
    }
    if (!names.has('reason')) {
        await run(db, `ALTER TABLE user_blacklist ADD COLUMN reason TEXT NOT NULL DEFAULT ''`);
    }
}

async function reorderUserBlacklistColumnsIfNeeded(db) {
    const expected = [
        'id',
        'user_id',
        'game_account',
        'remark',
        'reason',
        'create_date',
        'modify_date',
        'is_deleted',
        'desc'
    ];
    const actual = await tableColumnNamesInOrder(db, 'user_blacklist');
    if (actual.length === expected.length && actual.every((name, i) => name === expected[i])) return;

    await run(db, `ALTER TABLE user_blacklist RENAME TO user_blacklist_old`);
    await run(db, `
        CREATE TABLE user_blacklist (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            game_account TEXT NOT NULL,
            remark TEXT NOT NULL DEFAULT '',
            reason TEXT NOT NULL DEFAULT '',
            create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            is_deleted INTEGER NOT NULL DEFAULT 0,
            desc TEXT NOT NULL DEFAULT ''
        )
    `);
    await run(db, `
        INSERT INTO user_blacklist
        (id, user_id, game_account, remark, reason, create_date, modify_date, is_deleted, desc)
        SELECT
            id,
            user_id,
            game_account,
            COALESCE(remark, ''),
            COALESCE(reason, ''),
            COALESCE(create_date, CURRENT_TIMESTAMP),
            COALESCE(modify_date, CURRENT_TIMESTAMP),
            COALESCE(is_deleted, 0),
            COALESCE(desc, '')
        FROM user_blacklist_old
    `);
    await run(db, `DROP TABLE user_blacklist_old`);
}

async function backfillUserBlacklistRemarkFromUserGameAccount(db) {
    await run(db, `
        UPDATE user_blacklist
        SET remark = COALESCE((
            SELECT uga.account_remark
            FROM user_game_account uga
            WHERE uga.user_id = user_blacklist.user_id
              AND uga.game_account = user_blacklist.game_account
              AND uga.is_deleted = 0
              AND TRIM(COALESCE(uga.account_remark, '')) <> ''
            ORDER BY uga.id DESC
            LIMIT 1
        ), remark),
        modify_date = ?
        WHERE is_deleted = 0
          AND TRIM(COALESCE(remark, '')) = ''
    `, [nowText()]);
}

async function loadRemarkFromUserGameAccount(db, userId, gameAccount) {
    try {
        const row = await get(db, `
            SELECT account_remark
            FROM user_game_account
            WHERE user_id = ? AND game_account = ? AND is_deleted = 0
            ORDER BY id DESC
            LIMIT 1
        `, [userId, gameAccount]);
        return String((row && row.account_remark) || '').trim();
    } catch {
        return '';
    }
}

async function initUserBlacklistDb() {
    const db = openDatabase();
    try {
        await run(db, `
            CREATE TABLE IF NOT EXISTS user_blacklist (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                game_account TEXT NOT NULL,
                remark TEXT NOT NULL DEFAULT '',
                reason TEXT NOT NULL DEFAULT '',
                create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        await ensureUserBlacklistColumns(db);
        await reorderUserBlacklistColumnsIfNeeded(db);
        await run(db, `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_user_blacklist_alive
            ON user_blacklist(user_id, game_account, is_deleted)
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_user_blacklist_user_alive
            ON user_blacklist(user_id, is_deleted)
        `);
        await run(db, `
            CREATE TABLE IF NOT EXISTS user_blacklist_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                event_type TEXT NOT NULL,
                game_account TEXT NOT NULL DEFAULT '',
                before_data TEXT NOT NULL DEFAULT '',
                after_data TEXT NOT NULL DEFAULT '',
                source TEXT NOT NULL DEFAULT '',
                operator TEXT NOT NULL DEFAULT '',
                create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_user_blacklist_history_user
            ON user_blacklist_history(user_id, is_deleted, id)
        `);
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
        try {
            await backfillUserBlacklistRemarkFromUserGameAccount(db);
        } catch (_) {
            // user_game_account 尚未初始化时，允许跳过一次回填。
        }
    } finally {
        db.close();
    }
}

async function listBlacklistedAccountsByUser(userId) {
    await initUserBlacklistDb();
    const uid = normalizeUserId(userId);
    if (!uid) return [];
    const db = openDatabase();
    try {
        const rows = await all(db, `
            SELECT game_account
            FROM user_blacklist
            WHERE user_id = ? AND is_deleted = 0
            ORDER BY id ASC
        `, [uid]);
        return rows.map((r) => String(r.game_account || '').trim()).filter(Boolean);
    } finally {
        db.close();
    }
}

async function listUserBlacklistByUser(userId) {
    await initUserBlacklistDb();
    const uid = normalizeUserId(userId);
    if (!uid) return [];
    const db = openDatabase();
    try {
        const rows = await all(db, `
            SELECT game_account, remark, reason, create_date
            FROM user_blacklist
            WHERE user_id = ? AND is_deleted = 0
            ORDER BY id ASC
        `, [uid]);
        return rows.map(rowToPublicEntry).filter((x) => x.game_account);
    } finally {
        db.close();
    }
}

async function listUserBlacklistByUserWithMeta(userId) {
    await initUserBlacklistDb();
    const uid = normalizeUserId(userId);
    if (!uid) return [];
    const db = openDatabase();
    try {
        const rows = await all(db, `
            SELECT game_account, remark, reason, create_date, modify_date, desc
            FROM user_blacklist
            WHERE user_id = ? AND is_deleted = 0
            ORDER BY id ASC
        `, [uid]);
        return rows.map((row) => ({
            game_account: String(row.game_account || '').trim(),
            remark: String(row.remark || '').trim(),
            reason: String(row.reason || '').trim(),
            create_date: String(row.create_date || '').trim(),
            modify_date: String(row.modify_date || '').trim(),
            desc: String(row.desc || '').trim()
        })).filter((x) => x.game_account);
    } finally {
        db.close();
    }
}

async function upsertUserBlacklistEntry(userId, entry, opts = {}) {
    await initUserBlacklistDb();
    const uid = normalizeUserId(userId);
    if (!uid) throw new Error('user_id 非法');

    const source = String(opts.source || 'api').trim();
    const operator = String(opts.operator || 'system').trim();
    const desc = String(opts.desc || '').trim();
    const customCreateDate = String(opts.create_date || '').trim();
    const normalized = normalizeBlacklistEntry(entry);
    if (!normalized.game_account) throw new Error('game_account 不能为空');

    const db = openDatabase();
    try {
        return await inTx(db, async () => {
            const now = nowText();
            const roleName = await loadRemarkFromUserGameAccount(db, uid, normalized.game_account);
            const oldRow = await get(db, `
                SELECT * FROM user_blacklist
                WHERE user_id = ? AND game_account = ? AND is_deleted = 0
            `, [uid, normalized.game_account]);
            const oldPayload = oldRow ? rowToPublicEntry(oldRow) : null;
            const eventType = oldRow ? 'upsert_update' : 'upsert_insert';
            const finalRemark = roleName || normalized.remark || String((oldRow && oldRow.remark) || '').trim();

            if (oldRow) {
                if (customCreateDate) {
                    await run(db, `
                        UPDATE user_blacklist
                        SET remark = ?, reason = ?, create_date = ?, modify_date = ?, desc = ?, is_deleted = 0
                        WHERE user_id = ? AND game_account = ? AND is_deleted = 0
                    `, [
                        finalRemark,
                        normalized.reason,
                        customCreateDate,
                        now,
                        desc,
                        uid,
                        normalized.game_account
                    ]);
                } else {
                    await run(db, `
                        UPDATE user_blacklist
                        SET remark = ?, reason = ?, modify_date = ?, desc = ?, is_deleted = 0
                        WHERE user_id = ? AND game_account = ? AND is_deleted = 0
                    `, [
                        finalRemark,
                        normalized.reason,
                        now,
                        desc,
                        uid,
                        normalized.game_account
                    ]);
                }
            } else {
                await run(db, `
                    INSERT INTO user_blacklist
                    (user_id, game_account, remark, reason, create_date, modify_date, is_deleted, desc)
                    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
                `, [
                    uid,
                    normalized.game_account,
                    finalRemark,
                    normalized.reason,
                    customCreateDate || now,
                    now,
                    desc
                ]);
            }

            const newRow = await get(db, `
                SELECT game_account, remark, reason, create_date
                FROM user_blacklist
                WHERE user_id = ? AND game_account = ? AND is_deleted = 0
            `, [uid, normalized.game_account]);
            const newPayload = rowToPublicEntry(newRow || {});

            await run(db, `
                INSERT INTO user_blacklist_history
                (user_id, event_type, game_account, before_data, after_data, source, operator, modify_date, desc)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                uid,
                eventType,
                normalized.game_account,
                stableJson(oldPayload),
                stableJson(newPayload),
                source,
                operator,
                now,
                desc
            ]);

            try {
                await mirrorSourceShadowUpsert(uid, normalized.game_account, normalized.reason, {
                    db,
                    now,
                    source,
                    operator,
                    desc
                });
            } catch (e) {
                console.warn(`[BlacklistSourceShadow] upsert mirror failed user=${uid} account=${normalized.game_account}: ${e.message}`);
            }

            return newPayload;
        });
    } finally {
        db.close();
    }
}

async function removeUserBlacklistEntry(userId, gameAccount, opts = {}) {
    await initUserBlacklistDb();
    const uid = normalizeUserId(userId);
    const acc = String(gameAccount || '').trim();
    if (!uid) throw new Error('user_id 非法');
    if (!acc) throw new Error('game_account 不能为空');

    const source = String(opts.source || 'api').trim();
    const operator = String(opts.operator || 'system').trim();
    const desc = String(opts.desc || '').trim();

    const db = openDatabase();
    try {
        return await inTx(db, async () => {
            const now = nowText();
            const oldRow = await get(db, `
                SELECT * FROM user_blacklist
                WHERE user_id = ? AND game_account = ? AND is_deleted = 0
            `, [uid, acc]);
            if (!oldRow) return false;

            const oldPayload = rowToPublicEntry(oldRow);
            await run(db, `
                UPDATE user_blacklist
                SET is_deleted = 1, modify_date = ?, desc = ?
                WHERE user_id = ? AND game_account = ? AND is_deleted = 0
            `, [now, desc, uid, acc]);

            await run(db, `
                INSERT INTO user_blacklist_history
                (user_id, event_type, game_account, before_data, after_data, source, operator, modify_date, desc)
                VALUES (?, 'delete', ?, ?, ?, ?, ?, ?, ?)
            `, [
                uid,
                acc,
                stableJson(oldPayload),
                stableJson(null),
                source,
                operator,
                now,
                desc
            ]);
            return true;
        });
    } finally {
        db.close();
    }
}

async function hardDeleteUserBlacklistEntry(userId, gameAccount, opts = {}) {
    await initUserBlacklistDb();
    const uid = normalizeUserId(userId);
    const acc = String(gameAccount || '').trim();
    if (!uid) throw new Error('user_id 非法');
    if (!acc) throw new Error('game_account 不能为空');

    const source = String(opts.source || 'api').trim();
    const operator = String(opts.operator || 'system').trim();
    const desc = String(opts.desc || '').trim();
    const reasonExpected = opts.reason_expected === undefined
        ? ''
        : String(opts.reason_expected || '').trim();

    const db = openDatabase();
    try {
        return await inTx(db, async () => {
            const now = nowText();
            const oldRow = await get(db, `
                SELECT * FROM user_blacklist
                WHERE user_id = ? AND game_account = ? AND is_deleted = 0
            `, [uid, acc]);
            if (!oldRow) return false;
            if (reasonExpected && String(oldRow.reason || '').trim() !== reasonExpected) {
                return false;
            }

            const oldPayload = rowToPublicEntry(oldRow);
            await run(db, `
                DELETE FROM user_blacklist
                WHERE user_id = ? AND game_account = ? AND is_deleted = 0
            `, [uid, acc]);

            await run(db, `
                INSERT INTO user_blacklist_history
                (user_id, event_type, game_account, before_data, after_data, source, operator, modify_date, desc)
                VALUES (?, 'hard_delete', ?, ?, ?, ?, ?, ?, ?)
            `, [
                uid,
                acc,
                stableJson(oldPayload),
                stableJson(null),
                source,
                operator,
                now,
                desc
            ]);
            try {
                await mirrorSourceShadowClearByAccount(uid, acc, {
                    db,
                    now,
                    desc
                });
            } catch (e) {
                console.warn(`[BlacklistSourceShadow] hard_delete mirror failed user=${uid} account=${acc}: ${e.message}`);
            }
            return true;
        });
    } finally {
        db.close();
    }
}

module.exports = {
    initUserBlacklistDb,
    listBlacklistedAccountsByUser,
    listUserBlacklistByUser,
    listUserBlacklistByUserWithMeta,
    upsertUserBlacklistEntry,
    removeUserBlacklistEntry,
    hardDeleteUserBlacklistEntry
};
