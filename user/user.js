const {
    initUserDb,
    createUserByAdmin,
    verifyUserLogin,
    getActiveUserByAccount,
    getActiveUserById,
    listActiveUsers
} = require('../database/user_db');
const { listBlacklistedAccountsByUser, listUserBlacklistByUser } = require('../database/user_blacklist_db');

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
    const nested = raw.zuhaowang && typeof raw.zuhaowang === 'object' ? raw.zuhaowang : raw;
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
        || nested.package_name
        || ''
    ).trim();
    const deviceId = String(
        yuanbao.device_id
        || yuanbao.deviceId
        || yuanbaoData.device_id
        || yuanbaoData.deviceId
        || nested.device_id
        || ''
    ).trim();

    return {
        ...(nested || {}),
        ...(yuanbao || {}),
        token_yuanbao: tokenYuanbao,
        token_get: String(nested.token_get || tokenYuanbao || '').trim(),
        token_post: String(nested.token_post || tokenYuanbao || '').trim(),
        device_id: deviceId,
        package_name: packageName,
        source: String(yuanbao.source || nested.source || 'android').trim() || 'android',
        app_version: String(yuanbao.app_version || nested.app_version || nested.x_versioncode || '2.1.6').trim(),
        main_version: String(yuanbao.main_version || nested.main_version || nested.x_versioncode || '2.1.6').trim(),
        x_versioncode: String(yuanbao.x_versioncode || nested.x_versioncode || nested.app_version || '2.1.6').trim(),
        x_versionnumber: String(yuanbao.x_versionnumber || nested.x_versionnumber || '216').trim(),
        x_channel: String(yuanbao.x_channel || nested.x_channel || 'ybxiaomi').trim()
    };
}

function resolveAuthPayloadByPlatform(platform, payload = {}) {
    const p = String(platform || '').trim();
    const raw = payload && typeof payload === 'object' ? payload : {};

    // 兼容租号王授权结构升级：
    // - 旧结构：auth_payload.token_get/token_post...
    // - 新结构：auth_payload.zuhaowang.{token_get/token_post...}
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
        const rows = await listBlacklistedAccountsByUser(userId);
        return new Set(rows);
    } catch (e) {
        console.warn(`[Blacklist] 读取用户黑名单失败 user=${userId}: ${e.message}`);
        return new Set();
    }
}

async function loadUserBlacklistReasonMap(userId) {
    try {
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
