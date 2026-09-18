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

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

function toRule(row = {}) {
    return {
        id: Number(row.id || 0),
        user_id: Number(row.user_id || 0),
        game_id: String(row.game_id || '').trim(),
        game_name: String(row.game_name || '').trim(),
        game_account: String(row.game_account || '').trim(),
        prices: [
            Number(row.price_order_1 || 0),
            Number(row.price_order_2 || 0),
            Number(row.price_order_3 || 0),
            Number(row.price_order_4 || 0)
        ],
        version: Number(row.version || 0),
        copied_from_game_account: String(row.copied_from_game_account || '').trim(),
        create_date: String(row.create_date || '').trim(),
        modify_date: String(row.modify_date || '').trim(),
        is_deleted: Number(row.is_deleted || 0),
        desc: String(row.desc || '').trim()
    };
}

async function initAccountPriceLadderRuleDb() {
    const db = openPriceDatabase();
    try {
        await run(db, `
            CREATE TABLE IF NOT EXISTS account_price_ladder_rule (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                game_id TEXT NOT NULL,
                game_name TEXT NOT NULL,
                game_account TEXT NOT NULL,
                price_order_1 REAL NOT NULL,
                price_order_2 REAL NOT NULL,
                price_order_3 REAL NOT NULL,
                price_order_4 REAL NOT NULL,
                version INTEGER NOT NULL DEFAULT 1,
                copied_from_game_account TEXT NOT NULL DEFAULT '',
                create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        await run(db, `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_account_price_ladder_rule_alive
            ON account_price_ladder_rule(user_id, game_id, game_account)
            WHERE is_deleted = 0
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_account_price_ladder_rule_user_game
            ON account_price_ladder_rule(user_id, game_id, is_deleted)
        `);
    } finally {
        db.close();
    }
}

async function getAccountPriceLadderRule(userId, gameId, gameAccount) {
    await initAccountPriceLadderRuleDb();
    const uid = Number(userId || 0);
    const gid = String(gameId || '').trim();
    const account = String(gameAccount || '').trim();
    if (!uid || !gid || !account) return null;
    const db = openPriceDatabase();
    try {
        const row = await get(db, `
            SELECT *
            FROM account_price_ladder_rule
            WHERE user_id = ? AND game_id = ? AND game_account = ? AND is_deleted = 0
            LIMIT 1
        `, [uid, gid, account]);
        return row ? toRule(row) : null;
    } finally {
        db.close();
    }
}

async function listAccountPriceLadderRules(userId, gameId) {
    await initAccountPriceLadderRuleDb();
    const uid = Number(userId || 0);
    const gid = String(gameId || '').trim();
    if (!uid || !gid) return [];
    const db = openPriceDatabase();
    try {
        const rows = await all(db, `
            SELECT *
            FROM account_price_ladder_rule
            WHERE user_id = ? AND game_id = ? AND is_deleted = 0
            ORDER BY id ASC
        `, [uid, gid]);
        return rows.map(toRule);
    } finally {
        db.close();
    }
}

async function listAccountPriceLadderRulesByUser(userId) {
    await initAccountPriceLadderRuleDb();
    const uid = Number(userId || 0);
    if (!uid) return [];
    const db = openPriceDatabase();
    try {
        const rows = await all(db, `
            SELECT *
            FROM account_price_ladder_rule
            WHERE user_id = ? AND is_deleted = 0
            ORDER BY id ASC
        `, [uid]);
        return rows.map(toRule);
    } finally {
        db.close();
    }
}

async function upsertAccountPriceLadderRule(userId, input = {}, options = {}) {
    await initAccountPriceLadderRuleDb();
    const uid = Number(userId || 0);
    const gameId = String(input.game_id || '').trim();
    const gameName = String(input.game_name || '').trim();
    const gameAccount = String(input.game_account || '').trim();
    const prices = Array.isArray(input.prices) ? input.prices.map(Number) : [];
    const expectedVersion = options.expected_version == null || options.expected_version === ''
        ? null
        : Number(options.expected_version);
    const copiedFrom = String(input.copied_from_game_account || '').trim();
    const desc = String(options.desc || input.desc || '').trim();
    if (!uid) throw new Error('user_id 不合法');
    if (!gameId) throw new Error('game_id 不能为空');
    if (!gameName) throw new Error('game_name 不能为空');
    if (!gameAccount) throw new Error('game_account 不能为空');
    if (prices.length !== 4 || prices.some((value) => !Number.isFinite(value) || value <= 0)) {
        throw new Error('四档价格必须是大于 0 的数字');
    }
    if (expectedVersion !== null && (!Number.isInteger(expectedVersion) || expectedVersion < 0)) {
        throw new Error('expected_version 不合法');
    }

    const db = openPriceDatabase();
    try {
        const exists = await get(db, `
            SELECT id, version
            FROM account_price_ladder_rule
            WHERE user_id = ? AND game_id = ? AND game_account = ? AND is_deleted = 0
            LIMIT 1
        `, [uid, gameId, gameAccount]);
        const now = nowText();
        if (!exists) {
            if (expectedVersion !== null && expectedVersion !== 0) {
                const err = new Error('配置已变化，请刷新后重试');
                err.code = 'PRICE_LADDER_VERSION_CONFLICT';
                throw err;
            }
            await run(db, `
                INSERT INTO account_price_ladder_rule
                (user_id, game_id, game_name, game_account, price_order_1, price_order_2, price_order_3, price_order_4,
                 version, copied_from_game_account, create_date, modify_date, is_deleted, desc)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, 0, ?)
            `, [uid, gameId, gameName, gameAccount, ...prices, copiedFrom, now, now, desc]);
        } else {
            const currentVersion = Number(exists.version || 0);
            if (expectedVersion !== null && expectedVersion !== currentVersion) {
                const err = new Error('配置已变化，请刷新后重试');
                err.code = 'PRICE_LADDER_VERSION_CONFLICT';
                throw err;
            }
            await run(db, `
                UPDATE account_price_ladder_rule
                SET game_name = ?, price_order_1 = ?, price_order_2 = ?, price_order_3 = ?, price_order_4 = ?,
                    version = version + 1, copied_from_game_account = ?, modify_date = ?, desc = ?
                WHERE id = ?
            `, [gameName, ...prices, copiedFrom, now, desc, Number(exists.id)]);
        }
        return getAccountPriceLadderRule(uid, gameId, gameAccount);
    } finally {
        db.close();
    }
}

async function clearAccountPriceLadderConfiguration(userId, input = {}, options = {}) {
    await initAccountPriceLadderRuleDb();
    const uid = Number(userId || 0);
    const gameId = String(input.game_id || '').trim();
    const gameAccount = String(input.game_account || '').trim();
    const expectedVersion = options.expected_version == null || options.expected_version === ''
        ? null
        : Number(options.expected_version);
    if (!uid) throw new Error('user_id 不合法');
    if (!gameId || !gameAccount) throw new Error('阶梯配置账号信息不完整');
    if (expectedVersion !== null && (!Number.isInteger(expectedVersion) || expectedVersion < 0)) {
        throw new Error('expected_version 不合法');
    }
    const db = openPriceDatabase();
    try {
        await run(db, 'BEGIN IMMEDIATE');
        const current = await get(db, `
            SELECT id, version
            FROM account_price_ladder_rule
            WHERE user_id = ? AND game_id = ? AND game_account = ? AND is_deleted = 0
            LIMIT 1
        `, [uid, gameId, gameAccount]);
        const currentVersion = Number(current && current.version || 0);
        if (expectedVersion !== null && expectedVersion !== currentVersion) {
            const err = new Error('配置已变化，请刷新后重试');
            err.code = 'PRICE_LADDER_VERSION_CONFLICT';
            throw err;
        }
        const now = nowText();
        if (current) {
            await run(db, `
                UPDATE account_price_ladder_rule
                SET is_deleted = 1, version = version + 1, modify_date = ?, desc = ?
                WHERE id = ?
            `, [now, String(options.desc || 'cleared by h5 account price ladder').trim(), Number(current.id)]);
        }
        await run(db, `
            UPDATE account_price_ladder_runtime
            SET is_deleted = 1, modify_date = ?, desc = ?
            WHERE user_id = ? AND game_id = ? AND game_account = ? AND is_deleted = 0
        `, [now, 'disabled because ladder configuration was cleared', uid, gameId, gameAccount]);
        await run(db, `
            UPDATE account_channel_price_baseline
            SET is_deleted = 1, modify_date = ?, desc = ?
            WHERE user_id = ? AND game_id = ? AND game_account = ? AND is_deleted = 0
        `, [now, 'invalidated because ladder configuration was cleared', uid, gameId, gameAccount]);
        await run(db, 'COMMIT');
        return {
            user_id: uid,
            game_id: gameId,
            game_account: gameAccount,
            configured: false,
            version: 0,
            cleared: Boolean(current)
        };
    } catch (err) {
        await run(db, 'ROLLBACK').catch(() => {});
        throw err;
    } finally {
        db.close();
    }
}

module.exports = {
    initAccountPriceLadderRuleDb,
    getAccountPriceLadderRule,
    listAccountPriceLadderRules,
    listAccountPriceLadderRulesByUser,
    upsertAccountPriceLadderRule,
    clearAccountPriceLadderConfiguration,
    _internal: {
        nowText,
        toRule,
        run,
        get,
        all
    }
};
