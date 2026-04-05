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

function normalizeRuleDetail(ruleDetail = {}) {
    let raw = ruleDetail;
    if (typeof raw === 'string') {
        try {
            raw = JSON.parse(raw);
        } catch {
            throw new Error('rule_detail 必须是合法 JSON');
        }
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('rule_detail 必须是 JSON 对象');
    }
    return raw;
}

function rowToPublicRule(row = {}) {
    let detail = {};
    try {
        detail = JSON.parse(String(row.rule_detail || '{}')) || {};
    } catch {
        detail = {};
    }
    return {
        id: Number(row.id || 0),
        user_id: Number(row.user_id || 0),
        channel: String(row.channel || '').trim(),
        game_id: String(row.game_id || '').trim(),
        game_name: String(row.game_name || '').trim(),
        mode: String(row.mode || '').trim(),
        rule_detail: detail,
        create_date: String(row.create_date || '').trim(),
        modify_date: String(row.modify_date || '').trim(),
        is_deleted: Number(row.is_deleted || 0),
        desc: String(row.desc || '').trim()
    };
}

async function initUserPriceRuleDb() {
    const db = openPriceDatabase();
    try {
        await run(db, `
            CREATE TABLE IF NOT EXISTS user_price_rule (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                channel TEXT NOT NULL,
                game_id TEXT NOT NULL DEFAULT '1',
                game_name TEXT NOT NULL DEFAULT 'WZRY',
                mode TEXT NOT NULL,
                rule_detail TEXT NOT NULL DEFAULT '{}',
                create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        await run(db, `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_user_price_rule_alive
            ON user_price_rule(user_id, channel, game_id, mode, is_deleted)
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_user_price_rule_user_alive
            ON user_price_rule(user_id, channel, is_deleted)
        `);
    } finally {
        db.close();
    }
}

async function getUserPriceRule(userId, query = {}) {
    await initUserPriceRuleDb();
    const uid = Number(userId || 0);
    const channel = String(query.channel || '').trim();
    const gameId = String(query.game_id || '').trim();
    const mode = String(query.mode || '').trim();
    if (!uid || !channel || !gameId || !mode) return null;

    const db = openPriceDatabase();
    try {
        const row = await get(db, `
            SELECT *
            FROM user_price_rule
            WHERE user_id = ? AND channel = ? AND game_id = ? AND mode = ? AND is_deleted = 0
            LIMIT 1
        `, [uid, channel, gameId, mode]);
        return row ? rowToPublicRule(row) : null;
    } finally {
        db.close();
    }
}

async function upsertUserPriceRule(userId, input = {}, opts = {}) {
    await initUserPriceRuleDb();
    const uid = Number(userId || 0);
    const channel = String(input.channel || '').trim();
    const gameId = String(input.game_id || '').trim();
    const gameName = String(input.game_name || '').trim();
    const mode = String(input.mode || '').trim();
    const ruleDetail = normalizeRuleDetail(input.rule_detail || {});
    const desc = String(opts.desc || input.desc || '').trim();
    if (!uid) throw new Error('user_id 不合法');
    if (!channel) throw new Error('channel 不能为空');
    if (!gameId) throw new Error('game_id 不能为空');
    if (!gameName) throw new Error('game_name 不能为空');
    if (!mode) throw new Error('mode 不能为空');

    const db = openPriceDatabase();
    try {
        const now = nowText();
        const exists = await get(db, `
            SELECT id
            FROM user_price_rule
            WHERE user_id = ? AND channel = ? AND game_id = ? AND mode = ? AND is_deleted = 0
            LIMIT 1
        `, [uid, channel, gameId, mode]);
        if (!exists) {
            await run(db, `
                INSERT INTO user_price_rule
                (user_id, channel, game_id, game_name, mode, rule_detail, create_date, modify_date, is_deleted, desc)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
            `, [uid, channel, gameId, gameName, mode, JSON.stringify(ruleDetail), now, now, desc]);
        } else {
            await run(db, `
                UPDATE user_price_rule
                SET game_name = ?, rule_detail = ?, modify_date = ?, desc = ?
                WHERE id = ?
            `, [gameName, JSON.stringify(ruleDetail), now, desc, Number(exists.id)]);
        }
        return getUserPriceRule(uid, {
            channel,
            game_id: gameId,
            mode
        });
    } finally {
        db.close();
    }
}

async function listUserPriceRulesByUser(userId) {
    await initUserPriceRuleDb();
    const uid = Number(userId || 0);
    if (!uid) return [];
    const db = openPriceDatabase();
    try {
        const rows = await all(db, `
            SELECT *
            FROM user_price_rule
            WHERE user_id = ? AND is_deleted = 0
            ORDER BY id ASC
        `, [uid]);
        return rows.map(rowToPublicRule);
    } finally {
        db.close();
    }
}

module.exports = {
    initUserPriceRuleDb,
    getUserPriceRule,
    upsertUserPriceRule,
    listUserPriceRulesByUser
};
