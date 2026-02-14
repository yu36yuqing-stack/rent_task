const { openDatabase } = require('./sqlite_client');

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

function normalizeUserId(userId) {
    return Number(userId || 0);
}

function normalizeRuleName(ruleName) {
    return String(ruleName || '').trim();
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
        rule_name: String(row.rule_name || '').trim(),
        rule_detail: detail,
        create_date: String(row.create_date || '').trim(),
        modify_date: String(row.modify_date || '').trim(),
        is_deleted: Number(row.is_deleted || 0),
        desc: String(row.desc || '').trim()
    };
}

async function initUserRuleDb() {
    const db = openDatabase();
    try {
        await run(db, `
            CREATE TABLE IF NOT EXISTS user_rule (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                rule_name TEXT NOT NULL,
                rule_detail TEXT NOT NULL DEFAULT '{}',
                create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        await run(db, `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_user_rule_alive
            ON user_rule(user_id, rule_name, is_deleted)
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_user_rule_user_alive
            ON user_rule(user_id, is_deleted)
        `);
    } finally {
        db.close();
    }
}

async function getUserRuleByName(userId, ruleName) {
    await initUserRuleDb();
    const uid = normalizeUserId(userId);
    const name = normalizeRuleName(ruleName);
    if (!uid || !name) return null;

    const db = openDatabase();
    try {
        const row = await get(db, `
            SELECT *
            FROM user_rule
            WHERE user_id = ? AND rule_name = ? AND is_deleted = 0
            LIMIT 1
        `, [uid, name]);
        return row ? rowToPublicRule(row) : null;
    } finally {
        db.close();
    }
}

async function listUserRulesByUser(userId) {
    await initUserRuleDb();
    const uid = normalizeUserId(userId);
    if (!uid) return [];
    const db = openDatabase();
    try {
        const rows = await all(db, `
            SELECT *
            FROM user_rule
            WHERE user_id = ? AND is_deleted = 0
            ORDER BY id ASC
        `, [uid]);
        return rows.map(rowToPublicRule);
    } finally {
        db.close();
    }
}

async function upsertUserRuleByName(userId, input = {}, opts = {}) {
    await initUserRuleDb();
    const uid = normalizeUserId(userId);
    const ruleName = normalizeRuleName(input.rule_name);
    const ruleDetail = normalizeRuleDetail(input.rule_detail || {});
    const desc = String(opts.desc || input.desc || '').trim();
    if (!uid) throw new Error('user_id 不合法');
    if (!ruleName) throw new Error('rule_name 不能为空');

    const db = openDatabase();
    try {
        const now = nowText();
        const exists = await get(db, `
            SELECT id
            FROM user_rule
            WHERE user_id = ? AND rule_name = ? AND is_deleted = 0
            LIMIT 1
        `, [uid, ruleName]);

        if (!exists) {
            await run(db, `
                INSERT INTO user_rule
                (user_id, rule_name, rule_detail, create_date, modify_date, is_deleted, desc)
                VALUES (?, ?, ?, ?, ?, 0, ?)
            `, [uid, ruleName, JSON.stringify(ruleDetail), now, now, desc]);
        } else {
            await run(db, `
                UPDATE user_rule
                SET rule_detail = ?, modify_date = ?, desc = ?
                WHERE id = ?
            `, [JSON.stringify(ruleDetail), now, desc, Number(exists.id)]);
        }

        return getUserRuleByName(uid, ruleName);
    } finally {
        db.close();
    }
}

module.exports = {
    initUserRuleDb,
    getUserRuleByName,
    listUserRulesByUser,
    upsertUserRuleByName
};
