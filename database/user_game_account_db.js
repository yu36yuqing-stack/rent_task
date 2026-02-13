const { openDatabase } = require('./sqlite_client');

const PLATFORM_KEYS = new Set(['zuhaowang', 'uhaozu', 'youyouzuhao']);

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

function rowToAccount(row = {}) {
    let channelStatus = {};
    try {
        channelStatus = JSON.parse(String(row.channel_status || '{}')) || {};
    } catch {
        channelStatus = {};
    }
    return {
        id: Number(row.id || 0),
        user_id: Number(row.user_id || 0),
        game_account: String(row.game_account || ''),
        game_name: String(row.game_name || 'WZRY'),
        channel_status: channelStatus,
        modify_date: String(row.modify_date || ''),
        is_deleted: Number(row.is_deleted || 0),
        desc: String(row.desc || '')
    };
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
                channel_status TEXT NOT NULL DEFAULT '{}',
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        await run(db, `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_user_game_account_alive
            ON user_game_account(user_id, game_name, game_account, is_deleted)
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_user_game_account_user_alive
            ON user_game_account(user_id, is_deleted)
        `);
    } finally {
        db.close();
    }
}

async function upsertUserGameAccount(input = {}) {
    await initUserGameAccountDb();
    const userId = Number(input.user_id || 0);
    const gameAccount = String(input.game_account || '').trim();
    const gameName = String(input.game_name || 'WZRY').trim() || 'WZRY';
    const nextStatus = normalizeStatusJson(input.channel_status || {});
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
            await run(db, `
                INSERT INTO user_game_account
                (user_id, game_account, game_name, channel_status, modify_date, is_deleted, desc)
                VALUES (?, ?, ?, ?, ?, 0, ?)
            `, [userId, gameAccount, gameName, JSON.stringify(nextStatus), nowText(), desc]);
        } else {
            let current = {};
            try {
                current = JSON.parse(String(row.channel_status || '{}')) || {};
            } catch {
                current = {};
            }
            const merged = { ...current, ...nextStatus };
            await run(db, `
                UPDATE user_game_account
                SET channel_status = ?, modify_date = ?, desc = ?
                WHERE id = ?
            `, [JSON.stringify(merged), nowText(), desc || String(row.desc || ''), row.id]);
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
        const rows = await all(db, `SELECT id, channel_status FROM user_game_account WHERE user_id = ? AND is_deleted = 0`, [uid]);
        let count = 0;
        for (const row of rows) {
            let status = {};
            try { status = JSON.parse(String(row.channel_status || '{}')) || {}; } catch { status = {}; }
            if (Object.keys(status).length > 0) continue;
            await run(db, `
                UPDATE user_game_account
                SET is_deleted = 1, modify_date = ?
                WHERE id = ?
            `, [nowText(), row.id]);
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

module.exports = {
    PLATFORM_KEYS,
    initUserGameAccountDb,
    upsertUserGameAccount,
    clearPlatformStatusForUser,
    softDeleteEmptyAccountsByUser,
    listUserGameAccounts,
    listOwnersByGameAccounts
};
