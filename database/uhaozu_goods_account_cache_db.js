const fs = require('fs');
const path = require('path');
const { openDatabase } = require('./sqlite_client');

const DEFAULT_FAIL_TTL_SEC = 3600;

const TASK_DIR = path.resolve(__dirname, '..');
const LEGACY_ACCOUNT_MAP_FILE = path.join(TASK_DIR, 'uhaozu', 'uhaozu_account_map.json');
const LEGACY_GOODS_ACCOUNT_CACHE_FILE = path.join(TASK_DIR, 'uhaozu', 'uhaozu_goods_account_cache.json');
const LEGACY_GOODS_DETAIL_FAIL_CACHE_FILE = path.join(TASK_DIR, 'uhaozu', 'uhaozu_goods_detail_fail_cache.json');

function nowText(input) {
    const d = input instanceof Date ? input : new Date(input || Date.now());
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

function normalizeText(value) {
    return String(value || '').trim();
}

function readJsonFile(filePath) {
    try {
        if (!fs.existsSync(filePath)) return {};
        const json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!json || typeof json !== 'object' || Array.isArray(json)) return {};
        return json;
    } catch {
        return {};
    }
}

function buildEmptyRecord(goodsId = '') {
    return {
        goods_id: normalizeText(goodsId),
        game_account: '',
        role_name: '',
        game_id: '',
        fail_reason: '',
        fail_expire_at: '',
        desc: ''
    };
}

function mergeText(current, next) {
    const a = normalizeText(current);
    const b = normalizeText(next);
    return b || a;
}

function mergeRecord(target, patch = {}) {
    const out = { ...target };
    out.goods_id = mergeText(out.goods_id, patch.goods_id);
    out.game_account = mergeText(out.game_account, patch.game_account);
    out.role_name = mergeText(out.role_name, patch.role_name);
    out.game_id = mergeText(out.game_id, patch.game_id);
    out.fail_reason = mergeText(out.fail_reason, patch.fail_reason);
    out.fail_expire_at = mergeText(out.fail_expire_at, patch.fail_expire_at);
    out.desc = mergeText(out.desc, patch.desc);
    return out;
}

function appendDesc(current, next) {
    const a = normalizeText(current);
    const b = normalizeText(next);
    if (!b) return a;
    if (!a) return b;
    if (a.includes(b)) return a;
    return `${a};${b}`;
}

async function createTableAndIndexes(db) {
    await run(db, `
        CREATE TABLE IF NOT EXISTS uhaozu_goods_account_cache (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            goods_id TEXT NOT NULL DEFAULT '',
            game_account TEXT NOT NULL DEFAULT '',
            role_name TEXT NOT NULL DEFAULT '',
            game_id TEXT NOT NULL DEFAULT '',
            fail_reason TEXT NOT NULL DEFAULT '',
            fail_expire_at TEXT NOT NULL DEFAULT '',
            create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            is_deleted INTEGER NOT NULL DEFAULT 0,
            desc TEXT NOT NULL DEFAULT ''
        )
    `);
    await run(db, `
        CREATE UNIQUE INDEX IF NOT EXISTS uq_uhaozu_goods_account_cache_alive
        ON uhaozu_goods_account_cache(goods_id, is_deleted)
    `);
    await run(db, `
        CREATE INDEX IF NOT EXISTS idx_uhaozu_goods_account_cache_account
        ON uhaozu_goods_account_cache(game_account, is_deleted)
    `);
}

async function tableColumns(db, tableName) {
    return await all(db, `PRAGMA table_info(${tableName})`);
}

async function loadExistingRowsV2(db) {
    const rows = await all(db, `
        SELECT goods_id, game_account, role_name, game_id, fail_reason, fail_expire_at, desc
        FROM uhaozu_goods_account_cache
        WHERE is_deleted = 0
        ORDER BY id ASC
    `);
    const map = new Map();
    for (const row of rows) {
        const goodsId = normalizeText(row.goods_id);
        if (!goodsId) continue;
        map.set(goodsId, mergeRecord(buildEmptyRecord(goodsId), row));
    }
    return map;
}

async function loadLegacyRowsV1(db) {
    const rows = await all(db, `
        SELECT cache_type, cache_key, goods_id, game_account, role_name, game_id, fail_reason, fail_expire_at, desc
        FROM uhaozu_goods_account_cache
        WHERE is_deleted = 0
        ORDER BY id ASC
    `);
    const byGoods = new Map();
    const roleByAccount = {};

    for (const row of rows) {
        const cacheType = normalizeText(row.cache_type);
        const goodsId = normalizeText(row.goods_id || row.cache_key);
        const gameAccount = normalizeText(row.game_account);
        const roleName = normalizeText(row.role_name);
        const gameId = normalizeText(row.game_id);
        if (cacheType === 'account_role' && gameAccount && roleName) {
            roleByAccount[gameAccount] = roleName;
        }
        if (!goodsId || cacheType === 'account_role') continue;
        const prev = byGoods.get(goodsId) || buildEmptyRecord(goodsId);
        let next = mergeRecord(prev, {
            goods_id: goodsId,
            game_account: gameAccount,
            role_name: roleName,
            game_id: gameId,
            fail_reason: normalizeText(row.fail_reason),
            fail_expire_at: normalizeText(row.fail_expire_at),
            desc: normalizeText(row.desc)
        });
        next.desc = appendDesc(prev.desc, normalizeText(row.desc));
        byGoods.set(goodsId, next);
    }

    for (const [goodsId, record] of byGoods.entries()) {
        if (!normalizeText(record.role_name) && normalizeText(record.game_account) && roleByAccount[record.game_account]) {
            record.role_name = normalizeText(roleByAccount[record.game_account]);
        }
        byGoods.set(goodsId, record);
    }
    return byGoods;
}

function loadLegacyJsonRecords() {
    const out = new Map();
    const roleByAccount = {};

    const accountMap = readJsonFile(LEGACY_ACCOUNT_MAP_FILE);
    for (const [gameAccount, roleName] of Object.entries(accountMap)) {
        const acc = normalizeText(gameAccount);
        const role = normalizeText(roleName);
        if (acc && role) roleByAccount[acc] = role;
    }

    const goodsAccountMap = readJsonFile(LEGACY_GOODS_ACCOUNT_CACHE_FILE);
    for (const [goodsId, gameAccount] of Object.entries(goodsAccountMap)) {
        const gid = normalizeText(goodsId);
        const acc = normalizeText(gameAccount);
        if (!gid || !acc) continue;
        const prev = out.get(gid) || buildEmptyRecord(gid);
        out.set(gid, mergeRecord(prev, {
            goods_id: gid,
            game_account: acc,
            role_name: roleByAccount[acc] || '',
            desc: 'migrate from legacy uhaozu goods/account json'
        }));
    }

    const failMap = readJsonFile(LEGACY_GOODS_DETAIL_FAIL_CACHE_FILE);
    for (const [goodsId, meta] of Object.entries(failMap)) {
        const gid = normalizeText(goodsId);
        if (!gid || !meta || typeof meta !== 'object') continue;
        const lastFailAt = Number(meta.last_fail_at || 0);
        const expireAt = lastFailAt > 0
            ? nowText(lastFailAt * 1000 + DEFAULT_FAIL_TTL_SEC * 1000)
            : '';
        const prev = out.get(gid) || buildEmptyRecord(gid);
        const next = mergeRecord(prev, {
            goods_id: gid,
            fail_reason: normalizeText(meta.reason),
            fail_expire_at: expireAt,
            desc: 'migrate from legacy uhaozu fail cache json'
        });
        next.desc = appendDesc(prev.desc, 'migrate from legacy uhaozu fail cache json');
        out.set(gid, next);
    }

    return out;
}

function mergeRecordMaps(...maps) {
    const out = new Map();
    for (const map of maps) {
        for (const [goodsId, record] of map.entries()) {
            const gid = normalizeText(goodsId);
            if (!gid) continue;
            const prev = out.get(gid) || buildEmptyRecord(gid);
            const next = mergeRecord(prev, record);
            next.desc = appendDesc(prev.desc, normalizeText(record.desc));
            out.set(gid, next);
        }
    }
    return out;
}

async function replaceRows(db, recordMap) {
    const now = nowText();
    await run(db, 'BEGIN');
    try {
        await run(db, `DELETE FROM uhaozu_goods_account_cache`);
        for (const record of recordMap.values()) {
            const goodsId = normalizeText(record.goods_id);
            if (!goodsId) continue;
            await run(db, `
                INSERT INTO uhaozu_goods_account_cache
                (goods_id, game_account, role_name, game_id, fail_reason, fail_expire_at, create_date, modify_date, is_deleted, desc)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
            `, [
                goodsId,
                normalizeText(record.game_account),
                normalizeText(record.role_name),
                normalizeText(record.game_id),
                normalizeText(record.fail_reason),
                normalizeText(record.fail_expire_at),
                now,
                now,
                normalizeText(record.desc)
            ]);
        }
        await run(db, 'COMMIT');
    } catch (e) {
        try { await run(db, 'ROLLBACK'); } catch (_) {}
        throw e;
    }
}

async function migrateToV2IfNeeded(db) {
    const cols = await tableColumns(db, 'uhaozu_goods_account_cache');
    if (cols.length === 0) {
        await createTableAndIndexes(db);
        const merged = mergeRecordMaps(loadLegacyJsonRecords());
        await replaceRows(db, merged);
        return;
    }

    const hasV1Columns = cols.some((c) => ['cache_type', 'cache_key'].includes(normalizeText(c.name)));
    if (!hasV1Columns) {
        const current = await loadExistingRowsV2(db);
        const merged = mergeRecordMaps(current, loadLegacyJsonRecords());
        await replaceRows(db, merged);
        return;
    }

    const legacyRows = await loadLegacyRowsV1(db);
    const legacyJson = loadLegacyJsonRecords();
    const merged = mergeRecordMaps(legacyRows, legacyJson);

    await run(db, `ALTER TABLE uhaozu_goods_account_cache RENAME TO uhaozu_goods_account_cache_old`);
    await createTableAndIndexes(db);
    await replaceRows(db, merged);
    await run(db, `DROP TABLE uhaozu_goods_account_cache_old`);
}

async function upsertRowByGoodsId(db, input = {}) {
    const goodsId = normalizeText(input.goods_id);
    if (!goodsId) throw new Error('goods_id 不能为空');
    const now = nowText();
    const row = await get(db, `
        SELECT id, game_account, role_name, game_id, fail_reason, fail_expire_at, desc
        FROM uhaozu_goods_account_cache
        WHERE goods_id = ? AND is_deleted = 0
        LIMIT 1
    `, [goodsId]);

    const next = mergeRecord(row || buildEmptyRecord(goodsId), {
        goods_id: goodsId,
        game_account: input.game_account,
        role_name: input.role_name,
        game_id: input.game_id,
        fail_reason: input.fail_reason,
        fail_expire_at: input.fail_expire_at,
        desc: input.desc
    });
    next.desc = appendDesc(normalizeText(row && row.desc), normalizeText(input.desc));

    if (!row) {
        await run(db, `
            INSERT INTO uhaozu_goods_account_cache
            (goods_id, game_account, role_name, game_id, fail_reason, fail_expire_at, create_date, modify_date, is_deleted, desc)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        `, [goodsId, next.game_account, next.role_name, next.game_id, next.fail_reason, next.fail_expire_at, now, now, next.desc]);
        return;
    }

    await run(db, `
        UPDATE uhaozu_goods_account_cache
        SET game_account = ?,
            role_name = ?,
            game_id = ?,
            fail_reason = ?,
            fail_expire_at = ?,
            modify_date = ?,
            desc = ?,
            is_deleted = 0
        WHERE id = ?
    `, [next.game_account, next.role_name, next.game_id, next.fail_reason, next.fail_expire_at, now, next.desc, Number(row.id)]);
}

let initPromise = null;
async function initUhaozuGoodsAccountCacheDb() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
        const db = openDatabase();
        try {
            await createTableAndIndexes(db);
        } finally {
            db.close();
        }
    })();
    return initPromise;
}

async function listUhaozuResolvedGoodsCache() {
    await initUhaozuGoodsAccountCacheDb();
    const db = openDatabase();
    try {
        return await all(db, `
            SELECT *
            FROM uhaozu_goods_account_cache
            WHERE is_deleted = 0
              AND TRIM(COALESCE(game_account, '')) <> ''
            ORDER BY id ASC
        `);
    } finally {
        db.close();
    }
}

async function listUhaozuAccountRoleCache() {
    await initUhaozuGoodsAccountCacheDb();
    const db = openDatabase();
    try {
        return await all(db, `
            SELECT MIN(id) AS id,
                   '' AS goods_id,
                   game_account,
                   role_name,
                   MAX(game_id) AS game_id,
                   '' AS fail_reason,
                   '' AS fail_expire_at,
                   MIN(create_date) AS create_date,
                   MAX(modify_date) AS modify_date,
                   0 AS is_deleted,
                   '' AS desc
            FROM uhaozu_goods_account_cache
            WHERE is_deleted = 0
              AND TRIM(COALESCE(game_account, '')) <> ''
              AND TRIM(COALESCE(role_name, '')) <> ''
            GROUP BY game_account, role_name
            ORDER BY id ASC
        `);
    } finally {
        db.close();
    }
}

async function listUhaozuActiveGoodsDetailFailCache(now = nowText()) {
    await initUhaozuGoodsAccountCacheDb();
    const db = openDatabase();
    try {
        return await all(db, `
            SELECT *
            FROM uhaozu_goods_account_cache
            WHERE is_deleted = 0
              AND TRIM(COALESCE(fail_expire_at, '')) <> ''
              AND fail_expire_at > ?
            ORDER BY id ASC
        `, [normalizeText(now)]);
    } finally {
        db.close();
    }
}

async function upsertUhaozuGoodsResolved(input = {}) {
    await initUhaozuGoodsAccountCacheDb();
    const goodsId = normalizeText(input.goods_id);
    const gameAccount = normalizeText(input.game_account);
    if (!goodsId) throw new Error('goods_id 不能为空');
    if (!gameAccount) throw new Error('game_account 不能为空');

    const db = openDatabase();
    try {
        await upsertRowByGoodsId(db, {
            goods_id: goodsId,
            game_account: gameAccount,
            role_name: normalizeText(input.role_name),
            game_id: normalizeText(input.game_id),
            fail_reason: '',
            fail_expire_at: '',
            desc: normalizeText(input.desc || 'upsert resolved goods account cache')
        });
    } finally {
        db.close();
    }
}

async function upsertUhaozuGoodsDetailFail(input = {}) {
    await initUhaozuGoodsAccountCacheDb();
    const goodsId = normalizeText(input.goods_id);
    if (!goodsId) throw new Error('goods_id 不能为空');
    const db = openDatabase();
    try {
        await upsertRowByGoodsId(db, {
            goods_id: goodsId,
            fail_reason: normalizeText(input.fail_reason),
            fail_expire_at: normalizeText(input.fail_expire_at),
            desc: normalizeText(input.desc || 'upsert goods detail fail cache')
        });
    } finally {
        db.close();
    }
}

module.exports = {
    DEFAULT_FAIL_TTL_SEC,
    nowText,
    initUhaozuGoodsAccountCacheDb,
    listUhaozuResolvedGoodsCache,
    listUhaozuAccountRoleCache,
    listUhaozuActiveGoodsDetailFailCache,
    upsertUhaozuGoodsResolved,
    upsertUhaozuGoodsDetailFail,
    _internal: {
        run,
        get,
        all,
        createTableAndIndexes,
        tableColumns,
        migrateToV2IfNeeded,
        loadExistingRowsV2,
        loadLegacyRowsV1,
        loadLegacyJsonRecords,
        mergeRecordMaps,
        replaceRows
    }
};
