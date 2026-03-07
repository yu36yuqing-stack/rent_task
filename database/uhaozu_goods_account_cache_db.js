const fs = require('fs');
const path = require('path');
const { openDatabase } = require('./sqlite_client');

const CACHE_TYPE_ACCOUNT_ROLE = 'account_role';
const CACHE_TYPE_GOODS_RESOLVED = 'goods_resolved';
const CACHE_TYPE_GOODS_DETAIL_FAIL = 'goods_detail_fail';
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

async function upsertCacheRecord(db, input = {}) {
    const cacheType = normalizeText(input.cache_type);
    const cacheKey = normalizeText(input.cache_key);
    if (!cacheType) throw new Error('cache_type 不能为空');
    if (!cacheKey) throw new Error('cache_key 不能为空');

    const goodsId = normalizeText(input.goods_id || cacheKey);
    const gameAccount = normalizeText(input.game_account);
    const roleName = normalizeText(input.role_name);
    const gameId = normalizeText(input.game_id);
    const failReason = normalizeText(input.fail_reason);
    const failExpireAt = normalizeText(input.fail_expire_at);
    const desc = normalizeText(input.desc);
    const now = nowText();

    const row = await get(db, `
        SELECT id
        FROM uhaozu_goods_account_cache
        WHERE cache_type = ? AND cache_key = ? AND is_deleted = 0
        LIMIT 1
    `, [cacheType, cacheKey]);

    if (!row) {
        await run(db, `
            INSERT INTO uhaozu_goods_account_cache
            (cache_type, cache_key, goods_id, game_account, role_name, game_id, fail_reason, fail_expire_at, create_date, modify_date, is_deleted, desc)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        `, [cacheType, cacheKey, goodsId, gameAccount, roleName, gameId, failReason, failExpireAt, now, now, desc]);
        return;
    }

    await run(db, `
        UPDATE uhaozu_goods_account_cache
        SET goods_id = ?, game_account = ?, role_name = ?, game_id = ?, fail_reason = ?, fail_expire_at = ?, modify_date = ?, desc = ?, is_deleted = 0
        WHERE id = ?
    `, [goodsId, gameAccount, roleName, gameId, failReason, failExpireAt, now, desc, Number(row.id)]);
}

async function migrateLegacyJsonFiles(db) {
    const accountMap = readJsonFile(LEGACY_ACCOUNT_MAP_FILE);
    for (const [gameAccount, roleName] of Object.entries(accountMap)) {
        const acc = normalizeText(gameAccount);
        const role = normalizeText(roleName);
        if (!acc || !role) continue;
        await upsertCacheRecord(db, {
            cache_type: CACHE_TYPE_ACCOUNT_ROLE,
            cache_key: acc,
            game_account: acc,
            role_name: role,
            desc: 'migrate from legacy account map json'
        });
    }

    const goodsAccountMap = readJsonFile(LEGACY_GOODS_ACCOUNT_CACHE_FILE);
    for (const [goodsId, gameAccount] of Object.entries(goodsAccountMap)) {
        const gid = normalizeText(goodsId);
        const acc = normalizeText(gameAccount);
        if (!gid || !acc) continue;
        await upsertCacheRecord(db, {
            cache_type: CACHE_TYPE_GOODS_RESOLVED,
            cache_key: gid,
            goods_id: gid,
            game_account: acc,
            desc: 'migrate from legacy goods account cache json'
        });
    }

    const failMap = readJsonFile(LEGACY_GOODS_DETAIL_FAIL_CACHE_FILE);
    for (const [goodsId, meta] of Object.entries(failMap)) {
        const gid = normalizeText(goodsId);
        if (!gid || !meta || typeof meta !== 'object') continue;
        const lastFailAt = Number(meta.last_fail_at || 0);
        const expireAt = lastFailAt > 0
            ? nowText(lastFailAt * 1000 + DEFAULT_FAIL_TTL_SEC * 1000)
            : '';
        await upsertCacheRecord(db, {
            cache_type: CACHE_TYPE_GOODS_DETAIL_FAIL,
            cache_key: gid,
            goods_id: gid,
            fail_reason: normalizeText(meta.reason),
            fail_expire_at: expireAt,
            desc: 'migrate from legacy goods detail fail cache json'
        });
    }
}

let initPromise = null;
async function initUhaozuGoodsAccountCacheDb() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
        const db = openDatabase();
        try {
            await run(db, `
                CREATE TABLE IF NOT EXISTS uhaozu_goods_account_cache (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    cache_type TEXT NOT NULL DEFAULT '',
                    cache_key TEXT NOT NULL DEFAULT '',
                    goods_id TEXT NOT NULL DEFAULT '',
                    game_account TEXT NOT NULL DEFAULT '',
                    role_name TEXT NOT NULL DEFAULT '',
                    game_id TEXT NOT NULL DEFAULT '',
                    fail_reason TEXT NOT NULL DEFAULT '',
                    fail_expire_at TEXT NOT NULL DEFAULT '',
                    create_date TEXT NOT NULL,
                    modify_date TEXT NOT NULL,
                    is_deleted INTEGER NOT NULL DEFAULT 0,
                    desc TEXT NOT NULL DEFAULT ''
                )
            `);
            await run(db, `
                CREATE UNIQUE INDEX IF NOT EXISTS uq_uhaozu_goods_account_cache_alive
                ON uhaozu_goods_account_cache(cache_type, cache_key, is_deleted)
            `);
            await run(db, `
                CREATE INDEX IF NOT EXISTS idx_uhaozu_goods_account_cache_account
                ON uhaozu_goods_account_cache(game_account, is_deleted)
            `);
            await migrateLegacyJsonFiles(db);
        } finally {
            db.close();
        }
    })();
    return initPromise;
}

async function listUhaozuCacheByType(cacheType) {
    await initUhaozuGoodsAccountCacheDb();
    const db = openDatabase();
    try {
        return await all(db, `
            SELECT *
            FROM uhaozu_goods_account_cache
            WHERE cache_type = ? AND is_deleted = 0
            ORDER BY id ASC
        `, [normalizeText(cacheType)]);
    } finally {
        db.close();
    }
}

async function listUhaozuResolvedGoodsCache() {
    const rows = await listUhaozuCacheByType(CACHE_TYPE_GOODS_RESOLVED);
    return rows.filter((row) => normalizeText(row.game_account));
}

async function listUhaozuAccountRoleCache() {
    const rows = await listUhaozuCacheByType(CACHE_TYPE_ACCOUNT_ROLE);
    return rows.filter((row) => normalizeText(row.game_account) && normalizeText(row.role_name));
}

async function listUhaozuActiveGoodsDetailFailCache(now = nowText()) {
    const rows = await listUhaozuCacheByType(CACHE_TYPE_GOODS_DETAIL_FAIL);
    return rows.filter((row) => {
        const expireAt = normalizeText(row.fail_expire_at);
        return expireAt && expireAt > now;
    });
}

async function upsertUhaozuGoodsResolved(input = {}) {
    await initUhaozuGoodsAccountCacheDb();
    const db = openDatabase();
    try {
        const goodsId = normalizeText(input.goods_id);
        const gameAccount = normalizeText(input.game_account);
        if (!goodsId) throw new Error('goods_id 不能为空');
        if (!gameAccount) throw new Error('game_account 不能为空');

        await upsertCacheRecord(db, {
            cache_type: CACHE_TYPE_GOODS_RESOLVED,
            cache_key: goodsId,
            goods_id: goodsId,
            game_account: gameAccount,
            role_name: normalizeText(input.role_name),
            game_id: normalizeText(input.game_id),
            desc: normalizeText(input.desc || 'upsert resolved goods account cache')
        });

        if (normalizeText(input.role_name)) {
            await upsertCacheRecord(db, {
                cache_type: CACHE_TYPE_ACCOUNT_ROLE,
                cache_key: gameAccount,
                game_account: gameAccount,
                role_name: normalizeText(input.role_name),
                game_id: normalizeText(input.game_id),
                desc: normalizeText(input.desc || 'upsert resolved goods account cache')
            });
        }

        await run(db, `
            UPDATE uhaozu_goods_account_cache
            SET is_deleted = 1, modify_date = ?, desc = ?
            WHERE cache_type = ? AND cache_key = ? AND is_deleted = 0
        `, [nowText(), normalizeText(input.desc || 'clear fail cache after resolve'), CACHE_TYPE_GOODS_DETAIL_FAIL, goodsId]);
    } finally {
        db.close();
    }
}

async function upsertUhaozuGoodsDetailFail(input = {}) {
    await initUhaozuGoodsAccountCacheDb();
    const db = openDatabase();
    try {
        const goodsId = normalizeText(input.goods_id);
        if (!goodsId) throw new Error('goods_id 不能为空');
        await upsertCacheRecord(db, {
            cache_type: CACHE_TYPE_GOODS_DETAIL_FAIL,
            cache_key: goodsId,
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
    CACHE_TYPE_ACCOUNT_ROLE,
    CACHE_TYPE_GOODS_RESOLVED,
    CACHE_TYPE_GOODS_DETAIL_FAIL,
    DEFAULT_FAIL_TTL_SEC,
    nowText,
    initUhaozuGoodsAccountCacheDb,
    listUhaozuResolvedGoodsCache,
    listUhaozuAccountRoleCache,
    listUhaozuActiveGoodsDetailFailCache,
    upsertUhaozuGoodsResolved,
    upsertUhaozuGoodsDetailFail
};
