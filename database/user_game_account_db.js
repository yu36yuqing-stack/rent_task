const { openDatabase } = require('./sqlite_client');

const PLATFORM_KEYS = new Set(['zuhaowang', 'uhaozu', 'uuzuhao']);
const GAME_NAME_ALIASES = new Map([
    ['wzry', 'WZRY'],
    ['王者荣耀', 'WZRY'],
    ['王者', 'WZRY'],
    ['王者荣耀手游', 'WZRY']
]);

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

async function tableColumns(db, tableName) {
    const rows = await all(db, `PRAGMA table_info(${tableName})`);
    return new Set(rows.map((row) => String(row.name || '')));
}

async function tableColumnNamesInOrder(db, tableName) {
    const rows = await all(db, `PRAGMA table_info(${tableName})`);
    return rows.map((row) => String(row.name || ''));
}

function canonicalGameName(input) {
    const raw = String(input || '').trim();
    if (!raw) return 'WZRY';
    const low = raw.toLowerCase();
    if (GAME_NAME_ALIASES.has(raw)) return GAME_NAME_ALIASES.get(raw);
    if (GAME_NAME_ALIASES.has(low)) return GAME_NAME_ALIASES.get(low);
    return raw;
}

function normalizeStatusJson(input) {
    let raw = input;
    if (raw === null || raw === undefined || raw === '') raw = {};
    if (typeof raw === 'string') {
        try {
            raw = JSON.parse(raw);
        } catch {
            throw new Error('channel_status 必须是合法 JSON');
        }
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('channel_status 必须是 JSON 对象');
    }

    const out = {};
    for (const [k, v] of Object.entries(raw)) {
        if (!PLATFORM_KEYS.has(k)) continue;
        const val = String(v || '').trim();
        if (!val) continue;
        out[k] = val;
    }
    return out;
}

function normalizePrdInfoJson(input) {
    let raw = input;
    if (raw === null || raw === undefined || raw === '') raw = {};
    if (typeof raw === 'string') {
        try {
            raw = JSON.parse(raw);
        } catch {
            throw new Error('channel_prd_info 必须是合法 JSON');
        }
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('channel_prd_info 必须是 JSON 对象');
    }

    const out = {};
    for (const [k, v] of Object.entries(raw)) {
        if (!PLATFORM_KEYS.has(k)) continue;
        if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
        out[k] = v;
    }
    return out;
}

function rowToAccount(row = {}) {
    let channelStatus = {};
    let channelPrdInfo = {};
    try {
        channelStatus = JSON.parse(String(row.channel_status || '{}')) || {};
    } catch {
        channelStatus = {};
    }
    try {
        channelPrdInfo = JSON.parse(String(row.channel_prd_info || '{}')) || {};
    } catch {
        channelPrdInfo = {};
    }
    return {
        id: Number(row.id || 0),
        user_id: Number(row.user_id || 0),
        game_account: String(row.game_account || ''),
        account_remark: String(row.account_remark || ''),
        game_name: canonicalGameName(row.game_name || 'WZRY'),
        channel_status: channelStatus,
        channel_prd_info: channelPrdInfo,
        purchase_price: Number(row.purchase_price || 0),
        purchase_date: String(row.purchase_date || '').slice(0, 10),
        modify_date: String(row.modify_date || ''),
        is_deleted: Number(row.is_deleted || 0),
        desc: String(row.desc || '')
    };
}

async function reorderUserGameAccountColumnsIfNeeded(db) {
    const expected = [
        'id',
        'user_id',
        'game_account',
        'account_remark',
        'game_name',
        'channel_status',
        'channel_prd_info',
        'purchase_price',
        'purchase_date',
        'modify_date',
        'is_deleted',
        'desc'
    ];
    const actual = await tableColumnNamesInOrder(db, 'user_game_account');
    if (actual.length === expected.length && actual.every((name, i) => name === expected[i])) {
        return;
    }

    await run(db, `ALTER TABLE user_game_account RENAME TO user_game_account_old`);
    await run(db, `
        CREATE TABLE user_game_account (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            game_account TEXT NOT NULL,
            account_remark TEXT NOT NULL DEFAULT '',
            game_name TEXT NOT NULL DEFAULT 'WZRY',
            channel_status TEXT NOT NULL DEFAULT '{}',
            channel_prd_info TEXT NOT NULL DEFAULT '{}',
            purchase_price REAL NOT NULL DEFAULT 0,
            purchase_date TEXT NOT NULL DEFAULT '',
            modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            is_deleted INTEGER NOT NULL DEFAULT 0,
            desc TEXT NOT NULL DEFAULT ''
        )
    `);
    await run(db, `
        INSERT INTO user_game_account
        (id, user_id, game_account, account_remark, game_name, channel_status, channel_prd_info, purchase_price, purchase_date, modify_date, is_deleted, desc)
        SELECT
            id,
            user_id,
            game_account,
            COALESCE(account_remark, ''),
            COALESCE(game_name, 'WZRY'),
            COALESCE(channel_status, '{}'),
            COALESCE(channel_prd_info, '{}'),
            COALESCE(purchase_price, 0),
            COALESCE(purchase_date, ''),
            COALESCE(modify_date, CURRENT_TIMESTAMP),
            COALESCE(is_deleted, 0),
            COALESCE(desc, '')
        FROM user_game_account_old
    `);
    await run(db, `DROP TABLE user_game_account_old`);
}

async function initUserGameAccountDb() {
    const db = openDatabase();
    try {
        await run(db, `
            CREATE TABLE IF NOT EXISTS user_game_account (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                game_account TEXT NOT NULL,
                game_name TEXT NOT NULL DEFAULT 'WZRY',
                account_remark TEXT NOT NULL DEFAULT '',
                channel_status TEXT NOT NULL DEFAULT '{}',
                channel_prd_info TEXT NOT NULL DEFAULT '{}',
                purchase_price REAL NOT NULL DEFAULT 0,
                purchase_date TEXT NOT NULL DEFAULT '',
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        const cols = await tableColumns(db, 'user_game_account');
        if (!cols.has('account_remark')) {
            await run(db, `ALTER TABLE user_game_account ADD COLUMN account_remark TEXT NOT NULL DEFAULT ''`);
        }
        if (!cols.has('channel_prd_info')) {
            await run(db, `ALTER TABLE user_game_account ADD COLUMN channel_prd_info TEXT NOT NULL DEFAULT '{}'`);
        }
        if (!cols.has('purchase_price')) {
            await run(db, `ALTER TABLE user_game_account ADD COLUMN purchase_price REAL NOT NULL DEFAULT 0`);
        }
        if (!cols.has('purchase_date')) {
            await run(db, `ALTER TABLE user_game_account ADD COLUMN purchase_date TEXT NOT NULL DEFAULT ''`);
        }
        await reorderUserGameAccountColumnsIfNeeded(db);
        await run(db, `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_user_game_account_alive
            ON user_game_account(user_id, game_name, game_account, is_deleted)
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_user_game_account_user_alive
            ON user_game_account(user_id, is_deleted)
        `);
        await compactCanonicalGameNames(db);
    } finally {
        db.close();
    }
}

function parseJsonObject(raw) {
    try {
        const v = JSON.parse(String(raw || '{}')) || {};
        if (!v || typeof v !== 'object' || Array.isArray(v)) return {};
        return v;
    } catch {
        return {};
    }
}

async function compactCanonicalGameNames(db) {
    const rows = await all(db, `
        SELECT id, user_id, game_account, game_name, account_remark, channel_status, channel_prd_info
        FROM user_game_account
        WHERE is_deleted = 0
        ORDER BY id ASC
    `);

    const groups = new Map();
    for (const row of rows) {
        const gameName = canonicalGameName(row.game_name || 'WZRY');
        const key = `${Number(row.user_id || 0)}::${gameName}::${String(row.game_account || '').trim()}`;
        const arr = groups.get(key) || [];
        arr.push({ ...row, game_name: gameName });
        groups.set(key, arr);
    }

    for (const list of groups.values()) {
        if (!Array.isArray(list) || list.length === 0) continue;
        const keeper = list[list.length - 1];
        let mergedStatus = {};
        let mergedPrdInfo = {};
        let accountRemark = '';
        for (const row of list) {
            mergedStatus = { ...mergedStatus, ...parseJsonObject(row.channel_status) };
            mergedPrdInfo = { ...mergedPrdInfo, ...parseJsonObject(row.channel_prd_info) };
            const remark = String(row.account_remark || '').trim();
            if (remark) accountRemark = remark;
        }

        for (const row of list) {
            if (Number(row.id) === Number(keeper.id)) continue;
            await run(db, `
                UPDATE user_game_account
                SET is_deleted = 1, modify_date = ?, desc = ?
                WHERE id = ?
            `, [nowText(), 'dedupe by canonical game_name', Number(row.id)]);
        }

        await run(db, `
            UPDATE user_game_account
            SET game_name = ?, account_remark = ?, channel_status = ?, channel_prd_info = ?, modify_date = ?
            WHERE id = ?
        `, [
            keeper.game_name,
            accountRemark,
            JSON.stringify(mergedStatus),
            JSON.stringify(mergedPrdInfo),
            nowText(),
            Number(keeper.id)
        ]);
    }
}

async function upsertUserGameAccount(input = {}) {
    await initUserGameAccountDb();
    const userId = Number(input.user_id || 0);
    const gameAccount = String(input.game_account || '').trim();
    const gameName = canonicalGameName(String(input.game_name || 'WZRY').trim() || 'WZRY');
    const accountRemark = String(input.account_remark || '').trim();
    const purchasePriceRaw = Number(input.purchase_price);
    const hasPurchasePrice = Number.isFinite(purchasePriceRaw) && purchasePriceRaw >= 0;
    const purchaseDateRaw = String(input.purchase_date || '').trim();
    const hasPurchaseDate = /^\d{4}-\d{2}-\d{2}$/.test(purchaseDateRaw);
    const nextStatus = normalizeStatusJson(input.channel_status || {});
    const nextPrdInfo = normalizePrdInfoJson(input.channel_prd_info || {});
    const desc = String(input.desc || '').trim();

    if (!userId) throw new Error('user_id 不合法');
    if (!gameAccount) throw new Error('game_account 不能为空');

    const db = openDatabase();
    try {
        const row = await get(db, `
            SELECT * FROM user_game_account
            WHERE user_id = ? AND game_name = ? AND game_account = ? AND is_deleted = 0
            LIMIT 1
        `, [userId, gameName, gameAccount]);

        if (!row) {
            const deletedRow = await get(db, `
                SELECT * FROM user_game_account
                WHERE user_id = ? AND game_name = ? AND game_account = ? AND is_deleted = 1
                ORDER BY id DESC
                LIMIT 1
            `, [userId, gameName, gameAccount]);

            if (deletedRow) {
                let deletedStatus = {};
                let deletedPrdInfo = {};
                try {
                    deletedStatus = JSON.parse(String(deletedRow.channel_status || '{}')) || {};
                } catch {
                    deletedStatus = {};
                }
                try {
                    deletedPrdInfo = JSON.parse(String(deletedRow.channel_prd_info || '{}')) || {};
                } catch {
                    deletedPrdInfo = {};
                }
                const mergedStatus = { ...deletedStatus, ...nextStatus };
                const mergedPrdInfo = { ...deletedPrdInfo, ...nextPrdInfo };
                const mergedRemark = accountRemark || String(deletedRow.account_remark || '');
                const mergedPurchasePrice = hasPurchasePrice ? purchasePriceRaw : Number(deletedRow.purchase_price || 0);
                const mergedPurchaseDate = hasPurchaseDate ? purchaseDateRaw : String(deletedRow.purchase_date || '').slice(0, 10);
                await run(db, `
                    UPDATE user_game_account
                    SET account_remark = ?, channel_status = ?, channel_prd_info = ?,
                        purchase_price = ?, purchase_date = ?, modify_date = ?, is_deleted = 0, desc = ?
                    WHERE id = ?
                `, [
                    mergedRemark,
                    JSON.stringify(mergedStatus),
                    JSON.stringify(mergedPrdInfo),
                    mergedPurchasePrice,
                    mergedPurchaseDate,
                    nowText(),
                    desc || String(deletedRow.desc || ''),
                    Number(deletedRow.id)
                ]);
            } else {
                await run(db, `
                    INSERT INTO user_game_account
                    (user_id, game_account, account_remark, game_name, channel_status, channel_prd_info, purchase_price, purchase_date, modify_date, is_deleted, desc)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
                `, [
                    userId,
                    gameAccount,
                    accountRemark,
                    gameName,
                    JSON.stringify(nextStatus),
                    JSON.stringify(nextPrdInfo),
                    hasPurchasePrice ? purchasePriceRaw : 0,
                    hasPurchaseDate ? purchaseDateRaw : '',
                    nowText(),
                    desc
                ]);
            }
        } else {
            let currentStatus = {};
            let currentPrdInfo = {};
            try {
                currentStatus = JSON.parse(String(row.channel_status || '{}')) || {};
            } catch {
                currentStatus = {};
            }
            try {
                currentPrdInfo = JSON.parse(String(row.channel_prd_info || '{}')) || {};
            } catch {
                currentPrdInfo = {};
            }
            const mergedStatus = { ...currentStatus, ...nextStatus };
            const mergedPrdInfo = { ...currentPrdInfo, ...nextPrdInfo };
            const mergedRemark = accountRemark || String(row.account_remark || '');
            const mergedPurchasePrice = hasPurchasePrice ? purchasePriceRaw : Number(row.purchase_price || 0);
            const mergedPurchaseDate = hasPurchaseDate ? purchaseDateRaw : String(row.purchase_date || '').slice(0, 10);
            await run(db, `
                UPDATE user_game_account
                SET account_remark = ?, channel_status = ?, channel_prd_info = ?,
                    purchase_price = ?, purchase_date = ?, modify_date = ?, desc = ?
                WHERE id = ?
            `, [
                mergedRemark,
                JSON.stringify(mergedStatus),
                JSON.stringify(mergedPrdInfo),
                mergedPurchasePrice,
                mergedPurchaseDate,
                nowText(),
                desc || String(row.desc || ''),
                row.id
            ]);
        }

        const updated = await get(db, `
            SELECT * FROM user_game_account
            WHERE user_id = ? AND game_name = ? AND game_account = ? AND is_deleted = 0
            LIMIT 1
        `, [userId, gameName, gameAccount]);
        return rowToAccount(updated);
    } finally {
        db.close();
    }
}

async function clearPlatformStatusForUser(userId, platform) {
    await initUserGameAccountDb();
    const uid = Number(userId || 0);
    const key = String(platform || '').trim();
    if (!uid) throw new Error('user_id 不合法');
    if (!PLATFORM_KEYS.has(key)) throw new Error(`platform 不支持: ${platform}`);

    const db = openDatabase();
    try {
        const rows = await all(db, `SELECT id, channel_status FROM user_game_account WHERE user_id = ? AND is_deleted = 0`, [uid]);
        for (const row of rows) {
            let status = {};
            try { status = JSON.parse(String(row.channel_status || '{}')) || {}; } catch { status = {}; }
            if (!(key in status)) continue;
            delete status[key];
            await run(db, `
                UPDATE user_game_account
                SET channel_status = ?, modify_date = ?
                WHERE id = ?
            `, [JSON.stringify(status), nowText(), row.id]);
        }
    } finally {
        db.close();
    }
}

async function softDeleteEmptyAccountsByUser(userId) {
    await initUserGameAccountDb();
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');

    const db = openDatabase();
    try {
        const rows = await all(db, `SELECT * FROM user_game_account WHERE user_id = ? AND is_deleted = 0`, [uid]);
        let count = 0;
        for (const row of rows) {
            let status = {};
            try { status = JSON.parse(String(row.channel_status || '{}')) || {}; } catch { status = {}; }
            if (Object.keys(status).length > 0) continue;

            const deletedRow = await get(db, `
                SELECT * FROM user_game_account
                WHERE user_id = ? AND game_name = ? AND game_account = ? AND is_deleted = 1
                ORDER BY id DESC
                LIMIT 1
            `, [uid, String(row.game_name || ''), String(row.game_account || '')]);

            if (!deletedRow) {
                await run(db, `
                    UPDATE user_game_account
                    SET is_deleted = 1, modify_date = ?
                    WHERE id = ?
                `, [nowText(), row.id]);
                count += 1;
                continue;
            }

            const mergedStatus = {
                ...parseJsonObject(deletedRow.channel_status),
                ...parseJsonObject(row.channel_status)
            };
            const mergedPrdInfo = {
                ...parseJsonObject(deletedRow.channel_prd_info),
                ...parseJsonObject(row.channel_prd_info)
            };
            const rowPurchasePrice = Number(row.purchase_price || 0);
            const deletedPurchasePrice = Number(deletedRow.purchase_price || 0);
            const mergedPurchasePrice = Number.isFinite(rowPurchasePrice) && rowPurchasePrice > 0
                ? rowPurchasePrice
                : deletedPurchasePrice;
            const rowPurchaseDate = String(row.purchase_date || '').slice(0, 10);
            const deletedPurchaseDate = String(deletedRow.purchase_date || '').slice(0, 10);
            const mergedPurchaseDate = /^\d{4}-\d{2}-\d{2}$/.test(rowPurchaseDate)
                ? rowPurchaseDate
                : deletedPurchaseDate;
            const mergedRemark = String(row.account_remark || '').trim() || String(deletedRow.account_remark || '').trim();
            const mergedDesc = String(deletedRow.desc || '').trim() || String(row.desc || '').trim();

            await run(db, `
                UPDATE user_game_account
                SET account_remark = ?, channel_status = ?, channel_prd_info = ?,
                    purchase_price = ?, purchase_date = ?, modify_date = ?, desc = ?
                WHERE id = ?
            `, [
                mergedRemark,
                JSON.stringify(mergedStatus),
                JSON.stringify(mergedPrdInfo),
                mergedPurchasePrice,
                mergedPurchaseDate,
                nowText(),
                mergedDesc,
                Number(deletedRow.id)
            ]);

            await run(db, `
                DELETE FROM user_game_account
                WHERE id = ?
            `, [Number(row.id)]);
            count += 1;
        }
        return count;
    } finally {
        db.close();
    }
}

async function listUserGameAccounts(userId, page = 1, pageSize = 50) {
    await initUserGameAccountDb();
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    const p = Math.max(1, Number(page || 1));
    const ps = Math.min(200, Math.max(1, Number(pageSize || 50)));
    const offset = (p - 1) * ps;

    const db = openDatabase();
    try {
        const totalRow = await get(db, `SELECT COUNT(*) AS total FROM user_game_account WHERE user_id = ? AND is_deleted = 0`, [uid]);
        const rows = await all(db, `
            SELECT * FROM user_game_account
            WHERE user_id = ? AND is_deleted = 0
            ORDER BY id DESC
            LIMIT ? OFFSET ?
        `, [uid, ps, offset]);

        return {
            page: p,
            page_size: ps,
            total: Number(totalRow?.total || 0),
            list: rows.map(rowToAccount)
        };
    } finally {
        db.close();
    }
}

async function listOwnersByGameAccounts(gameAccounts = [], gameName = '') {
    await initUserGameAccountDb();
    const accs = [...new Set((Array.isArray(gameAccounts) ? gameAccounts : []).map((v) => String(v || '').trim()).filter(Boolean))];
    if (accs.length === 0) return {};

    const db = openDatabase();
    try {
        const placeholders = accs.map(() => '?').join(',');
        const params = [...accs];
        let whereGameName = '';
        if (gameName) {
            whereGameName = ' AND game_name = ? ';
            params.push(String(gameName));
        }

        const rows = await all(db, `
            SELECT user_id, game_account, game_name
            FROM user_game_account
            WHERE is_deleted = 0
              AND game_account IN (${placeholders})
              ${whereGameName}
            ORDER BY id ASC
        `, params);

        const out = {};
        for (const row of rows) {
            const acc = String(row.game_account || '');
            if (!out[acc]) out[acc] = Number(row.user_id || 0);
        }
        return out;
    } finally {
        db.close();
    }
}

async function listAccountRemarksByUserAndAccounts(userId, gameAccounts = []) {
    await initUserGameAccountDb();
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    const accs = [...new Set((Array.isArray(gameAccounts) ? gameAccounts : [])
        .map((v) => String(v || '').trim())
        .filter(Boolean))];
    if (accs.length === 0) return {};

    const db = openDatabase();
    try {
        const placeholders = accs.map(() => '?').join(',');
        const rows = await all(db, `
            SELECT game_account, account_remark, id
            FROM user_game_account
            WHERE user_id = ? AND is_deleted = 0
              AND game_account IN (${placeholders})
            ORDER BY id DESC
        `, [uid, ...accs]);

        const out = {};
        for (const row of rows) {
            const acc = String(row.game_account || '').trim();
            if (!acc || out[acc] !== undefined) continue;
            out[acc] = String(row.account_remark || '').trim();
        }
        return out;
    } finally {
        db.close();
    }
}

async function updateUserGameAccountPurchaseByUserAndAccount(userId, gameAccount, purchasePrice, purchaseDate, desc = '') {
    await initUserGameAccountDb();
    const uid = Number(userId || 0);
    const acc = String(gameAccount || '').trim();
    const price = Number(purchasePrice);
    const day = String(purchaseDate || '').trim();
    if (!uid) throw new Error('user_id 不合法');
    if (!acc) throw new Error('game_account 不能为空');
    if (!Number.isFinite(price) || price < 0) throw new Error('purchase_price 不合法');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error('purchase_date 格式不合法');

    const db = openDatabase();
    try {
        const row = await get(db, `
            SELECT id
            FROM user_game_account
            WHERE user_id = ? AND game_account = ? AND is_deleted = 0
            ORDER BY id DESC
            LIMIT 1
        `, [uid, acc]);
        if (!row) throw new Error(`找不到账号: ${acc}`);

        await run(db, `
            UPDATE user_game_account
            SET purchase_price = ?, purchase_date = ?, modify_date = ?, desc = ?
            WHERE id = ?
        `, [Number(price.toFixed(2)), day, nowText(), String(desc || '').trim(), Number(row.id)]);

        const updated = await get(db, `SELECT * FROM user_game_account WHERE id = ? LIMIT 1`, [Number(row.id)]);
        return rowToAccount(updated);
    } finally {
        db.close();
    }
}

module.exports = {
    PLATFORM_KEYS,
    initUserGameAccountDb,
    upsertUserGameAccount,
    clearPlatformStatusForUser,
    softDeleteEmptyAccountsByUser,
    listUserGameAccounts,
    listOwnersByGameAccounts,
    listAccountRemarksByUserAndAccounts,
    updateUserGameAccountPurchaseByUserAndAccount
};
