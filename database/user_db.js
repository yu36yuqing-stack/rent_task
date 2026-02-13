const crypto = require('crypto');
const { openDatabase } = require('./sqlite_client');

const USER_TYPE_ADMIN = '管理员';
const USER_TYPE_INTERNAL = '内部';
const USER_TYPE_EXTERNAL = '外部';
const USER_STATUS_ENABLED = 'enabled';
const USER_STATUS_DISABLED = 'disabled';

const ALLOWED_USER_TYPES = new Set([USER_TYPE_ADMIN, USER_TYPE_INTERNAL, USER_TYPE_EXTERNAL]);
const ALLOWED_STATUS = new Set([USER_STATUS_ENABLED, USER_STATUS_DISABLED]);

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

function normalizeUserType(input) {
    const raw = String(input || '').trim().toLowerCase();
    if (!raw) return USER_TYPE_EXTERNAL;
    if (raw === 'admin' || raw === 'administrator' || raw === '管理员') return USER_TYPE_ADMIN;
    if (raw === 'internal' || raw === 'inside' || raw === '内部') return USER_TYPE_INTERNAL;
    if (raw === 'external' || raw === 'outside' || raw === '外部') return USER_TYPE_EXTERNAL;
    throw new Error(`无效 user_type: ${input}`);
}

function normalizeUserStatus(input) {
    const raw = String(input || USER_STATUS_ENABLED).trim().toLowerCase();
    if (raw === USER_STATUS_ENABLED) return USER_STATUS_ENABLED;
    if (raw === USER_STATUS_DISABLED) return USER_STATUS_DISABLED;
    throw new Error(`无效 status: ${input}`);
}

function normalizeNotifyConfig(input) {
    if (input === undefined || input === null || input === '') return '{}';
    if (typeof input === 'string') {
        try {
            const parsed = JSON.parse(input);
            return JSON.stringify(parsed || {});
        } catch {
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
        id: Number(row.id || 0),
        account: String(row.account || ''),
        name: String(row.name || ''),
        phone: String(row.phone || ''),
        notify_config: (() => {
            try {
                return JSON.parse(String(row.notify_config || '{}'));
            } catch {
                return {};
            }
        })(),
        user_type: String(row.user_type || USER_TYPE_EXTERNAL),
        status: String(row.status || USER_STATUS_ENABLED),
        last_login_at: String(row.last_login_at || ''),
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
                status TEXT NOT NULL DEFAULT 'enabled',
                last_login_at TEXT DEFAULT '',
                modify_date TEXT DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER DEFAULT 0,
                desc TEXT DEFAULT ''
            )
        `);

        const cols = await tableColumns(db, 'user');
        if (!cols.has('status')) {
            await run(db, `ALTER TABLE user ADD COLUMN status TEXT NOT NULL DEFAULT 'enabled'`);
        }
        if (!cols.has('last_login_at')) {
            await run(db, `ALTER TABLE user ADD COLUMN last_login_at TEXT DEFAULT ''`);
        }
        if (!cols.has('create_date')) {
            await run(db, `ALTER TABLE user ADD COLUMN create_date TEXT DEFAULT CURRENT_TIMESTAMP`);
        }

        await run(db, `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_user_account_alive
            ON user(account, is_deleted)
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_user_status
            ON user(status, is_deleted)
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
    const status = normalizeUserStatus(input.status || USER_STATUS_ENABLED);
    const desc = String(input.desc || '').trim();

    if (!account) throw new Error('account 不能为空');
    if (!rawPassword) throw new Error('password 不能为空');
    if (!ALLOWED_USER_TYPES.has(userType)) throw new Error('user_type 不合法');
    if (!ALLOWED_STATUS.has(status)) throw new Error('status 不合法');

    const db = openDatabase();
    try {
        const exists = await get(db, `SELECT id FROM user WHERE account = ? AND is_deleted = 0`, [account]);
        if (exists) throw new Error(`account 已存在: ${account}`);

        const encodedPassword = hashPassword(rawPassword);
        await run(db, `
            INSERT INTO user
            (account, password, name, phone, notify_config, user_type, status, last_login_at, modify_date, is_deleted, desc)
            VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, 0, ?)
        `, [account, encodedPassword, name, phone, notifyConfig, userType, status, nowText(), desc]);

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

async function getActiveUserById(userId) {
    await initUserDb();
    const uid = Number(userId || 0);
    if (!uid) return null;
    const db = openDatabase();
    try {
        const row = await get(db, `SELECT * FROM user WHERE id = ? AND is_deleted = 0`, [uid]);
        return row ? rowToPublicUser(row) : null;
    } finally {
        db.close();
    }
}

async function touchUserLastLogin(userId) {
    await initUserDb();
    const uid = Number(userId || 0);
    if (!uid) return false;
    const db = openDatabase();
    try {
        const r = await run(db, `
            UPDATE user
            SET last_login_at = ?, modify_date = ?
            WHERE id = ? AND is_deleted = 0
        `, [nowText(), nowText(), uid]);
        return Number(r.changes || 0) > 0;
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
        if (String(row.status || USER_STATUS_ENABLED) !== USER_STATUS_ENABLED) {
            return { ok: false, reason: '账号已禁用', user: null };
        }
        if (!verifyPassword(pass, row.password)) return { ok: false, reason: '密码错误', user: null };
        const user = rowToPublicUser(row);
        await touchUserLastLogin(user.id);
        return { ok: true, reason: '', user };
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
    USER_STATUS_ENABLED,
    USER_STATUS_DISABLED,
    initUserDb,
    createUserByAdmin,
    getActiveUserByAccount,
    getActiveUserById,
    verifyUserLogin,
    touchUserLastLogin,
    listActiveUsers
};
