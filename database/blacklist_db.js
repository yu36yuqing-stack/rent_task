const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { openDatabase } = require('./sqlite_client');

function nowText() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function normalizeInputEntry(entry = {}) {
    return {
        account: String(entry.account || '').trim(),
        remark: String(entry.remark || '').trim(),
        reason: String(entry.reason || '').trim(),
        create_time: String(entry.create_time || '').trim(),
        action: String(entry.action || 'off').toLowerCase() === 'on' ? 'on' : 'off'
    };
}

function rowToPublicEntry(row = {}) {
    return {
        account: String(row.account || '').trim(),
        remark: String(row.remark || '').trim(),
        reason: String(row.reason || '').trim(),
        // blacklist.json 的 create_time 统一映射到表里的 create_date
        create_time: String(row.create_date || row.create_time || '').trim(),
        action: String(row.action || 'off').toLowerCase() === 'on' ? 'on' : 'off'
    };
}

function stableJson(v) {
    return JSON.stringify(v || {});
}

function hashText(s) {
    return crypto.createHash('sha256').update(String(s || ''), 'utf8').digest('hex');
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

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
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

async function migrateBlacklistItemSchemaIfNeeded(db) {
    const columns = await all(db, `PRAGMA table_info(blacklist_item)`);
    if (!Array.isArray(columns) || columns.length === 0) return;
    const hasCreateTime = columns.some((c) => c && c.name === 'create_time');
    if (!hasCreateTime) return;

    await run(db, `ALTER TABLE blacklist_item RENAME TO blacklist_item_old`);
    await run(db, `
        CREATE TABLE blacklist_item (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            account TEXT NOT NULL,
            remark TEXT DEFAULT '',
            reason TEXT DEFAULT '',
            action TEXT DEFAULT 'off',
            source TEXT DEFAULT '',
            create_date TEXT DEFAULT CURRENT_TIMESTAMP,
            modify_date TEXT DEFAULT CURRENT_TIMESTAMP,
            is_deleted INTEGER DEFAULT 0,
            desc TEXT DEFAULT ''
        )
    `);
    await run(db, `
        INSERT INTO blacklist_item
        (id, account, remark, reason, action, source, create_date, modify_date, is_deleted, desc)
        SELECT
            id,
            account,
            COALESCE(remark, ''),
            COALESCE(reason, ''),
            COALESCE(action, 'off'),
            COALESCE(source, ''),
            CASE WHEN TRIM(COALESCE(create_time, '')) <> '' THEN create_time ELSE COALESCE(create_date, '') END,
            COALESCE(modify_date, CURRENT_TIMESTAMP),
            COALESCE(is_deleted, 0),
            COALESCE(desc, '')
        FROM blacklist_item_old
    `);
    await run(db, `DROP TABLE blacklist_item_old`);
}

async function initBlacklistDb() {
    const db = openDatabase();
    try {
        await run(db, `
            CREATE TABLE IF NOT EXISTS blacklist_item (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                account TEXT NOT NULL,
                remark TEXT DEFAULT '',
                reason TEXT DEFAULT '',
                action TEXT DEFAULT 'off',
                source TEXT DEFAULT '',
                create_date TEXT DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER DEFAULT 0,
                desc TEXT DEFAULT ''
            )
        `);
        await migrateBlacklistItemSchemaIfNeeded(db);
        await run(db, `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_blacklist_item_account_alive
            ON blacklist_item(account, is_deleted)
        `);
        await run(db, `
            CREATE TABLE IF NOT EXISTS blacklist_history (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                event_type TEXT NOT NULL,
                account TEXT DEFAULT '',
                before_data TEXT DEFAULT '',
                after_data TEXT DEFAULT '',
                source TEXT DEFAULT '',
                operator TEXT DEFAULT '',
                create_date TEXT DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER DEFAULT 0,
                desc TEXT DEFAULT ''
            )
        `);
        await run(db, `
            CREATE TABLE IF NOT EXISTS blacklist_meta (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                meta_key TEXT NOT NULL UNIQUE,
                meta_value TEXT DEFAULT '',
                create_date TEXT DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER DEFAULT 0,
                desc TEXT DEFAULT ''
            )
        `);
    } finally {
        db.close();
    }
}

async function getActiveBlacklist() {
    await initBlacklistDb();
    const db = openDatabase();
    try {
        const rows = await all(db, `
            SELECT account, remark, reason, create_date, action
            FROM blacklist_item
            WHERE is_deleted = 0
            ORDER BY id ASC
        `);
        return rows.map(rowToPublicEntry).filter((e) => e.account);
    } finally {
        db.close();
    }
}

async function upsertBlacklistEntry(entry, opts = {}) {
    await initBlacklistDb();
    const src = String(opts.source || 'api');
    const operator = String(opts.operator || 'openclaw');
    const desc = String(opts.desc || '');
    const normalized = normalizeInputEntry(entry);
    if (!normalized.account) throw new Error('account 不能为空');

    const db = openDatabase();
    try {
        await inTx(db, async () => {
            const oldRow = await get(db, `
                SELECT * FROM blacklist_item WHERE account = ? AND is_deleted = 0
            `, [normalized.account]);
            const oldPayload = oldRow ? rowToPublicEntry(oldRow) : null;
            const createDate = normalized.create_time || (oldPayload ? oldPayload.create_time : '') || nowText();
            const afterPayload = { ...normalized, create_time: createDate };

            const eventType = oldRow ? 'upsert_update' : 'upsert_insert';
            await run(db, `
                INSERT INTO blacklist_history
                (event_type, account, before_data, after_data, source, operator, modify_date, desc)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                eventType,
                normalized.account,
                stableJson(oldPayload),
                stableJson(afterPayload),
                src,
                operator,
                nowText(),
                desc
            ]);

            if (oldRow) {
                await run(db, `
                    UPDATE blacklist_item
                    SET remark = ?, reason = ?, create_date = ?, action = ?, source = ?, modify_date = ?, desc = ?, is_deleted = 0
                    WHERE account = ? AND is_deleted = 0
                `, [
                    normalized.remark,
                    normalized.reason,
                    createDate,
                    normalized.action,
                    src,
                    nowText(),
                    desc,
                    normalized.account
                ]);
            } else {
                await run(db, `
                    INSERT INTO blacklist_item
                    (account, remark, reason, action, source, create_date, modify_date, is_deleted, desc)
                    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
                `, [
                    normalized.account,
                    normalized.remark,
                    normalized.reason,
                    normalized.action,
                    src,
                    createDate,
                    nowText(),
                    desc
                ]);
            }
        });
        return normalized;
    } finally {
        db.close();
    }
}

async function removeBlacklistEntry(account, opts = {}) {
    await initBlacklistDb();
    const src = String(opts.source || 'api');
    const operator = String(opts.operator || 'openclaw');
    const desc = String(opts.desc || '');
    const acc = String(account || '').trim();
    if (!acc) throw new Error('account 不能为空');

    const db = openDatabase();
    try {
        const result = await inTx(db, async () => {
            const oldRow = await get(db, `
                SELECT * FROM blacklist_item WHERE account = ? AND is_deleted = 0
            `, [acc]);
            if (!oldRow) return false;

            await run(db, `
                INSERT INTO blacklist_history
                (event_type, account, before_data, after_data, source, operator, modify_date, desc)
                VALUES ('delete', ?, ?, ?, ?, ?, ?, ?)
            `, [
                acc,
                stableJson(rowToPublicEntry(oldRow)),
                stableJson(null),
                src,
                operator,
                nowText(),
                desc
            ]);

            await run(db, `
                UPDATE blacklist_item
                SET is_deleted = 1, modify_date = ?, desc = ?
                WHERE account = ? AND is_deleted = 0
            `, [nowText(), desc, acc]);
            return true;
        });
        return result;
    } finally {
        db.close();
    }
}

async function exportBlacklistToFile(filePath) {
    const list = await getActiveBlacklist();
    fs.writeFileSync(filePath, `${JSON.stringify(list, null, 2)}\n`);
    return list.length;
}

async function ensureBlacklistSyncedFromFile(filePath, opts = {}) {
    await initBlacklistDb();
    const source = String(opts.source || 'file_sync');
    const operator = String(opts.operator || 'openclaw');
    const desc = String(opts.desc || 'sync blacklist file into sqlite');

    const abs = path.resolve(filePath);
    const raw = fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : '[]';
    let parsed = [];
    try {
        const data = JSON.parse(raw);
        parsed = Array.isArray(data) ? data.map(normalizeInputEntry).filter((e) => e.account) : [];
    } catch {
        throw new Error(`blacklist json 解析失败: ${abs}`);
    }

    const newHash = hashText(JSON.stringify(parsed));
    const db = openDatabase();
    try {
        return await inTx(db, async () => {
            const oldHashRow = await get(db, `
                SELECT meta_value FROM blacklist_meta WHERE meta_key = 'blacklist_file_hash' AND is_deleted = 0
            `);
            const oldHash = oldHashRow ? String(oldHashRow.meta_value || '') : '';
            if (oldHash && oldHash === newHash) {
                return { changed: false, count: parsed.length };
            }

            const oldRawRow = await get(db, `
                SELECT meta_value FROM blacklist_meta WHERE meta_key = 'blacklist_file_raw' AND is_deleted = 0
            `);
            const oldRaw = oldRawRow ? String(oldRawRow.meta_value || '[]') : '[]';

            // 文件级历史先入库，再变更 current 表。
            await run(db, `
                INSERT INTO blacklist_history
                (event_type, account, before_data, after_data, source, operator, modify_date, desc)
                VALUES ('file_sync', '*', ?, ?, ?, ?, ?, ?)
            `, [oldRaw, JSON.stringify(parsed), source, operator, nowText(), desc]);

            const existingRows = await all(db, `
                SELECT * FROM blacklist_item WHERE is_deleted = 0
            `);
            const oldMap = new Map(existingRows.map((r) => [String(r.account), rowToPublicEntry(r)]));
            const newMap = new Map(parsed.map((r) => [String(r.account), r]));

            for (const [acc, newItem] of newMap.entries()) {
                const oldItem = oldMap.get(acc);
                if (!oldItem) {
                    await run(db, `
                        INSERT INTO blacklist_item
                        (account, remark, reason, action, source, create_date, modify_date, is_deleted, desc)
                        VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
                    `, [newItem.account, newItem.remark, newItem.reason, newItem.action, source, (newItem.create_time || nowText()), nowText(), desc]);
                    await run(db, `
                        INSERT INTO blacklist_history
                        (event_type, account, before_data, after_data, source, operator, modify_date, desc)
                        VALUES ('sync_insert', ?, ?, ?, ?, ?, ?, ?)
                    `, [acc, stableJson(null), stableJson(newItem), source, operator, nowText(), desc]);
                    continue;
                }
                if (stableJson(oldItem) !== stableJson(newItem)) {
                    await run(db, `
                        UPDATE blacklist_item
                        SET remark = ?, reason = ?, create_date = ?, action = ?, source = ?, modify_date = ?, desc = ?, is_deleted = 0
                        WHERE account = ? AND is_deleted = 0
                    `, [newItem.remark, newItem.reason, (newItem.create_time || oldItem.create_time || nowText()), newItem.action, source, nowText(), desc, acc]);
                    await run(db, `
                        INSERT INTO blacklist_history
                        (event_type, account, before_data, after_data, source, operator, modify_date, desc)
                        VALUES ('sync_update', ?, ?, ?, ?, ?, ?, ?)
                    `, [acc, stableJson(oldItem), stableJson(newItem), source, operator, nowText(), desc]);
                }
            }

            for (const [acc, oldItem] of oldMap.entries()) {
                if (newMap.has(acc)) continue;
                await run(db, `
                    UPDATE blacklist_item
                    SET is_deleted = 1, modify_date = ?, desc = ?
                    WHERE account = ? AND is_deleted = 0
                `, [nowText(), desc, acc]);
                await run(db, `
                    INSERT INTO blacklist_history
                    (event_type, account, before_data, after_data, source, operator, modify_date, desc)
                    VALUES ('sync_delete', ?, ?, ?, ?, ?, ?, ?)
                `, [acc, stableJson(oldItem), stableJson(null), source, operator, nowText(), desc]);
            }

            if (oldHashRow) {
                await run(db, `
                    UPDATE blacklist_meta SET meta_value = ?, modify_date = ?, desc = ? WHERE meta_key = 'blacklist_file_hash' AND is_deleted = 0
                `, [newHash, nowText(), desc]);
            } else {
                await run(db, `
                    INSERT INTO blacklist_meta (meta_key, meta_value, modify_date, is_deleted, desc)
                    VALUES ('blacklist_file_hash', ?, ?, 0, ?)
                `, [newHash, nowText(), desc]);
            }

            if (oldRawRow) {
                await run(db, `
                    UPDATE blacklist_meta SET meta_value = ?, modify_date = ?, desc = ? WHERE meta_key = 'blacklist_file_raw' AND is_deleted = 0
                `, [JSON.stringify(parsed), nowText(), desc]);
            } else {
                await run(db, `
                    INSERT INTO blacklist_meta (meta_key, meta_value, modify_date, is_deleted, desc)
                    VALUES ('blacklist_file_raw', ?, ?, 0, ?)
                `, [JSON.stringify(parsed), nowText(), desc]);
            }

            return { changed: true, count: parsed.length };
        });
    } finally {
        db.close();
    }
}

module.exports = {
    initBlacklistDb,
    getActiveBlacklist,
    upsertBlacklistEntry,
    removeBlacklistEntry,
    exportBlacklistToFile,
    ensureBlacklistSyncedFromFile
};
