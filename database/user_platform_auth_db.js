const crypto = require('crypto');
const { openDatabase } = require('./sqlite_client');

const PLATFORMS = new Set(['zuhaowang', 'zuhaowang-yuanbao', 'uhaozu', 'uuzuhao']);
const AUTH_TYPES = new Set(['cookie', 'token', 'session']);
const AUTH_STATUS = new Set(['valid', 'expired', 'revoked']);
const PLATFORM_AUTH_RULES = {
    zuhaowang: {
        types: new Set(['token']),
        requiredKeys: ['yuanbao']
    },
    'zuhaowang-yuanbao': {
        types: new Set(['token']),
        requiredKeys: ['token', 'device_id', 'package_name']
    },
    uhaozu: {
        types: new Set(['cookie']),
        requiredKeys: ['cookie']
    },
    uuzuhao: {
        types: new Set(['token']),
        requiredKeys: ['app_key', 'app_secret']
    }
};
const UHAOZU_DEFAULT_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    tml: '{"platform":"20","terminal":"0"}',
    'sec-ch-ua-platform': '"macOS"',
    'sec-ch-ua': '"Not:A-Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
    'sec-ch-ua-mobile': '?0',
    'X-Requested-With': 'XMLHttpRequest',
    'Content-Type': 'application/json;charset=UTF-8',
    Origin: 'https://b.uhaozu.com',
    'Sec-Fetch-Site': 'same-site',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    Referer: 'https://b.uhaozu.com/order',
    'Accept-Language': 'zh-CN,zh;q=0.9'
};
const UHAOZU_HEADER_NAME_MAP = {
    'user-agent': 'User-Agent',
    accept: 'Accept',
    'accept-encoding': 'Accept-Encoding',
    tml: 'tml',
    'sec-ch-ua-platform': 'sec-ch-ua-platform',
    'sec-ch-ua': 'sec-ch-ua',
    'sec-ch-ua-mobile': 'sec-ch-ua-mobile',
    'x-requested-with': 'X-Requested-With',
    'content-type': 'Content-Type',
    origin: 'Origin',
    'sec-fetch-site': 'Sec-Fetch-Site',
    'sec-fetch-mode': 'Sec-Fetch-Mode',
    'sec-fetch-dest': 'Sec-Fetch-Dest',
    referer: 'Referer',
    'accept-language': 'Accept-Language',
    'cache-control': 'Cache-Control',
    pragma: 'Pragma',
    connection: 'Connection'
};
const UHAOZU_ORDER_DETAIL_HEADER_NAME_MAP = {
    accept: 'Accept',
    'accept-language': 'Accept-Language',
    connection: 'Connection',
    'sec-fetch-dest': 'Sec-Fetch-Dest',
    'sec-fetch-mode': 'Sec-Fetch-Mode',
    'sec-fetch-site': 'Sec-Fetch-Site',
    'sec-fetch-user': 'Sec-Fetch-User',
    'upgrade-insecure-requests': 'Upgrade-Insecure-Requests',
    'user-agent': 'User-Agent',
    'sec-ch-ua': 'sec-ch-ua',
    'sec-ch-ua-mobile': 'sec-ch-ua-mobile',
    'sec-ch-ua-platform': 'sec-ch-ua-platform',
    cookie: 'Cookie'
};

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

function normalizePlatform(value) {
    const platform = String(value || '').trim().toLowerCase();
    if (!PLATFORMS.has(platform)) throw new Error(`platform 不支持: ${value}`);
    return platform;
}

function normalizeAuthType(value) {
    const authType = String(value || '').trim().toLowerCase();
    if (!AUTH_TYPES.has(authType)) throw new Error(`auth_type 不支持: ${value}`);
    return authType;
}

function normalizeAuthStatus(value) {
    const status = String(value || 'valid').trim().toLowerCase();
    if (!AUTH_STATUS.has(status)) throw new Error(`auth_status 不支持: ${value}`);
    return status;
}

function normalizeChannelEnabled(value, fallback = true) {
    if (value === undefined || value === null || value === '') return fallback ? 1 : 0;
    return Boolean(value) ? 1 : 0;
}

function parseAuthPayload(payload) {
    if (payload === undefined || payload === null || payload === '') return {};
    if (typeof payload === 'string') {
        try {
            return JSON.parse(payload) || {};
        } catch {
            throw new Error('auth_payload 必须是合法 JSON');
        }
    }
    if (typeof payload === 'object' && !Array.isArray(payload)) return payload;
    throw new Error('auth_payload 必须是 JSON 对象或 JSON 字符串');
}

function ensureNonEmptyStringField(obj, key) {
    const value = String((obj || {})[key] || '').trim();
    return value.length > 0;
}

function normalizeZuhaowangAuthPayloadForStorage(payloadObj = {}) {
    const raw = payloadObj && typeof payloadObj === 'object' && !Array.isArray(payloadObj) ? payloadObj : {};
    const fromYuanbao = raw.yuanbao && typeof raw.yuanbao === 'object' ? raw.yuanbao : null;
    const source = fromYuanbao || raw;
    const dataRaw = source.data && typeof source.data === 'object' ? source.data : {};

    const token = String(
        source.token_yuanbao
        || source.token
        || dataRaw.token
        || raw.token_yuanbao
        || raw.token_post
        || raw.token_get
        || ''
    ).trim();
    const deviceId = String(
        source.device_id
        || source.deviceId
        || dataRaw.device_id
        || dataRaw.deviceId
        || raw.device_id
        || ''
    ).trim();
    const packageName = String(
        source.package_name
        || source.packageName
        || raw.package_name
        || (token ? 'com.duodian.merchant' : '')
    ).trim();

    const normalizedData = {
        ...(dataRaw || {}),
        ...(token ? { token } : {}),
        ...(deviceId ? { deviceId } : {})
    };

    const normalizedYuanbao = {
        ...(source || {}),
        ...(token ? { token } : {}),
        ...(deviceId ? { deviceId } : {}),
        ...(packageName ? { package_name: packageName } : {}),
        data: normalizedData
    };

    return {
        yuanbao: normalizedYuanbao
    };
}

function normalizeUhaozuHeaders(raw = {}, fallback = {}) {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const out = { ...(fallback && typeof fallback === 'object' ? fallback : {}) };
    for (const [key, value] of Object.entries(src)) {
        const name = UHAOZU_HEADER_NAME_MAP[String(key || '').trim().toLowerCase()];
        if (!name) continue;
        const text = String(value || '').trim();
        if (!text) continue;
        out[name] = text;
    }
    return out;
}

function normalizeUhaozuOrderDetailHeaders(raw = {}, fallback = {}) {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const out = { ...(fallback && typeof fallback === 'object' ? fallback : {}) };
    for (const [key, value] of Object.entries(src)) {
        const name = UHAOZU_ORDER_DETAIL_HEADER_NAME_MAP[String(key || '').trim().toLowerCase()];
        if (!name) continue;
        const text = String(value || '').trim();
        if (!text) continue;
        out[name] = text;
    }
    return out;
}

function normalizeUhaozuAuthPayloadForStorage(payloadObj = {}) {
    const raw = payloadObj && typeof payloadObj === 'object' && !Array.isArray(payloadObj) ? payloadObj : {};
    const cookie = String(raw.cookie || '').trim();
    const defaultHeaders = normalizeUhaozuHeaders(raw.default_headers, UHAOZU_DEFAULT_HEADERS);
    const legacyOrderHeaders = normalizeUhaozuHeaders(raw.order_headers);
    const mergedHeaders = normalizeUhaozuHeaders(legacyOrderHeaders, defaultHeaders);
    const orderDetailHeaders = normalizeUhaozuOrderDetailHeaders(raw.order_detail_headers);
    const out = {
        cookie,
        default_headers: mergedHeaders
    };
    if (Object.keys(orderDetailHeaders).length > 0) {
        out.order_detail_headers = orderDetailHeaders;
    }
    const orderListPath = String(raw.order_list_path || '').trim();
    if (orderListPath) out.order_list_path = orderListPath;
    return out;
}

function normalizePlatformAuthPayload(platform, payloadObj = {}) {
    if (platform === 'zuhaowang') return normalizeZuhaowangAuthPayloadForStorage(payloadObj);
    if (platform === 'uhaozu') return normalizeUhaozuAuthPayloadForStorage(payloadObj);
    return payloadObj;
}

function validatePlatformAuth(platform, authType, payloadObj) {
    const rule = PLATFORM_AUTH_RULES[platform];
    if (!rule) return;

    if (!rule.types.has(authType)) {
        throw new Error(`${platform} 仅支持 auth_type=${Array.from(rule.types).join('/')}`);
    }

    if (platform === 'zuhaowang') {
        const normalized = normalizeZuhaowangAuthPayloadForStorage(payloadObj);
        const yuanbao = normalized.yuanbao && typeof normalized.yuanbao === 'object' ? normalized.yuanbao : {};
        const data = yuanbao.data && typeof yuanbao.data === 'object' ? yuanbao.data : {};
        const token = String(yuanbao.token_yuanbao || yuanbao.token || data.token || '').trim();
        const deviceId = String(yuanbao.device_id || yuanbao.deviceId || data.device_id || data.deviceId || '').trim();
        if (!token) throw new Error('zuhaowang 缺少必要凭据字段: yuanbao.data.token');
        if (!deviceId) throw new Error('zuhaowang 缺少必要凭据字段: yuanbao.data.deviceId');
        return;
    }

    for (const key of rule.requiredKeys) {
        if (!ensureNonEmptyStringField(payloadObj, key)) {
            throw new Error(`${platform} 缺少必要凭据字段: ${key}`);
        }
    }
}

function getAesKey() {
    const raw = String(process.env.AUTH_PAYLOAD_AES_KEY || 'rent_task_default_auth_key_change_me').trim();
    return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

function decryptText(token) {
    const raw = String(token || '');
    const parts = raw.split(':');
    if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('密文格式不支持');

    const iv = Buffer.from(parts[1], 'hex');
    const tag = Buffer.from(parts[2], 'hex');
    const encrypted = Buffer.from(parts[3], 'hex');

    const decipher = crypto.createDecipheriv('aes-256-gcm', getAesKey(), iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
    return plain;
}

function parseStoredPayload(rawPayload) {
    const raw = String(rawPayload || '');
    if (!raw) return {};
    if (raw.startsWith('v1:')) {
        try {
            const plain = decryptText(raw);
            return JSON.parse(plain);
        } catch {
            return null;
        }
    }
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

async function migrateAuthPayloadToPlaintext(db) {
    const rows = await all(db, `
        SELECT id, auth_payload
        FROM user_platform_auth
        WHERE is_deleted = 0
          AND auth_payload LIKE 'v1:%'
    `);

    for (const row of rows) {
        const parsed = parseStoredPayload(row.auth_payload);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        await run(db, `
            UPDATE user_platform_auth
            SET auth_payload = ?, modify_date = ?
            WHERE id = ?
        `, [JSON.stringify(parsed), nowText(), Number(row.id)]);
    }
}

async function migrateZuhaowangPayloadToYuanbaoOnly(db) {
    const rows = await all(db, `
        SELECT id, auth_payload
        FROM user_platform_auth
        WHERE is_deleted = 0
          AND platform = 'zuhaowang'
    `);

    for (const row of rows) {
        const parsed = parseStoredPayload(row.auth_payload);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        const normalized = normalizeZuhaowangAuthPayloadForStorage(parsed);
        const nextPayload = JSON.stringify(normalized);
        if (nextPayload === String(row.auth_payload || '')) continue;
        await run(db, `
            UPDATE user_platform_auth
            SET auth_payload = ?, modify_date = ?
            WHERE id = ?
        `, [nextPayload, nowText(), Number(row.id)]);
    }
}

async function migrateUhaozuPayloadToDefaultHeaders(db) {
    const rows = await all(db, `
        SELECT id, auth_payload
        FROM user_platform_auth
        WHERE is_deleted = 0
          AND platform = 'uhaozu'
    `);

    for (const row of rows) {
        const parsed = parseStoredPayload(row.auth_payload);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        const normalized = normalizeUhaozuAuthPayloadForStorage(parsed);
        const nextPayload = JSON.stringify(normalized);
        if (nextPayload === String(row.auth_payload || '')) continue;
        await run(db, `
            UPDATE user_platform_auth
            SET auth_payload = ?, modify_date = ?
            WHERE id = ?
        `, [nextPayload, nowText(), Number(row.id)]);
    }
}

function isExpired(expireAt) {
    const value = String(expireAt || '').trim();
    if (!value) return false;
    const t = Date.parse(value);
    if (Number.isNaN(t)) return false;
    return t <= Date.now();
}

function rowToAuth(row = {}, options = {}) {
    const out = {
        id: Number(row.id || 0),
        user_id: Number(row.user_id || 0),
        platform: String(row.platform || ''),
        auth_type: String(row.auth_type || ''),
        auth_status: String(row.auth_status || ''),
        expire_at: String(row.expire_at || ''),
        channel_enabled: Number(row.channel_enabled === undefined ? 1 : row.channel_enabled) > 0,
        modify_date: String(row.modify_date || ''),
        is_deleted: Number(row.is_deleted || 0),
        desc: String(row.desc || '')
    };

    if (options.with_payload === true) {
        out.auth_payload = parseStoredPayload(row.auth_payload);
    }
    return out;
}

async function ensureUserPlatformAuthTableBase(db) {
    await run(db, `
        CREATE TABLE IF NOT EXISTS user_platform_auth (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            platform TEXT NOT NULL,
            auth_type TEXT NOT NULL,
            auth_payload TEXT NOT NULL,
            auth_status TEXT NOT NULL DEFAULT 'valid',
            expire_at TEXT DEFAULT '',
            channel_enabled INTEGER NOT NULL DEFAULT 1,
            modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            is_deleted INTEGER NOT NULL DEFAULT 0,
            desc TEXT NOT NULL DEFAULT ''
        )
    `);
    const cols = await all(db, `PRAGMA table_info("user_platform_auth")`);
    const hasChannelEnabled = cols.some((row) => String((row && row.name) || '').trim() === 'channel_enabled');
    if (!hasChannelEnabled) {
        await run(db, `ALTER TABLE user_platform_auth ADD COLUMN channel_enabled INTEGER NOT NULL DEFAULT 1`);
    }
}

async function ensureUserPlatformAuthIndexes(db) {
    await run(db, `
        CREATE UNIQUE INDEX IF NOT EXISTS uq_user_platform_auth_alive
        ON user_platform_auth(user_id, platform, is_deleted)
    `);
    await run(db, `
        CREATE INDEX IF NOT EXISTS idx_user_platform_auth_status
        ON user_platform_auth(user_id, auth_status, is_deleted)
    `);
}

let initUserPlatformAuthDbPromise = null;

async function initUserPlatformAuthDb() {
    if (initUserPlatformAuthDbPromise) return initUserPlatformAuthDbPromise;
    initUserPlatformAuthDbPromise = (async () => {
        const db = openDatabase();
        try {
            await ensureUserPlatformAuthTableBase(db);
            await ensureUserPlatformAuthIndexes(db);
        } finally {
            db.close();
        }
    })().catch((err) => {
        initUserPlatformAuthDbPromise = null;
        throw err;
    });
    return initUserPlatformAuthDbPromise;
}

async function upsertUserPlatformAuth(input = {}) {
    await initUserPlatformAuthDb();
    const userId = Number(input.user_id || 0);
    const platform = normalizePlatform(input.platform);
    const authType = normalizeAuthType(input.auth_type);
    const authStatus = normalizeAuthStatus(input.auth_status || 'valid');
    const authPayloadObj = normalizePlatformAuthPayload(platform, parseAuthPayload(input.auth_payload));
    const expireAt = String(input.expire_at || '').trim();
    const desc = String(input.desc || '').trim();

    if (!userId) throw new Error('user_id 不合法');
    validatePlatformAuth(platform, authType, authPayloadObj);

    const plainPayload = JSON.stringify(authPayloadObj);
    const db = openDatabase();
    try {
        const row = await get(db, `
            SELECT id, channel_enabled FROM user_platform_auth
            WHERE user_id = ? AND platform = ? AND is_deleted = 0
            LIMIT 1
        `, [userId, platform]);
        const channelEnabled = row
            ? normalizeChannelEnabled(
                input.channel_enabled === undefined ? row.channel_enabled : input.channel_enabled,
                Number(row.channel_enabled) > 0
            )
            : normalizeChannelEnabled(input.channel_enabled, true);

        if (!row) {
            await run(db, `
                INSERT INTO user_platform_auth
                (user_id, platform, auth_type, auth_payload, auth_status, expire_at, channel_enabled, modify_date, is_deleted, desc)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
            `, [userId, platform, authType, plainPayload, authStatus, expireAt, channelEnabled, nowText(), desc]);
        } else {
            await run(db, `
                UPDATE user_platform_auth
                SET auth_type = ?, auth_payload = ?, auth_status = ?, expire_at = ?, channel_enabled = ?, modify_date = ?, desc = ?
                WHERE id = ?
            `, [authType, plainPayload, authStatus, expireAt, channelEnabled, nowText(), desc, row.id]);
        }

        const updated = await get(db, `
            SELECT * FROM user_platform_auth
            WHERE user_id = ? AND platform = ? AND is_deleted = 0
            LIMIT 1
        `, [userId, platform]);
        return rowToAuth(updated, { with_payload: false });
    } finally {
        db.close();
    }
}

async function listUserPlatformAuth(userId, options = {}) {
    await initUserPlatformAuthDb();
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');

    const db = openDatabase();
    try {
        const rows = await all(db, `
            SELECT * FROM user_platform_auth
            WHERE user_id = ? AND is_deleted = 0
            ORDER BY id ASC
        `, [uid]);
        return rows.map((row) => rowToAuth(row, options));
    } finally {
        db.close();
    }
}

async function listValidPlatformsByUser(userId) {
    const rows = await listUserPlatformAuth(userId, { with_payload: false });
    return rows
        .filter((r) => r.channel_enabled !== false)
        .filter((r) => r.auth_status === 'valid')
        .filter((r) => !isExpired(r.expire_at))
        .map((r) => r.platform);
}

async function setPlatformChannelEnabled(userId, platform, enabled, desc = '') {
    await initUserPlatformAuthDb();
    const uid = Number(userId || 0);
    const pf = normalizePlatform(platform);
    const enabledInt = normalizeChannelEnabled(enabled, true);
    if (!uid) throw new Error('user_id 不合法');

    const db = openDatabase();
    try {
        const row = await get(db, `
            SELECT id
            FROM user_platform_auth
            WHERE user_id = ? AND platform = ? AND is_deleted = 0
            LIMIT 1
        `, [uid, pf]);
        if (!row) throw new Error(`user_id=${uid} 缺少 ${pf} 授权`);
        await run(db, `
            UPDATE user_platform_auth
            SET channel_enabled = ?, modify_date = ?, desc = ?
            WHERE id = ?
        `, [enabledInt, nowText(), String(desc || '').trim(), Number(row.id)]);
        const updated = await get(db, `
            SELECT *
            FROM user_platform_auth
            WHERE id = ?
            LIMIT 1
        `, [Number(row.id)]);
        return rowToAuth(updated, { with_payload: false });
    } finally {
        db.close();
    }
}

async function markPlatformAuthExpired(userId, platform, desc = '') {
    await initUserPlatformAuthDb();
    const uid = Number(userId || 0);
    const pf = normalizePlatform(platform);
    if (!uid) throw new Error('user_id 不合法');

    const db = openDatabase();
    try {
        const r = await run(db, `
            UPDATE user_platform_auth
            SET auth_status = 'expired', modify_date = ?, desc = ?
            WHERE user_id = ? AND platform = ? AND is_deleted = 0
        `, [nowText(), String(desc || ''), uid, pf]);
        return Number(r.changes || 0) > 0;
    } finally {
        db.close();
    }
}

module.exports = {
    PLATFORMS,
    AUTH_TYPES,
    AUTH_STATUS,
    initUserPlatformAuthDb,
    upsertUserPlatformAuth,
    listUserPlatformAuth,
    listValidPlatformsByUser,
    setPlatformChannelEnabled,
    markPlatformAuthExpired,
    _internal: {
        run,
        get,
        all,
        nowText,
        normalizeChannelEnabled,
        parseStoredPayload,
        migrateAuthPayloadToPlaintext,
        migrateZuhaowangPayloadToYuanbaoOnly,
        migrateUhaozuPayloadToDefaultHeaders,
        ensureUserPlatformAuthTableBase,
        ensureUserPlatformAuthIndexes
    }
};
