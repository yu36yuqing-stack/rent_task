const { getGoodsList } = require('../zuhaowang/zuhaowang_api');
const { collectUhaozuData } = require('../uhaozu/uhaozu_api');
const { collectYoupinData } = require('../uuzuhao/uuzuhao_api');
const {
    upsertUserGameAccount,
    listUserGameAccounts,
    clearPlatformStatusForUser,
    softDeleteEmptyAccountsByUser
} = require('../database/user_game_account_db');
const { listUserPlatformAuth } = require('../database/user_platform_auth_db');
const { releaseOrderCooldownBlacklistByUser } = require('../order/order_cooldown');

const PLATFORM_ZHW = 'zuhaowang';
const PLATFORM_UHZ = 'uhaozu';
const PLATFORM_YYZ = 'uuzuhao';

function keyOf(gameName, gameAccount) {
    return `${String(gameName || 'WZRY')}::${String(gameAccount || '')}`;
}

function normalizeGameName(raw) {
    const v = String(raw || '').trim();
    if (!v) return 'WZRY';
    if (v === '王者荣耀' || v.toLowerCase() === 'wzry' || v === '王者') return 'WZRY';
    return v;
}

function buildPlatformPrdInfo(platform, row = {}) {
    if (platform === PLATFORM_ZHW) {
        return {
            prd_id: String(row.id || ''),
            game_id: String(row.gameId || ''),
            remark: String(row.roleName || ''),
            role_name: String(row.roleName || ''),
            raw_status: Number(row.rawStatus),
            exception_msg: String(row.exceptionMsg || '').trim()
        };
    }
    if (platform === PLATFORM_UHZ) {
        const raw = row.raw && typeof row.raw === 'object' ? row.raw : {};
        return {
            prd_id: String(row.id || ''),
            remark: String(row.remark || ''),
            role_name: String(raw.gameRoleName || ''),
            reason: String(row.reason || '').trim(),
            audit_reason: String(raw.auditReason || '').trim(),
            auth_status: raw.authStatus === undefined ? null : raw.authStatus,
            goods_status: Number(raw.goodsStatus),
            rent_status: Number(raw.rentStatus),
            customer_unshelves: Boolean(raw.customerUnshelves)
        };
    }
    if (platform === PLATFORM_YYZ) {
        const raw = row.raw && typeof row.raw === 'object' ? row.raw : {};
        return {
            prd_id: String(row.id || ''),
            remark: String(row.remark || ''),
            role_name: String(raw.roleName || ''),
            reason: String(row.reason || '').trim(),
            sale_status: raw.saleStatus === undefined ? null : Number(raw.saleStatus),
            product_status: raw.productStatus === undefined ? null : Number(raw.productStatus),
            tab_key: String(raw._tabKey || '').trim().toUpperCase()
        };
    }
    return {};
}

// Legacy path (hardcoded credentials) is intentionally disabled.

function isAuthUsable(row = {}) {
    if (!row || typeof row !== 'object') return false;
    if (String(row.auth_status || '') !== 'valid') return false;
    const exp = String(row.expire_at || '').trim();
    if (exp) {
        const t = Date.parse(exp);
        if (!Number.isNaN(t) && t <= Date.now()) return false;
    }
    return true;
}

async function pullPlatformDataByAuth(platform, authPayload = {}) {
    if (platform === PLATFORM_ZHW) {
        const nested = authPayload && typeof authPayload === 'object' && authPayload.zuhaowang && typeof authPayload.zuhaowang === 'object'
            ? authPayload.zuhaowang
            : authPayload;
        const list = await getGoodsList(nested);
        return list.map((x) => ({
            game_account: String(x.account || '').trim(),
            game_name: normalizeGameName(x.gameName || 'WZRY'),
            status: String(x.status || '未知'),
            prd_info: buildPlatformPrdInfo(PLATFORM_ZHW, x)
        })).filter((x) => x.game_account);
    }

    if (platform === PLATFORM_UHZ) {
        const result = await collectUhaozuData(null, '', { auth: authPayload });
        const list = Array.isArray(result?.data) ? result.data : [];
        return list.map((x) => ({
            game_account: String(x.account || '').trim(),
            game_name: 'WZRY',
            status: String(x.status || '未知'),
            prd_info: buildPlatformPrdInfo(PLATFORM_UHZ, x)
        })).filter((x) => x.game_account);
    }

    if (platform === PLATFORM_YYZ) {
        const result = await collectYoupinData(null, '', { auth: authPayload });
        const list = Array.isArray(result?.data) ? result.data : [];
        return list.map((x) => ({
            game_account: String(x.account || '').trim(),
            game_name: 'WZRY',
            status: String(x.status || '未知'),
            prd_info: buildPlatformPrdInfo(PLATFORM_YYZ, x),
            account_remark: String((x.raw && x.raw.roleName) || '')
        })).filter((x) => x.game_account);
    }

    throw new Error(`不支持的平台: ${platform}`);
}

async function syncUserAccountsByAuth(userId) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');

    // 先释放已到期的“冷却期下架”黑名单，再进入本轮商品状态拉取，
    // 保证后续上架判断读取到的是最新黑名单状态。
    let cooldownRelease = { skipped: true, reason: 'not_run' };
    try {
        cooldownRelease = await releaseOrderCooldownBlacklistByUser(uid);
        console.log(`[CooldownRelease] user_id=${uid} result=${JSON.stringify(cooldownRelease)}`);
    } catch (e) {
        cooldownRelease = { error: String(e && e.message ? e.message : e) };
        console.warn(`[CooldownRelease] user_id=${uid} failed=${cooldownRelease.error}`);
    }

    const rows = await listUserPlatformAuth(uid, { with_payload: true });
    const validAuthRows = rows
        .filter(isAuthUsable)
        .filter((r) => r && r.auth_payload && typeof r.auth_payload === 'object');
    if (validAuthRows.length === 0) {
        throw new Error('当前用户没有可用的平台授权，请先 upsert 平台授权');
    }
    // 先清空三平台历史状态，避免已撤销授权的平台残留旧状态干扰策略判断。
    // 注意：channel_prd_info 不清空，只在后续 upsert 时增量更新，保留稳定的平台商品映射。
    for (const platform of [PLATFORM_ZHW, PLATFORM_UHZ, PLATFORM_YYZ]) {
        await clearPlatformStatusForUser(uid, platform);
    }
    const validPlatforms = validAuthRows.map((r) => String(r.platform || '')).filter(Boolean);

    const merged = new Map();
    const errors = [];
    const pulled = {};

    for (const row of validAuthRows) {
        const platform = String(row.platform || '');
        const authPayload = row.auth_payload || {};
        try {
            const pulledRows = await pullPlatformDataByAuth(platform, authPayload);
            pulled[platform] = pulledRows.length;
            for (const item of pulledRows) {
                const k = keyOf(item.game_name, item.game_account);
                const cur = merged.get(k) || {
                    game_account: item.game_account,
                    game_name: item.game_name,
                    channel_status: {},
                    channel_prd_info: {},
                    account_remark: ''
                };
                cur.channel_status[platform] = item.status;
                cur.channel_prd_info[platform] = item.prd_info || {};
                if (platform === PLATFORM_YYZ) {
                    const remark = String(item.account_remark || '').trim();
                    if (remark) cur.account_remark = remark;
                }
                merged.set(k, cur);
            }
        } catch (e) {
            errors.push(`${platform}: ${e.message}`);
        }
    }

    let upserted = 0;
    for (const item of merged.values()) {
        await upsertUserGameAccount({
            user_id: uid,
            game_account: item.game_account,
            game_name: item.game_name,
            account_remark: item.account_remark,
            channel_status: item.channel_status,
            channel_prd_info: item.channel_prd_info,
            desc: 'sync by accounts/sync'
        });
        upserted += 1;
    }

    const cleaned = await softDeleteEmptyAccountsByUser(uid);

    return {
        ok: errors.length === 0,
        user_id: uid,
        platforms: validPlatforms,
        pulled,
        upserted,
        cleaned,
        order_cooldown_release: cooldownRelease,
        errors
    };
}

async function listAllUserGameAccountsByUser(userId) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    const rows = [];
    let page = 1;
    const pageSize = 200;
    while (page <= 200) {
        const r = await listUserGameAccounts(uid, page, pageSize);
        const list = Array.isArray(r.list) ? r.list : [];
        rows.push(...list);
        if (list.length < pageSize) break;
        page += 1;
    }
    return rows;
}

module.exports = {
    syncUserAccountsByAuth,
    listAllUserGameAccountsByUser
};
