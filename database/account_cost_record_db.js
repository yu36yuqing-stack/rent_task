const { openMainDatabase, openStatsDatabase } = require('./sqlite_client');
const { canonicalGameId, canonicalGameNameById } = require('../common/game_profile');

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

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

function rowToCostRecord(row = {}) {
    return {
        id: Number(row.id || 0),
        user_id: Number(row.user_id || 0),
        game_id: canonicalGameId(row.game_id, row.game_name),
        game_name: canonicalGameNameById(row.game_id, row.game_name),
        game_account: String(row.game_account || ''),
        cost_amount: Number(row.cost_amount || 0),
        cost_date: String(row.cost_date || '').slice(0, 10),
        cost_type: String(row.cost_type || 'other').trim() || 'other',
        cost_desc: String(row.cost_desc || ''),
        create_date: String(row.create_date || ''),
        modify_date: String(row.modify_date || ''),
        is_deleted: Number(row.is_deleted || 0),
        desc: String(row.desc || '')
    };
}

async function initAccountCostRecordDb() {
    const db = openStatsDatabase();
    try {
        await run(db, `
            CREATE TABLE IF NOT EXISTS account_cost_record (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                game_id TEXT NOT NULL DEFAULT '1',
                game_name TEXT NOT NULL DEFAULT 'WZRY',
                game_account TEXT NOT NULL DEFAULT '',
                cost_amount REAL NOT NULL DEFAULT 0,
                cost_date TEXT NOT NULL DEFAULT '',
                cost_type TEXT NOT NULL DEFAULT 'other',
                cost_desc TEXT NOT NULL DEFAULT '',
                create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_account_cost_record_user_account_date_alive
            ON account_cost_record(user_id, game_id, game_account, cost_date, is_deleted)
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_account_cost_record_user_type_alive
            ON account_cost_record(user_id, game_id, game_account, cost_type, is_deleted)
        `);
    } finally {
        db.close();
    }
}

async function migrateAccountCostRecordFromMainToStatsIfNeeded() {
    await initAccountCostRecordDb();
    const mainDb = openMainDatabase();
    const statsDb = openStatsDatabase();
    try {
        const mainTable = await get(mainDb, `
            SELECT name
            FROM sqlite_master
            WHERE type = 'table' AND name = 'account_cost_record'
            LIMIT 1
        `);
        if (!mainTable) return { migrated: 0 };

        const rows = await all(mainDb, `
            SELECT *
            FROM account_cost_record
            ORDER BY id ASC
        `);
        if (rows.length === 0) {
            await run(mainDb, `DROP TABLE IF EXISTS account_cost_record`);
            return { migrated: 0 };
        }

        for (const row of rows) {
            const exists = await get(statsDb, `
                SELECT id
                FROM account_cost_record
                WHERE user_id = ? AND game_id = ? AND game_account = ? AND cost_type = ? AND cost_date = ? AND cost_amount = ? AND is_deleted = ?
                LIMIT 1
            `, [
                Number(row.user_id || 0),
                canonicalGameId(row.game_id, row.game_name || 'WZRY'),
                String(row.game_account || '').trim(),
                String(row.cost_type || 'other').trim() || 'other',
                String(row.cost_date || '').slice(0, 10),
                Number(Number(row.cost_amount || 0).toFixed(2)),
                Number(row.is_deleted || 0)
            ]);
            if (exists) continue;
            await run(statsDb, `
                INSERT INTO account_cost_record
                (user_id, game_id, game_name, game_account, cost_amount, cost_date, cost_type, cost_desc, create_date, modify_date, is_deleted, desc)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
                Number(row.user_id || 0),
                canonicalGameId(row.game_id, row.game_name || 'WZRY'),
                canonicalGameNameById(row.game_id, row.game_name || 'WZRY'),
                String(row.game_account || '').trim(),
                Number(Number(row.cost_amount || 0).toFixed(2)),
                String(row.cost_date || '').slice(0, 10),
                String(row.cost_type || 'other').trim() || 'other',
                String(row.cost_desc || ''),
                String(row.create_date || nowText()),
                String(row.modify_date || nowText()),
                Number(row.is_deleted || 0),
                String(row.desc || '')
            ]);
        }
        await run(mainDb, `DROP TABLE IF EXISTS account_cost_record`);
        return { migrated: rows.length };
    } finally {
        mainDb.close();
        statsDb.close();
    }
}

async function backfillPurchaseCostRecordsFromUserGameAccount() {
    await initAccountCostRecordDb();
    const mainDb = openMainDatabase();
    const statsDb = openStatsDatabase();
    try {
        const rows = await all(mainDb, `
            SELECT uga.user_id, uga.game_id, uga.game_name, uga.game_account, uga.purchase_price, uga.purchase_date
            FROM user_game_account uga
            WHERE uga.is_deleted = 0
              AND uga.purchase_price > 0
              AND uga.purchase_date GLOB '????-??-??'
        `);
        const rowsNeedInsert = [];
        for (const row of rows) {
            const existed = await get(statsDb, `
                SELECT id
                FROM account_cost_record
                WHERE user_id = ? AND game_id = ? AND game_account = ? AND cost_type = 'purchase' AND is_deleted = 0
                LIMIT 1
            `, [
                Number(row.user_id || 0),
                canonicalGameId(row.game_id, row.game_name || 'WZRY'),
                String(row.game_account || '').trim()
            ]);
            if (!existed) rowsNeedInsert.push(row);
        }
        const now = nowText();
        for (const row of rowsNeedInsert) {
            await run(statsDb, `
                INSERT INTO account_cost_record
                (user_id, game_id, game_name, game_account, cost_amount, cost_date, cost_type, cost_desc, create_date, modify_date, is_deleted, desc)
                VALUES (?, ?, ?, ?, ?, ?, 'purchase', '', ?, ?, 0, 'backfill purchase from user_game_account')
            `, [
                Number(row.user_id || 0),
                canonicalGameId(row.game_id, row.game_name || 'WZRY'),
                canonicalGameNameById(row.game_id, row.game_name || 'WZRY'),
                String(row.game_account || '').trim(),
                Number(Number(row.purchase_price || 0).toFixed(2)),
                String(row.purchase_date || '').slice(0, 10),
                now,
                now
            ]);
        }
        const mainRows = await all(mainDb, `
            SELECT id, user_id, game_id, game_name, game_account
            FROM user_game_account
            WHERE is_deleted = 0
        `);
        for (const row of mainRows) {
            const totalRow = await get(statsDb, `
                SELECT ROUND(COALESCE(SUM(cost_amount), 0), 2) AS total
                FROM account_cost_record
                WHERE user_id = ? AND game_id = ? AND game_account = ? AND is_deleted = 0
            `, [
                Number(row.user_id || 0),
                canonicalGameId(row.game_id, row.game_name || 'WZRY'),
                String(row.game_account || '').trim()
            ]);
            await run(mainDb, `
                UPDATE user_game_account
                SET total_cost_amount = ?
                WHERE id = ?
            `, [Number(totalRow && totalRow.total ? totalRow.total : 0), Number(row.id)]);
        }
        return { inserted: rowsNeedInsert.length };
    } finally {
        mainDb.close();
        statsDb.close();
    }
}

async function createAccountCostRecord(input = {}) {
    await initAccountCostRecordDb();
    const userId = Number(input.user_id || 0);
    const gameAccount = String(input.game_account || '').trim();
    const gameId = canonicalGameId(input.game_id, input.game_name || 'WZRY');
    const gameName = canonicalGameNameById(gameId, input.game_name || 'WZRY');
    const costAmount = Number(input.cost_amount || 0);
    const costDate = String(input.cost_date || '').trim();
    const costType = String(input.cost_type || 'other').trim() || 'other';
    const costDesc = String(input.cost_desc || '').trim();
    const desc = String(input.desc || '').trim();
    if (!userId) throw new Error('user_id 不合法');
    if (!gameAccount) throw new Error('game_account 不能为空');
    if (!Number.isFinite(costAmount) || costAmount < 0) throw new Error('cost_amount 不合法');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(costDate)) throw new Error('cost_date 格式不合法');

    const db = openStatsDatabase();
    try {
        const now = nowText();
        const out = await run(db, `
            INSERT INTO account_cost_record
            (user_id, game_id, game_name, game_account, cost_amount, cost_date, cost_type, cost_desc, create_date, modify_date, is_deleted, desc)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        `, [
            userId,
            gameId,
            gameName,
            gameAccount,
            Number(costAmount.toFixed(2)),
            costDate,
            costType,
            costDesc,
            now,
            now,
            desc
        ]);
        const row = await get(db, `SELECT * FROM account_cost_record WHERE id = ? LIMIT 1`, [Number(out.lastID)]);
        return rowToCostRecord(row);
    } finally {
        db.close();
    }
}

async function getActivePurchaseCostRecord(userId, gameId = '', gameAccount = '') {
    await initAccountCostRecordDb();
    const uid = Number(userId || 0);
    const gid = canonicalGameId(gameId, 'WZRY');
    const acc = String(gameAccount || '').trim();
    if (!uid || !acc) return null;
    const db = openStatsDatabase();
    try {
        const row = await get(db, `
            SELECT *
            FROM account_cost_record
            WHERE user_id = ? AND game_id = ? AND game_account = ? AND cost_type = 'purchase' AND is_deleted = 0
            ORDER BY id DESC
            LIMIT 1
        `, [uid, gid, acc]);
        return row ? rowToCostRecord(row) : null;
    } finally {
        db.close();
    }
}

async function upsertPurchaseCostRecord(input = {}) {
    await initAccountCostRecordDb();
    const userId = Number(input.user_id || 0);
    const gameAccount = String(input.game_account || '').trim();
    const gameId = canonicalGameId(input.game_id, input.game_name || 'WZRY');
    const gameName = canonicalGameNameById(gameId, input.game_name || 'WZRY');
    const costAmount = Number(input.cost_amount || 0);
    const costDate = String(input.cost_date || '').trim();
    const costDesc = String(input.cost_desc || '').trim();
    const desc = String(input.desc || '').trim();
    if (!userId) throw new Error('user_id 不合法');
    if (!gameAccount) throw new Error('game_account 不能为空');
    if (!Number.isFinite(costAmount) || costAmount < 0) throw new Error('cost_amount 不合法');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(costDate)) throw new Error('cost_date 格式不合法');

    const db = openStatsDatabase();
    try {
        const existed = await get(db, `
            SELECT id
            FROM account_cost_record
            WHERE user_id = ? AND game_id = ? AND game_account = ? AND cost_type = 'purchase' AND is_deleted = 0
            ORDER BY id DESC
            LIMIT 1
        `, [userId, gameId, gameAccount]);
        const now = nowText();
        if (existed) {
            await run(db, `
                UPDATE account_cost_record
                SET cost_amount = ?, cost_date = ?, cost_desc = ?, modify_date = ?, desc = ?
                WHERE id = ?
            `, [Number(costAmount.toFixed(2)), costDate, costDesc, now, desc, Number(existed.id)]);
            const row = await get(db, `SELECT * FROM account_cost_record WHERE id = ? LIMIT 1`, [Number(existed.id)]);
            return rowToCostRecord(row);
        }
        const out = await run(db, `
            INSERT INTO account_cost_record
            (user_id, game_id, game_name, game_account, cost_amount, cost_date, cost_type, cost_desc, create_date, modify_date, is_deleted, desc)
            VALUES (?, ?, ?, ?, ?, ?, 'purchase', ?, ?, ?, 0, ?)
        `, [
            userId,
            gameId,
            gameName,
            gameAccount,
            Number(costAmount.toFixed(2)),
            costDate,
            costDesc,
            now,
            now,
            desc
        ]);
        const row = await get(db, `SELECT * FROM account_cost_record WHERE id = ? LIMIT 1`, [Number(out.lastID)]);
        return rowToCostRecord(row);
    } finally {
        db.close();
    }
}

async function listAccountCostRecordsByUserAndAccount(userId, gameId = '', gameAccount = '', opts = {}) {
    await initAccountCostRecordDb();
    const uid = Number(userId || 0);
    const gid = String(gameId || '').trim();
    const acc = String(gameAccount || '').trim();
    const limit = Math.max(1, Math.min(100, Number(opts.limit || 20)));
    const costType = String(opts.cost_type || '').trim().toLowerCase();
    const allGames = Boolean(opts.all_games);
    if (!uid || !acc) return [];
    const db = openStatsDatabase();
    try {
        const params = [uid, acc];
        let sql = `
            SELECT *
            FROM account_cost_record
            WHERE user_id = ? AND game_account = ? AND is_deleted = 0
        `;
        if (!allGames) {
            sql += ` AND game_id = ?`;
            params.push(canonicalGameId(gid, 'WZRY'));
        }
        if (costType) {
            sql += ` AND cost_type = ?`;
            params.push(costType);
        }
        sql += ` ORDER BY cost_date DESC, id DESC LIMIT ?`;
        params.push(limit);
        const rows = await all(db, sql, params);
        return rows.map(rowToCostRecord);
    } finally {
        db.close();
    }
}

async function sumAccountCostAmountByUserAndAccount(userId, gameId = '', gameAccount = '') {
    await initAccountCostRecordDb();
    const uid = Number(userId || 0);
    const gid = canonicalGameId(gameId, 'WZRY');
    const acc = String(gameAccount || '').trim();
    if (!uid || !acc) return 0;
    const db = openStatsDatabase();
    try {
        const row = await get(db, `
            SELECT ROUND(COALESCE(SUM(cost_amount), 0), 2) AS total
            FROM account_cost_record
            WHERE user_id = ? AND game_id = ? AND game_account = ? AND is_deleted = 0
        `, [uid, gid, acc]);
        return Number(row && row.total ? row.total : 0);
    } finally {
        db.close();
    }
}

async function softDeleteAccountCostRecordById(userId, recordId, opts = {}) {
    await initAccountCostRecordDb();
    const uid = Number(userId || 0);
    const rid = Number(recordId || 0);
    const gameId = String(opts.game_id || '').trim();
    const gameAccount = String(opts.game_account || '').trim();
    const desc = String(opts.desc || '').trim();
    if (!uid) throw new Error('user_id 不合法');
    if (!rid) throw new Error('record_id 不合法');

    const db = openStatsDatabase();
    try {
        const row = await get(db, `
            SELECT *
            FROM account_cost_record
            WHERE id = ? AND user_id = ? AND is_deleted = 0
            LIMIT 1
        `, [rid, uid]);
        if (!row) throw new Error('成本记录不存在');
        const mapped = rowToCostRecord(row);
        if (gameAccount && mapped.game_account !== gameAccount) throw new Error('成本记录与账号不匹配');
        if (gameId && canonicalGameId(gameId, mapped.game_name) !== mapped.game_id) throw new Error('成本记录与游戏不匹配');
        await run(db, `
            UPDATE account_cost_record
            SET is_deleted = 1, modify_date = ?, desc = ?
            WHERE id = ?
        `, [nowText(), desc || mapped.desc || 'soft delete by h5', rid]);
        const deletedRow = await get(db, `SELECT * FROM account_cost_record WHERE id = ? LIMIT 1`, [rid]);
        return rowToCostRecord(deletedRow);
    } finally {
        db.close();
    }
}

module.exports = {
    initAccountCostRecordDb,
    migrateAccountCostRecordFromMainToStatsIfNeeded,
    backfillPurchaseCostRecordsFromUserGameAccount,
    createAccountCostRecord,
    getActivePurchaseCostRecord,
    upsertPurchaseCostRecord,
    listAccountCostRecordsByUserAndAccount,
    sumAccountCostAmountByUserAndAccount,
    softDeleteAccountCostRecordById
};
