const {
    initUserDb,
    createUserByAdmin,
    verifyUserLogin,
    getActiveUserByAccount,
    getActiveUserById,
    listActiveUsers
} = require('../database/user_db');
const { listBlacklistedAccountsByUser, listUserBlacklistByUser } = require('../database/user_blacklist_db');
const { buildProjectedBlacklistByUser, getBlacklistV2Mode } = require('../blacklist/blacklist_reconciler');

async function initUserModule() {
    await initUserDb();
}

async function login(account, password) {
    return verifyUserLogin(account, password);
}

// 当前业务无自助注册入口，用户数据仅允许管理员预置。
async function register() {
    throw new Error('当前未开放注册入口，请由管理员创建用户');
}

function isAuthUsable(row = {}) {
    if (!row || typeof row !== 'object') return false;
    if (String(row.auth_status || '') !== 'valid') return false;
    const exp = String(row.expire_at || '').trim();
    if (!exp) return true;
    const t = Date.parse(exp);
    if (Number.isNaN(t)) return true;
    return t > Date.now();
}

function normalizeZuhaowangAuthPayload(payload = {}) {
    const raw = payload && typeof payload === 'object' ? payload : {};
    const yuanbao = raw.yuanbao && typeof raw.yuanbao === 'object' ? raw.yuanbao : {};
    const yuanbaoData = yuanbao.data && typeof yuanbao.data === 'object' ? yuanbao.data : {};

    const tokenYuanbao = String(
        yuanbao.token_yuanbao
        || yuanbao.token
        || yuanbaoData.token
        || ''
    ).trim();
    const packageName = String(
        yuanbao.package_name
        || yuanbao.packageName
        || (tokenYuanbao ? 'com.duodian.merchant' : '')
        || ''
    ).trim();
    const deviceId = String(
        yuanbao.device_id
        || yuanbao.deviceId
        || yuanbaoData.device_id
        || yuanbaoData.deviceId
        || ''
    ).trim();

    return {
        ...(yuanbao || {}),
        token_yuanbao: tokenYuanbao,
        token_get: String(tokenYuanbao || '').trim(),
        token_post: String(tokenYuanbao || '').trim(),
        device_id: deviceId,
        package_name: packageName,
        source: String(yuanbao.source || 'android').trim() || 'android',
        app_version: String(yuanbao.app_version || yuanbao.x_versioncode || '2.1.6').trim(),
        main_version: String(yuanbao.main_version || yuanbao.x_versioncode || '2.1.6').trim(),
        x_versioncode: String(yuanbao.x_versioncode || yuanbao.app_version || '2.1.6').trim(),
        x_versionnumber: String(yuanbao.x_versionnumber || '216').trim(),
        x_channel: String(yuanbao.x_channel || 'ybxiaomi').trim()
    };
}

function resolveAuthPayloadByPlatform(platform, payload = {}) {
    const p = String(platform || '').trim();
    const raw = payload && typeof payload === 'object' ? payload : {};

    // 租号王统一只读 yuanbao 授权结构。
    if (p === 'zuhaowang') {
        return normalizeZuhaowangAuthPayload(raw);
    }

    return raw;
}

function buildAuthMap(rows = []) {
    const map = {};
    for (const row of rows) {
        if (!isAuthUsable(row)) continue;
        const platform = String(row.platform || '').trim();
        if (!platform) continue;
        map[platform] = resolveAuthPayloadByPlatform(platform, row.auth_payload || {});
    }
    return map;
}

async function loadUserBlacklistSet(userId) {
    try {
        const mode = Number(getBlacklistV2Mode());
        if (mode >= 2) {
            const projected = await buildProjectedBlacklistByUser(userId, { include_legacy_bootstrap: true });
            return new Set(Object.keys(projected));
        }
        const rows = await listBlacklistedAccountsByUser(userId);
        return new Set(rows);
    } catch (e) {
        console.warn(`[Blacklist] 读取用户黑名单失败 user=${userId}: ${e.message}`);
        return new Set();
    }
}

async function loadUserBlacklistReasonMap(userId) {
    try {
        const mode = Number(getBlacklistV2Mode());
        if (mode >= 2) {
            const projected = await buildProjectedBlacklistByUser(userId, { include_legacy_bootstrap: true });
            const out = {};
            for (const acc of Object.keys(projected || {})) {
                out[acc] = String((((projected || {})[acc] || {}).reason) || '').trim();
            }
            return out;
        }
        const rows = await listUserBlacklistByUser(userId);
        const out = {};
        for (const row of rows) {
            const acc = String((row && row.game_account) || '').trim();
            if (!acc) continue;
            out[acc] = String((row && row.reason) || '').trim();
        }
        return out;
    } catch (e) {
        console.warn(`[Blacklist] 读取用户黑名单原因失败 user=${userId}: ${e.message}`);
        return {};
    }
}

module.exports = {
    initUserModule,
    login,
    register,
    isAuthUsable,
    normalizeZuhaowangAuthPayload,
    resolveAuthPayloadByPlatform,
    buildAuthMap,
    loadUserBlacklistSet,
    loadUserBlacklistReasonMap,
    createUserByAdmin,
    getActiveUserByAccount,
    getActiveUserById,
    listActiveUsers
};
