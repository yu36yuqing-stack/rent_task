const crypto = require('crypto');
const { openDatabase } = require('./sqlite_client');

const USER_TYPE_ADMIN = '管理员';
const USER_TYPE_INTERNAL = '内部';
const USER_TYPE_EXTERNAL = '外部';
const ALLOWED_USER_TYPES = new Set([USER_TYPE_ADMIN, USER_TYPE_INTERNAL, USER_TYPE_EXTERNAL]);

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

function normalizeUserType(input) {
    const raw = String(input || '').trim().toLowerCase();
    if (!raw) return USER_TYPE_EXTERNAL;
    if (raw === 'admin' || raw === 'administrator' || raw === '管理员') return USER_TYPE_ADMIN;
    if (raw === 'internal' || raw === 'inside' || raw === '内部') return USER_TYPE_INTERNAL;
    if (raw === 'external' || raw === 'outside' || raw === '外部') return USER_TYPE_EXTERNAL;
    throw new Error(`无效 user_type: ${input}`);
}

function normalizeNotifyConfig(input) {
    if (input === undefined || input === null || input === '') return '{}';
    if (typeof input === 'string') {
        try {
            const parsed = JSON.parse(input);
            return JSON.stringify(parsed || {});
        } catch (e) {
            throw new Error('notify_config 必须是合法 JSON');
        }
    }
    if (typeof input === 'object') return JSON.stringify(input);
    throw new Error('notify_config 必须是 JSON 对象或 JSON 字符串');
}

function hashPassword(rawPassword) {
    const salt = crypto.randomBytes(16).toString('hex');
    const hashed = crypto.pbkdf2Sync(String(rawPassword), salt, 120000, 32, 'sha256').toString('hex');
    return `pbkdf2$120000$${salt}$${hashed}`;
}

function verifyPassword(rawPassword, encoded) {
    const parts = String(encoded || '').split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
    const iterations = Number(parts[1]);
    const salt = parts[2];
    const expected = parts[3];
    if (!iterations || !salt || !expected) return false;
    const actual = crypto.pbkdf2Sync(String(rawPassword), salt, iterations, 32, 'sha256').toString('hex');
    return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

function rowToPublicUser(row = {}) {
    return {
        id: row.id,
        account: String(row.account || ''),
        name: String(row.name || ''),
        phone: String(row.phone || ''),
        notify_config: (() => {
            try {
                return JSON.parse(String(row.notify_config || '{}'));
            } catch (_) {
                return {};
            }
        })(),
        user_type: String(row.user_type || USER_TYPE_EXTERNAL),
        modify_date: String(row.modify_date || ''),
        is_deleted: Number(row.is_deleted || 0),
        desc: String(row.desc || '')
    };
}

async function initUserDb() {
    const db = openDatabase();
    try {
        await run(db, `
            CREATE TABLE IF NOT EXISTS user (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                account TEXT NOT NULL,
                password TEXT NOT NULL,
                name TEXT DEFAULT '',
                phone TEXT DEFAULT '',
                notify_config TEXT DEFAULT '{}',
                user_type TEXT DEFAULT '外部',
                create_date TEXT DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER DEFAULT 0,
                desc TEXT DEFAULT ''
            )
        `);
        await run(db, `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_user_account_alive
            ON user(account, is_deleted)
        `);
    } finally {
        db.close();
    }
}

async function createUserByAdmin(input = {}) {
    await initUserDb();
    const account = String(input.account || '').trim();
    const rawPassword = String(input.password || '').trim();
    const name = String(input.name || '').trim();
    const phone = String(input.phone || '').trim();
    const notifyConfig = normalizeNotifyConfig(input.notify_config);
    const userType = normalizeUserType(input.user_type);
    const desc = String(input.desc || '').trim();

    if (!account) throw new Error('account 不能为空');
    if (!rawPassword) throw new Error('password 不能为空');
    if (!ALLOWED_USER_TYPES.has(userType)) throw new Error('user_type 不合法');

    const db = openDatabase();
    try {
        const exists = await get(db, `SELECT id FROM user WHERE account = ? AND is_deleted = 0`, [account]);
        if (exists) throw new Error(`account 已存在: ${account}`);

        const encodedPassword = hashPassword(rawPassword);
        await run(db, `
            INSERT INTO user
            (account, password, name, phone, notify_config, user_type, modify_date, is_deleted, desc)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
        `, [account, encodedPassword, name, phone, notifyConfig, userType, nowText(), desc]);

        const row = await get(db, `SELECT * FROM user WHERE account = ? AND is_deleted = 0`, [account]);
        return rowToPublicUser(row);
    } finally {
        db.close();
    }
}

async function getActiveUserByAccount(account) {
    await initUserDb();
    const target = String(account || '').trim();
    if (!target) return null;
    const db = openDatabase();
    try {
        const row = await get(db, `SELECT * FROM user WHERE account = ? AND is_deleted = 0`, [target]);
        return row ? rowToPublicUser(row) : null;
    } finally {
        db.close();
    }
}

async function verifyUserLogin(account, rawPassword) {
    await initUserDb();
    const target = String(account || '').trim();
    const pass = String(rawPassword || '');
    if (!target || !pass) return { ok: false, reason: '账号或密码为空', user: null };

    const db = openDatabase();
    try {
        const row = await get(db, `SELECT * FROM user WHERE account = ? AND is_deleted = 0`, [target]);
        if (!row) return { ok: false, reason: '账号不存在', user: null };
        if (!verifyPassword(pass, row.password)) return { ok: false, reason: '密码错误', user: null };
        return { ok: true, reason: '', user: rowToPublicUser(row) };
    } finally {
        db.close();
    }
}

async function listActiveUsers() {
    await initUserDb();
    const db = openDatabase();
    try {
        const rows = await all(db, `SELECT * FROM user WHERE is_deleted = 0 ORDER BY id ASC`);
        return rows.map(rowToPublicUser);
    } finally {
        db.close();
    }
}

module.exports = {
    USER_TYPE_ADMIN,
    USER_TYPE_INTERNAL,
    USER_TYPE_EXTERNAL,
    initUserDb,
    createUserByAdmin,
    getActiveUserByAccount,
    verifyUserLogin,
    listActiveUsers
};
