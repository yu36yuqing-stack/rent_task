const { getGoodsList } = require('../zuhaowang/zuhaowang_api');
const { collectUhaozuData } = require('../uhaozu/uhaozu_api');
const { collectYoupinData } = require('../uuzuhao/uuzuhao_api');
const {
    upsertUserGameAccount,
    listUserGameAccounts,
    isUserGameAccountManuallyDeleted
} = require('../database/user_game_account_db');
const { openDatabase } = require('../database/sqlite_client');
const { listUserPlatformAuth } = require('../database/user_platform_auth_db');
const { releaseOrderCooldownBlacklistByUser } = require('../order/order_cooldown');
const { normalizeZuhaowangAuthPayload } = require('../user/user');
const { normalizeGameProfile } = require('../common/game_profile');
const {
    upsertOpenProductSyncAnomaly,
    resolveOpenProductSyncAnomaly
} = require('../database/product_sync_anomaly_db');

const PLATFORM_ZHW = 'zuhaowang';
const PLATFORM_UHZ = 'uhaozu';
const PLATFORM_YYZ = 'uuzuhao';
const ORDER_MIRROR_RECOVER_MAX_AGE_MS = 3 * 24 * 3600 * 1000;

function keyOf(gameId, gameAccount) {
    return `${String(gameId || '1')}::${String(gameAccount || '')}`;
}

function mapChannelGameToStandard(platform, gameIdRaw, gameNameRaw) {
    const normalized = normalizeGameProfile(gameIdRaw, gameNameRaw, {
        preserveUnknown: true,
        fallbackId: platform === PLATFORM_YYZ ? '1' : '',
        fallbackName: 'WZRY'
    });
    return {
        game_id: normalized.game_id,
        game_name: normalized.game_name
    };
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
        const toYuanPrice = (value) => {
            const n = Number(value);
            if (!Number.isFinite(n)) return 0;
            return Number((n / 100).toFixed(2));
        };
        return {
            prd_id: String(row.id || ''),
            game_id: String(raw.gameId || ''),
            remark: String(row.remark || ''),
            role_name: String(raw.gameRoleName || ''),
            reason: String(row.reason || '').trim(),
            audit_reason: String(raw.auditReason || '').trim(),
            auth_status: raw.authStatus === undefined ? null : raw.authStatus,
            goods_status: Number(raw.goodsStatus),
            rent_status: Number(raw.rentStatus),
            customer_unshelves: Boolean(raw.customerUnshelves),
            rentalByHour: toYuanPrice(raw.concreteRentalByHour ?? raw.originRentalByHour ?? raw.rentalByHour),
            rentalByNight: toYuanPrice(raw.concreteRentalByNight ?? raw.originRentalByNight ?? raw.rentalByNight),
            rentalByDay: toYuanPrice(raw.concreteRentalByDay ?? raw.originRentalByDay ?? raw.rentalByDay),
            rentalByWeek: toYuanPrice(raw.concreteRentalByWeek ?? raw.originRentalByWeek ?? raw.rentalByWeek)
        };
    }
    if (platform === PLATFORM_YYZ) {
        const raw = row.raw && typeof row.raw === 'object' ? row.raw : {};
        return {
            prd_id: String(row.id || ''),
            game_id: String(raw.gameId || ''),
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

function dbAll(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

function dbGet(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row || null);
        });
    });
}

function isNonEmptyObject(input) {
    return Boolean(input && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length > 0);
}

function isRecentSnapshotTime(text = '', maxAgeMs = ORDER_MIRROR_RECOVER_MAX_AGE_MS) {
    const ts = Date.parse(String(text || '').trim().replace(' ', 'T'));
    if (!Number.isFinite(ts)) return false;
    return (Date.now() - ts) <= Math.max(0, Number(maxAgeMs || 0));
}

function hasPlatformBinding(row = {}, platform = '') {
    const info = row && row.channel_prd_info && typeof row.channel_prd_info === 'object'
        ? row.channel_prd_info
        : {};
    const one = info && typeof info[platform] === 'object' ? info[platform] : null;
    return Boolean(one && String(one.prd_id || '').trim());
}

function buildPlatformExpectedMap(rows = [], platform = '') {
    const out = new Map();
    for (const row of rows) {
        if (!hasPlatformBinding(row, platform)) continue;
        const acc = String((row && row.game_account) || '').trim();
        const gid = String((row && row.game_id) || '1').trim() || '1';
        if (!acc) continue;
        out.set(keyOf(gid, acc), {
            game_account: acc,
            game_id: gid,
            game_name: String((row && row.game_name) || 'WZRY').trim() || 'WZRY',
            account_remark: String((row && row.account_remark) || '').trim()
        });
    }
    return out;
}

async function reconcileProductSyncAnomalies(userId, existingRows = [], pulledByPlatform = {}, errors = []) {
    const uid = Number(userId || 0);
    if (!uid) return [];

    const out = [];
    const errorPlatforms = new Set(
        (Array.isArray(errors) ? errors : [])
            .map((msg) => String(msg || '').trim().split(':')[0])
            .filter((v) => v === PLATFORM_YYZ || v === PLATFORM_UHZ || v === PLATFORM_ZHW)
    );

    for (const platform of [PLATFORM_YYZ, PLATFORM_UHZ, PLATFORM_ZHW]) {
        if (errorPlatforms.has(platform)) continue;

        const expectedMap = buildPlatformExpectedMap(existingRows, platform);
        const pulledRows = Array.isArray(pulledByPlatform[platform]) ? pulledByPlatform[platform] : [];
        const pulledKeySet = new Set(
            pulledRows
                .map((row) => keyOf(row && row.game_id, row && row.game_account))
                .filter(Boolean)
        );
        const missingRows = [];
        for (const [fullKey, row] of expectedMap.entries()) {
            if (!pulledKeySet.has(fullKey)) missingRows.push(row);
        }

        if (missingRows.length > 0) {
            const sampleText = missingRows
                .slice(0, 6)
                .map((row) => `${row.game_name}/${row.game_account}`)
                .join(', ');
            const anomaly = await upsertOpenProductSyncAnomaly(uid, platform, {
                expected_count: expectedMap.size,
                pulled_count: pulledRows.length,
                missing_count: missingRows.length,
                missing_accounts: missingRows,
                sample_missing_text: sampleText,
                desc: `product sync missing platform=${platform}`
            });
            out.push(anomaly);
            continue;
        }

        await resolveOpenProductSyncAnomaly(uid, platform, {
            desc: `resolved by successful sync platform=${platform}`
        });
    }

    return out;
}

async function ensureLinkedGameAccountsByOrders(userId) {
    const uid = Number(userId || 0);
    if (!uid) return { mirrored: 0, skipped: 0 };

    const existingRows = await listAllUserGameAccountsByUser(uid);
    const byAccount = new Map();
    const byIdentity = new Map();
    for (const row of existingRows) {
        const acc = String((row && row.game_account) || '').trim();
        const gid = String((row && row.game_id) || '').trim();
        if (!acc) continue;
        const arr = byAccount.get(acc) || [];
        arr.push(row);
        byAccount.set(acc, arr);
        if (gid) byIdentity.set(`${gid}::${acc}`, row);
    }

    const db = openDatabase();
    try {
        const orderRows = await dbAll(db, `
            SELECT DISTINCT user_id, game_account, game_id, game_name, MAX(COALESCE(role_name, '')) AS role_name
            FROM "order"
            WHERE user_id = ?
              AND is_deleted = 0
              AND TRIM(COALESCE(game_account, '')) <> ''
              AND TRIM(COALESCE(game_id, '')) <> ''
            GROUP BY user_id, game_account, game_id, game_name
        `, [uid]);

        let mirrored = 0;
        let skipped = 0;
        for (const row of orderRows) {
            const acc = String(row.game_account || '').trim();
            const gameId = String(row.game_id || '').trim();
            const gameName = String(row.game_name || '').trim();
            if (!acc || !gameId) continue;
            if (await isUserGameAccountManuallyDeleted(uid, gameId, acc)) {
                skipped += 1;
                continue;
            }

            const identityKey = `${gameId}::${acc}`;
            const current = byAccount.get(acc) || [];
            const sameGameRow = byIdentity.get(identityKey) || current.find((x) => String(x.game_id || '').trim() === gameId) || null;
            const base = sameGameRow || current[0];
            let baseRow = base;
            if (!baseRow) {
                const deletedSnapshot = await dbGet(db, `
                    SELECT *
                    FROM user_game_account
                    WHERE user_id = ?
                      AND game_account = ?
                      AND game_id = ?
                      AND is_deleted = 1
                    ORDER BY id DESC
                    LIMIT 1
                `, [uid, acc, gameId]);
                if (deletedSnapshot && isRecentSnapshotTime(deletedSnapshot.modify_date)) {
                    let channelStatus = {};
                    let channelPrdInfo = {};
                    let accountSwitch = {};
                    try { channelStatus = JSON.parse(String(deletedSnapshot.channel_status || '{}')) || {}; } catch {}
                    try { channelPrdInfo = JSON.parse(String(deletedSnapshot.channel_prd_info || '{}')) || {}; } catch {}
                    try { accountSwitch = JSON.parse(String(deletedSnapshot.switch || '{}')) || {}; } catch {}
                    baseRow = {
                        account_remark: String(deletedSnapshot.account_remark || '').trim(),
                        channel_status: channelStatus,
                        channel_prd_info: channelPrdInfo,
                        switch: accountSwitch,
                        purchase_price: Number(deletedSnapshot.purchase_price || 0),
                        purchase_date: String(deletedSnapshot.purchase_date || '').slice(0, 10)
                    };
                } else if (!deletedSnapshot) {
                    baseRow = {
                        account_remark: String(row.role_name || '').trim(),
                        channel_status: {},
                        channel_prd_info: {},
                        switch: {},
                        purchase_price: 0,
                        purchase_date: ''
                    };
                } else {
                    skipped += 1;
                    continue;
                }
            }

            if (sameGameRow && isNonEmptyObject(sameGameRow.channel_status) && isNonEmptyObject(sameGameRow.channel_prd_info)) {
                continue;
            }

            const next = await upsertUserGameAccount({
                user_id: uid,
                game_account: acc,
                game_id: gameId,
                game_name: gameName,
                account_remark: String(baseRow.account_remark || row.role_name || '').trim(),
                channel_status: baseRow.channel_status || {},
                channel_prd_info: baseRow.channel_prd_info || {},
                switch: baseRow.switch || {},
                purchase_price: Number(baseRow.purchase_price || 0),
                purchase_date: String(baseRow.purchase_date || '').slice(0, 10),
                desc: 'mirror by linked order game'
            });
            current.push(next);
            byAccount.set(acc, current);
            byIdentity.set(identityKey, next);
            mirrored += 1;
        }

        return { mirrored, skipped };
    } finally {
        db.close();
    }
}

async function pullPlatformDataByAuth(platform, authPayload = {}) {
    if (platform === PLATFORM_ZHW) {
        const mergedAuth = normalizeZuhaowangAuthPayload(authPayload);
        const list = await getGoodsList(mergedAuth);
        return list.map((x) => ({
            ...mapChannelGameToStandard(PLATFORM_ZHW, x.gameId, x.gameName),
            game_account: String(x.account || '').trim(),
            status: String(x.status || '未知'),
            prd_info: buildPlatformPrdInfo(PLATFORM_ZHW, x)
        })).filter((x) => x.game_account);
    }

    if (platform === PLATFORM_UHZ) {
        const result = await collectUhaozuData(null, '', { auth: authPayload });
        const list = Array.isArray(result?.data) ? result.data : [];
        return list.map((x) => ({
            ...mapChannelGameToStandard(PLATFORM_UHZ, x && x.raw && x.raw.gameId, x && x.raw && x.raw.gameName),
            game_account: String(x.account || '').trim(),
            status: String(x.status || '未知'),
            prd_info: buildPlatformPrdInfo(PLATFORM_UHZ, x)
        })).filter((x) => x.game_account);
    }

    if (platform === PLATFORM_YYZ) {
        const result = await collectYoupinData(null, '', { auth: authPayload });
        const list = Array.isArray(result?.data) ? result.data : [];
        return list.map((x) => ({
            ...mapChannelGameToStandard(PLATFORM_YYZ, x && x.raw && x.raw.gameId, x && x.raw && x.raw.gameName),
            game_account: String(x.account || '').trim(),
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
    const validPlatforms = validAuthRows.map((r) => String(r.platform || '')).filter(Boolean);

    const merged = new Map();
    const errors = [];
    const pulled = {};
    const pulledRowsByPlatform = {};

    for (const row of validAuthRows) {
        const platform = String(row.platform || '');
        const authPayload = row.auth_payload || {};
        try {
            const pulledRows = await pullPlatformDataByAuth(platform, authPayload);
            pulled[platform] = pulledRows.length;
            pulledRowsByPlatform[platform] = pulledRows;
            for (const item of pulledRows) {
                const k = keyOf(item.game_id, item.game_account);
                const cur = merged.get(k) || {
                    game_account: item.game_account,
                    game_id: String(item.game_id || '1'),
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
        if (await isUserGameAccountManuallyDeleted(uid, item.game_id, item.game_account)) {
            continue;
        }
        await upsertUserGameAccount({
            user_id: uid,
            game_account: item.game_account,
            game_id: item.game_id,
            game_name: item.game_name,
            account_remark: item.account_remark,
            channel_status: item.channel_status,
            channel_prd_info: item.channel_prd_info,
            desc: 'sync by accounts/sync'
        });
        upserted += 1;
    }

    const mirroredByOrders = await ensureLinkedGameAccountsByOrders(uid);
    const currentRows = await listAllUserGameAccountsByUser(uid);
    const anomalies = await reconcileProductSyncAnomalies(uid, currentRows, pulledRowsByPlatform, errors);

    return {
        ok: errors.length === 0,
        user_id: uid,
        platforms: validPlatforms,
        pulled,
        upserted,
        mirrored_by_orders: mirroredByOrders,
        cleaned: 0,
        anomalies,
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
    listAllUserGameAccountsByUser,
    ensureLinkedGameAccountsByOrders,
    _internals: {
        buildPlatformPrdInfo
    }
};
