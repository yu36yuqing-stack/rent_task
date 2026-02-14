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

function buildAuthMap(rows = []) {
    const map = {};
    for (const row of rows) {
        if (!isAuthUsable(row)) continue;
        const platform = String(row.platform || '').trim();
        if (!platform) continue;
        map[platform] = row.auth_payload || {};
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
    buildAuthMap,
    loadUserBlacklistSet,
    loadUserBlacklistReasonMap,
    createUserByAdmin,
    getActiveUserByAccount,
    getActiveUserById,
    listActiveUsers
};
