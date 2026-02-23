#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { initUserDb, verifyUserLogin, getActiveUserById } = require('../database/user_db');
const {
    initUserGameAccountDb,
    listUserGameAccounts,
    updateUserGameAccountPurchaseByUserAndAccount
} = require('../database/user_game_account_db');
const {
    initUserBlacklistDb,
    listUserBlacklistByUserWithMeta,
    upsertUserBlacklistEntry,
    hardDeleteUserBlacklistEntry
} = require('../database/user_blacklist_db');
const {
    RESTRICT_REASON,
    initUserPlatformRestrictDb,
    listPlatformRestrictByUserAndAccounts,
    removePlatformRestrict
} = require('../database/user_platform_restrict_db');
const {
    initOrderDb,
    listTodayPaidOrderCountByAccounts,
    listRolling24hPaidOrderCountByAccounts,
    listRentingOrderWindowByAccounts
} = require('../database/order_db');
const { listUserPlatformAuth } = require('../database/user_platform_auth_db');
const {
    initUserSessionDb,
    createRefreshSession,
    verifyRefreshSession,
    revokeRefreshSession
} = require('../database/user_session_db');
const {
    initUserRuleDb,
    getUserRuleByName,
    upsertUserRuleByName
} = require('../database/user_rule_db');
const { createAccessToken, createOpaqueRefreshToken } = require('../user/auth_token');
const { parseAccessTokenOrThrow } = require('../api/auth_middleware');
const { queryAccountOnlineStatus, setForbiddenPlay } = require('../uuzuhao/uuzuhao_api');
const { syncUserAccountsByAuth } = require('../product/product');
const {
    buildPlatformStatusNorm,
    pickOverallStatusNorm,
    isRestrictedLikeStatus
} = require('../product/prod_channel_status');
const { listOrdersForUser, syncOrdersByUser } = require('../order/order');
const { tryAcquireLock, releaseLock } = require('../database/lock_db');
const { createAuthBff } = require('./h5_bff/auth_bff');
const { createOrderBff } = require('./h5_bff/order_bff');
const {
    getOrderStatsDashboardByUser,
    refreshOrderStatsDailyByUser,
    getIncomeCalendarByUser
} = require('../stats/order_stats');

const HOST = process.env.H5_HOST || '0.0.0.0';
const PORT = Number(process.env.H5_PORT || 8080);
const PUBLIC_DIR = path.join(__dirname, 'public');
const H5_REFRESH_TTL_REMEMBER_SEC = Number(process.env.H5_REFRESH_TTL_REMEMBER_SEC || (7 * 24 * 3600));
const H5_REFRESH_TTL_SESSION_SEC = Number(process.env.H5_REFRESH_TTL_SESSION_SEC || (12 * 3600));
const ORDER_OFF_THRESHOLD_RULE_NAME = 'X单下架阈值';
const ORDER_OFF_MODE_NATURAL_DAY = 'natural_day';
const ORDER_OFF_MODE_ROLLING_24H = 'rolling_24h';
const ORDER_SYNC_LOCK_KEY = String(process.env.ORDER_SYNC_LOCK_KEY || 'order_sync_all_users');
const ORDER_SYNC_LOCK_LEASE_SEC = Math.max(60, Number(process.env.ORDER_SYNC_LOCK_LEASE_SEC || 1800));
const STATS_REFRESH_LOCK_WAIT_MS = Math.max(0, Number(process.env.STATS_REFRESH_LOCK_WAIT_MS || 120000));
const STATS_REFRESH_LOCK_POLL_MS = Math.max(200, Number(process.env.STATS_REFRESH_LOCK_POLL_MS || 800));
const COOLDOWN_BLACKLIST_REASON = '冷却期下架';
const authBff = createAuthBff({ requireAuth, readJsonBody, json });
const orderBff = createOrderBff({ requireAuth, json });
function normalizeOrderOffThreshold(v, fallback = 3) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(1, Math.min(10, Math.floor(n)));
}

function normalizeOrderOffMode(v, fallback = ORDER_OFF_MODE_NATURAL_DAY) {
    const text = String(v || '').trim().toLowerCase();
    if (text === ORDER_OFF_MODE_ROLLING_24H) return ORDER_OFF_MODE_ROLLING_24H;
    if (text === ORDER_OFF_MODE_NATURAL_DAY) return ORDER_OFF_MODE_NATURAL_DAY;
    return fallback;
}

function orderOffModeLabel(mode) {
    return mode === ORDER_OFF_MODE_ROLLING_24H ? '滑动窗口' : '自然日';
}

async function getOrderOffRuleByUser(userId) {
    const rule = await getUserRuleByName(userId, ORDER_OFF_THRESHOLD_RULE_NAME);
    const detail = rule && rule.rule_detail && typeof rule.rule_detail === 'object' ? rule.rule_detail : {};
    const threshold = normalizeOrderOffThreshold(detail.threshold ?? detail.order_off_threshold ?? detail.value, 3);
    const mode = normalizeOrderOffMode(detail.mode ?? detail.order_off_mode, ORDER_OFF_MODE_NATURAL_DAY);
    return { threshold, mode };
}

function json(res, code, payload) {
    res.writeHead(code, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(payload));
}

function text(res, code, payload, contentType = 'text/plain; charset=utf-8') {
    res.writeHead(code, {
        'Content-Type': contentType,
        'Cache-Control': 'no-store'
    });
    res.end(payload);
}

function httpError(statusCode, message) {
    const e = new Error(String(message || '请求失败'));
    e.statusCode = Number(statusCode || 500);
    return e;
}

function parseBearer(req) {
    const auth = String(req.headers.authorization || '').trim();
    if (!auth.toLowerCase().startsWith('bearer ')) return '';
    return auth.slice(7).trim();
}

async function readJsonBody(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString('utf8').trim();
    if (!raw) return {};
    try {
        return JSON.parse(raw);
    } catch {
        throw new Error('请求体必须是合法 JSON');
    }
}

async function requireAuth(req) {
    const token = parseBearer(req);
    if (!token) throw httpError(401, '未登录或 token 缺失');
    let user = null;
    try {
        ({ user } = await parseAccessTokenOrThrow(token));
    } catch (e) {
        throw httpError(401, e.message || 'token 无效或已过期');
    }
    return user;
}

function normalizePage(v, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(1, Math.floor(n));
}

function parseCooldownUntilSecFromDesc(descText) {
    const raw = String(descText || '').trim();
    if (!raw) return 0;
    try {
        const obj = JSON.parse(raw);
        const sec = Number((obj && obj.cooldown_until) || 0);
        return Number.isFinite(sec) && sec > 0 ? sec : 0;
    } catch {
        return 0;
    }
}

function formatDateTimeByUnixSec(sec) {
    const n = Number(sec || 0);
    if (!Number.isFinite(n) || n <= 0) return '';
    const d = new Date(n * 1000);
    if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '';
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function resolveBlacklistDisplayDate(row = {}) {
    const createDate = String((row && row.create_date) || '').trim();
    const reason = String((row && row.reason) || '').trim();
    if (reason !== COOLDOWN_BLACKLIST_REASON) return createDate;
    const untilSec = parseCooldownUntilSecFromDesc(row.desc);
    const cooldownDate = formatDateTimeByUnixSec(untilSec);
    return cooldownDate || createDate;
}

function resolveProductDisplayName(row = {}, fallbackAccount = '') {
    const acc = String(fallbackAccount || '').trim();
    const channelPrdInfo = row && typeof row.channel_prd_info === 'object' ? row.channel_prd_info : {};
    const uuzuhao = channelPrdInfo && typeof channelPrdInfo.uuzuhao === 'object' ? channelPrdInfo.uuzuhao : {};
    const uuzuhaoRemark = String((uuzuhao && uuzuhao.remark) || '').trim();
    if (uuzuhaoRemark) return uuzuhaoRemark;
    const roleName = String((row && row.account_remark) || '').trim();
    if (roleName) return roleName;
    return acc;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

async function acquireOrderSyncLockWithWait(options = {}) {
    const key = String(options.key || ORDER_SYNC_LOCK_KEY).trim() || ORDER_SYNC_LOCK_KEY;
    const owner = String(options.owner || '').trim() || `pid=${process.pid}`;
    const leaseSec = Math.max(60, Number(options.lease_sec || ORDER_SYNC_LOCK_LEASE_SEC));
    const waitMs = Math.max(0, Number(options.wait_ms || 0));
    const pollMs = Math.max(200, Number(options.poll_ms || STATS_REFRESH_LOCK_POLL_MS));
    const beginAt = Date.now();
    const deadline = beginAt + waitMs;
    let lastLeaseUntil = 0;

    while (true) {
        const lock = await tryAcquireLock(key, leaseSec, owner);
        if (lock && lock.acquired) {
            return {
                acquired: true,
                lock_key: key,
                lease_until: Number(lock.lease_until || 0),
                waited_ms: Date.now() - beginAt
            };
        }
        lastLeaseUntil = Number((lock && lock.lease_until) || 0);
        if (Date.now() >= deadline) {
            return {
                acquired: false,
                lock_key: key,
                lease_until: lastLeaseUntil,
                waited_ms: Date.now() - beginAt
            };
        }
        const nowSec = Math.floor(Date.now() / 1000);
        const msByLease = lastLeaseUntil > nowSec ? (lastLeaseUntil - nowSec) * 1000 : pollMs;
        const remainMs = Math.max(0, deadline - Date.now());
        await sleep(Math.min(remainMs, Math.max(pollMs, Math.min(3000, msByLease))));
    }
}

function isRentingByChannelStatus(channelStatus) {
    const s = channelStatus && typeof channelStatus === 'object' ? channelStatus : {};
    return ['uuzuhao', 'uhaozu', 'zuhaowang'].some((k) => String(s[k] || '').trim() === '租赁中');
}

async function listAllAccountsByUser(userId) {
    let page = 1;
    const pageSize = 200;
    let total = 0;
    const out = [];
    while (true) {
        const r = await listUserGameAccounts(userId, page, pageSize);
        total = Number(r.total || 0);
        const list = Array.isArray(r.list) ? r.list : [];
        out.push(...list);
        if (out.length >= total || list.length === 0) break;
        page += 1;
    }
    return { total, list: out };
}

async function handleLogin(req, res) {
    const body = await readJsonBody(req);
    const account = String(body.account || '').trim();
    const password = String(body.password || '');
    const remember = Boolean(body.remember === true || String(body.remember || '').trim().toLowerCase() === 'true');
    if (!account || !password) {
        return json(res, 400, { ok: false, message: '账号和密码不能为空' });
    }
    const result = await verifyUserLogin(account, password);
    if (!result.ok) {
        return json(res, 401, { ok: false, message: result.reason || '登录失败' });
    }
    const token = createAccessToken(result.user);
    const refreshToken = createOpaqueRefreshToken();
    const refreshTtlSec = remember ? H5_REFRESH_TTL_REMEMBER_SEC : H5_REFRESH_TTL_SESSION_SEC;
    await createRefreshSession(result.user.id, refreshToken, refreshTtlSec, `h5 login remember=${remember ? '1' : '0'}`);
    return json(res, 200, {
        ok: true,
        token,
        access_token: token,
        refresh_token: refreshToken,
        refresh_ttl_sec: refreshTtlSec,
        remember,
        user: {
            id: result.user.id,
            account: result.user.account,
            name: result.user.name,
            user_type: result.user.user_type
        }
    });
}

async function handleRefresh(req, res) {
    const body = await readJsonBody(req);
    const refreshToken = String(body.refresh_token || '').trim();
    const remember = Boolean(body.remember === true || String(body.remember || '').trim().toLowerCase() === 'true');
    if (!refreshToken) {
        throw httpError(401, 'refresh_token 不能为空');
    }
    const verify = await verifyRefreshSession(refreshToken);
    if (!verify.ok || !verify.user_id) {
        throw httpError(401, verify.reason || 'refresh_token 无效');
    }

    const user = await getActiveUserById(verify.user_id);
    if (!user || String(user.status || '') !== 'enabled') {
        await revokeRefreshSession(refreshToken);
        throw httpError(401, '用户不存在或已禁用');
    }

    await revokeRefreshSession(refreshToken);
    const nextRefreshToken = createOpaqueRefreshToken();
    const refreshTtlSec = remember ? H5_REFRESH_TTL_REMEMBER_SEC : H5_REFRESH_TTL_SESSION_SEC;
    await createRefreshSession(user.id, nextRefreshToken, refreshTtlSec, `h5 refresh remember=${remember ? '1' : '0'}`);
    const accessToken = createAccessToken(user);
    return json(res, 200, {
        ok: true,
        token: accessToken,
        access_token: accessToken,
        refresh_token: nextRefreshToken,
        refresh_ttl_sec: refreshTtlSec,
        remember,
        user: {
            id: user.id,
            account: user.account,
            name: user.name,
            user_type: user.user_type
        }
    });
}

async function handleProducts(req, res, urlObj) {
    const user = await requireAuth(req);
    const page = normalizePage(urlObj.searchParams.get('page'), 1);
    const pageSize = Math.min(200, normalizePage(urlObj.searchParams.get('page_size'), 20));
    const filterRaw = String(urlObj.searchParams.get('filter') || 'all').trim().toLowerCase();
    const filter = (filterRaw === 'restricted' || filterRaw === 'renting' || filterRaw === 'all')
        ? filterRaw
        : 'all';
    const blacklistRows = await listUserBlacklistByUserWithMeta(user.id);
    const blacklistMap = {};
    for (const row of blacklistRows) {
        const acc = String((row && row.game_account) || '').trim();
        if (!acc) continue;
        blacklistMap[acc] = {
            reason: String((row && row.reason) || '').trim(),
            remark: String((row && row.remark) || '').trim(),
            create_date: String((row && row.create_date) || '').trim(),
            display_date: resolveBlacklistDisplayDate(row)
        };
    }

    const orderOffRule = await getOrderOffRuleByUser(user.id);
    const allRows = await listAllAccountsByUser(user.id);
    const allAccs = allRows.list.map((x) => String(x.game_account || '').trim()).filter(Boolean);
    const accountRowMap = new Map(
        allRows.list.map((x) => [String((x && x.game_account) || '').trim(), x]).filter(([acc]) => Boolean(acc))
    );
    const paidMap = allAccs.length > 0
        ? (orderOffRule.mode === ORDER_OFF_MODE_ROLLING_24H
            ? await listRolling24hPaidOrderCountByAccounts(user.id, allAccs)
            : await listTodayPaidOrderCountByAccounts(user.id, allAccs))
        : {};
    const rentingWindowMap = allAccs.length > 0
        ? await listRentingOrderWindowByAccounts(user.id, allAccs)
        : {};
    const restrictRowsRaw = allAccs.length > 0 ? await listPlatformRestrictByUserAndAccounts(user.id, allAccs) : [];
    const restrictRows = [];
    for (const row of restrictRowsRaw) {
        const acc = String((row && row.game_account) || '').trim();
        const detail = row && typeof row.detail === 'object' ? row.detail : {};
        const platform = String((row && row.platform) || detail.platform || '').trim();
        const hit = accountRowMap.get(acc);
        const channelStatus = hit && typeof hit.channel_status === 'object' ? hit.channel_status : {};
        const statusText = String((channelStatus && channelStatus[platform]) || '').trim();
        const shouldClear = Boolean(platform) && ['上架', '租赁中', '出租中'].includes(statusText);
        if (shouldClear) {
            await removePlatformRestrict(user.id, acc, platform, `auto clear by products status=${statusText}`).catch(() => {});
            continue;
        }
        restrictRows.push(row);
    }
    const restrictMap = {};
    const restrictPlatformMap = {};
    for (const row of restrictRows) {
        const acc = String((row && row.game_account) || '').trim();
        if (!acc) continue;
        if (!restrictMap[acc]) restrictMap[acc] = [];
        if (!restrictPlatformMap[acc]) restrictPlatformMap[acc] = {};
        const detail = row && typeof row.detail === 'object' ? row.detail : {};
        const platform = String((row && row.platform) || detail.platform || '').trim();
        const msg = String(detail.msg || '').trim();
        const platformName = platform === 'uuzuhao' ? '悠悠'
            : platform === 'uhaozu' ? 'U号'
            : platform === 'zuhaowang' ? '租号王'
            : platform;
        const text = platformName && msg ? `${platformName}: ${msg}` : (msg || platformName || RESTRICT_REASON);
        restrictMap[acc].push(text);
        if (platform) restrictPlatformMap[acc][platform] = text;
    }
    const fullList = allRows.list.map((x) => {
        const acc = String(x.game_account || '').trim();
        const bl = blacklistMap[acc] || null;
        const restrictList = Array.isArray(restrictMap[acc]) ? restrictMap[acc] : [];
        const channelStatus = x.channel_status || {};
        const channelPrdInfo = x.channel_prd_info || {};
        const platformStatusNorm = buildPlatformStatusNorm(channelStatus, channelPrdInfo, restrictPlatformMap[acc] || {});
        const overallStatusNorm = pickOverallStatusNorm(platformStatusNorm);
        const modeRestricted = Boolean(bl) || restrictList.length > 0 || isRestrictedLikeStatus(overallStatusNorm.code);
        const modeReason = bl
            ? String(bl.reason || '').trim()
            : (restrictList.join('；') || String(overallStatusNorm.reason || '').trim());
        return {
            id: x.id,
            game_name: x.game_name,
            game_account: acc,
            role_name: String(x.account_remark || '').trim() || acc,
            display_name: resolveProductDisplayName(x, acc),
            purchase_price: Number(x.purchase_price || 0),
            purchase_date: String(x.purchase_date || '').slice(0, 10),
            channel_status: channelStatus,
            platform_status_norm: platformStatusNorm,
            overall_status_norm: overallStatusNorm,
            today_paid_count: Number(paidMap[acc] || 0),
            renting_order_start_time: String(((rentingWindowMap[acc] || {}).start_time) || '').trim(),
            renting_order_end_time: String(((rentingWindowMap[acc] || {}).end_time) || '').trim(),
            renting_order_count: Number(((rentingWindowMap[acc] || {}).count) || 0),
            blacklisted: Boolean(bl),
            blacklist_reason: bl ? bl.reason : '',
            blacklist_create_date: bl ? bl.create_date : '',
            blacklist_display_date: bl ? bl.display_date : '',
            mode_restricted: modeRestricted,
            mode_reason: modeReason
        };
    });
    const sourceList = filter === 'restricted'
        ? fullList.filter((x) => Boolean(x.mode_restricted))
        : filter === 'renting'
        ? fullList.filter((x) => isRentingByChannelStatus(x.channel_status))
        : fullList;
    const total = sourceList.length;
    const offset = (page - 1) * pageSize;
    const pageList = sourceList.slice(offset, offset + pageSize);
    const list = pageList;

    const totalBlacklisted = allRows.list.reduce((sum, x) => {
        const acc = String(x.game_account || '').trim();
        return sum + (blacklistMap[acc] ? 1 : 0);
    }, 0);
    const totalRestricted = fullList.reduce((sum, x) => sum + (x.mode_restricted ? 1 : 0), 0);
    const totalRenting = fullList.reduce((sum, x) => {
        return sum + (isRentingByChannelStatus(x.channel_status) ? 1 : 0);
    }, 0);
    // 顶部总数与卡片数强制同口径：
    // 统一以 listTodayPaidOrderCountByAccounts 的结果聚合，不受筛选分页影响。
    const totalPaid = Array.from(new Set(fullList.map((x) => String(x.game_account || '').trim()).filter(Boolean)))
        .reduce((sum, acc) => sum + Number(paidMap[acc] || 0), 0);

    return json(res, 200, {
        ok: true,
        page,
        page_size: pageSize,
        total,
        filter,
        stats: {
            total_all: allRows.total,
            total_blacklisted: totalBlacklisted,
            total_restricted: totalRestricted,
            total_renting: totalRenting,
            total_paid: totalPaid
        },
        order_count_mode: orderOffRule.mode,
        order_count_label: orderOffRule.mode === ORDER_OFF_MODE_ROLLING_24H ? '近24h订单' : '今日订单',
        list
    });
}

async function handleProductSyncNow(req, res) {
    const user = await requireAuth(req);
    const out = await syncUserAccountsByAuth(user.id);
    return json(res, 200, {
        ok: true,
        ...out
    });
}

async function handleOrders(req, res, urlObj) {
    const user = await requireAuth(req);
    const page = normalizePage(urlObj.searchParams.get('page'), 1);
    const pageSize = Math.min(100, normalizePage(urlObj.searchParams.get('page_size'), 20));
    const quickFilter = String(urlObj.searchParams.get('quick_filter') || 'today').trim().toLowerCase();
    const statusFilter = String(urlObj.searchParams.get('status_filter') || 'all').trim().toLowerCase();
    const gameName = String(urlObj.searchParams.get('game_name') || 'WZRY').trim() || 'WZRY';
    const data = await listOrdersForUser(user.id, {
        page,
        page_size: pageSize,
        quick_filter: quickFilter,
        status_filter: statusFilter,
        game_name: gameName
    });
    let list = Array.isArray(data && data.list) ? data.list : [];
    if (list.length > 0) {
        const allRows = await listAllAccountsByUser(user.id);
        const accountMap = new Map(
            (allRows.list || [])
                .map((x) => [String((x && x.game_account) || '').trim(), x])
                .filter(([acc]) => Boolean(acc))
        );
        list = list.map((item) => {
            const acc = String((item && item.game_account) || '').trim();
            const hit = accountMap.get(acc);
            const fallback = String((item && item.role_name) || '').trim() || acc;
            const displayName = hit ? resolveProductDisplayName(hit, acc) : fallback;
            return {
                ...item,
                display_name: displayName || fallback
            };
        });
    }
    return json(res, 200, { ok: true, ...data, list });
}

async function handleOrderSyncNow(req, res) {
    const user = await requireAuth(req);
    const owner = `h5/orders/sync user_id=${user.id} pid=${process.pid}`;
    const lock = await tryAcquireLock(ORDER_SYNC_LOCK_KEY, ORDER_SYNC_LOCK_LEASE_SEC, owner);
    if (!lock.acquired) {
        return json(res, 200, {
            ok: true,
            skipped: true,
            reason: 'order_sync_locked',
            lock_key: ORDER_SYNC_LOCK_KEY,
            lease_until: Number(lock.lease_until || 0)
        });
    }

    try {
        const out = await syncOrdersByUser(user.id, {
            user,
            uuzuhao: { maxPages: 20 },
            uhaozu: { maxPages: 20 },
            zuhaowang: { maxPages: 20 }
        });
        return json(res, 200, {
            ok: true,
            skipped: false,
            lock_key: ORDER_SYNC_LOCK_KEY,
            ...out
        });
    } finally {
        await releaseLock(ORDER_SYNC_LOCK_KEY, `release by ${owner}`);
    }
}

async function handleStatsDashboard(req, res, urlObj) {
    const user = await requireAuth(req);
    const period = String(urlObj.searchParams.get('period') || 'today').trim().toLowerCase();
    const gameName = String(urlObj.searchParams.get('game_name') || 'WZRY').trim() || 'WZRY';
    const data = await getOrderStatsDashboardByUser(user.id, {
        period,
        game_name: gameName
    });
    return json(res, 200, { ok: true, ...data });
}

async function handleStatsCalendar(req, res, urlObj) {
    const user = await requireAuth(req);
    const month = String(urlObj.searchParams.get('month') || '').trim();
    const gameName = String(urlObj.searchParams.get('game_name') || 'WZRY').trim() || 'WZRY';
    const data = await getIncomeCalendarByUser(user.id, {
        month,
        game_name: gameName
    });
    return json(res, 200, { ok: true, ...data });
}

async function handleStatsRefresh(req, res) {
    const user = await requireAuth(req);
    const body = await readJsonBody(req);
    const days = Math.max(1, Math.min(60, Number(body.days || 60)));
    const gameName = String(body.game_name || 'WZRY').trim() || 'WZRY';
    const needSyncOrders = body.sync_orders === undefined ? true : Boolean(body.sync_orders);
    const lockOwner = `h5/stats/refresh user_id=${user.id} pid=${process.pid}`;
    const lock = await acquireOrderSyncLockWithWait({
        key: ORDER_SYNC_LOCK_KEY,
        owner: lockOwner,
        lease_sec: ORDER_SYNC_LOCK_LEASE_SEC,
        wait_ms: STATS_REFRESH_LOCK_WAIT_MS,
        poll_ms: STATS_REFRESH_LOCK_POLL_MS
    });
    if (!lock.acquired) {
        throw httpError(409, `订单同步任务占用中，请稍后重试（lock=${ORDER_SYNC_LOCK_KEY}）`);
    }

    let orderSync = {
        attempted: false,
        ok: true,
        skipped: !needSyncOrders
    };
    try {
        if (needSyncOrders) {
            orderSync.attempted = true;
            try {
                const syncOut = await syncOrdersByUser(user.id, {
                    user,
                    uuzuhao: { maxPages: 20 },
                    uhaozu: { maxPages: 20 },
                    zuhaowang: { maxPages: 20 }
                });
                orderSync = {
                    attempted: true,
                    skipped: false,
                    ok: Boolean(syncOut && syncOut.ok),
                    result: syncOut
                };
            } catch (e) {
                orderSync = {
                    attempted: true,
                    skipped: false,
                    ok: false,
                    error: String(e && e.message ? e.message : e || '订单同步失败')
                };
            }
        }

        const out = await refreshOrderStatsDailyByUser(user.id, {
            days,
            game_name: gameName,
            desc: 'manual by h5 stats refresh'
        });
        return json(res, 200, {
            ok: true,
            ...out,
            order_sync: orderSync,
            lock_waited_ms: Number(lock.waited_ms || 0),
            lock_key: ORDER_SYNC_LOCK_KEY
        });
    } finally {
        await releaseLock(ORDER_SYNC_LOCK_KEY, `release by ${lockOwner}`);
    }
}

async function handleGetOrderOffThreshold(req, res) {
    const user = await requireAuth(req);
    const rule = await getOrderOffRuleByUser(user.id);
    return json(res, 200, {
        ok: true,
        threshold: rule.threshold,
        mode: rule.mode,
        mode_label: orderOffModeLabel(rule.mode),
        rule_name: ORDER_OFF_THRESHOLD_RULE_NAME
    });
}

async function handleSetOrderOffThreshold(req, res) {
    const user = await requireAuth(req);
    const body = await readJsonBody(req);
    const current = await getOrderOffRuleByUser(user.id);
    const threshold = normalizeOrderOffThreshold(body.threshold, NaN);
    if (!Number.isFinite(threshold)) {
        return json(res, 400, { ok: false, message: 'threshold 必须是 1~10 的整数' });
    }
    const modeInput = body.mode === undefined || body.mode === null ? '' : String(body.mode || '').trim().toLowerCase();
    if (modeInput && modeInput !== ORDER_OFF_MODE_NATURAL_DAY && modeInput !== ORDER_OFF_MODE_ROLLING_24H) {
        return json(res, 400, { ok: false, message: 'mode 仅支持 natural_day / rolling_24h' });
    }
    const mode = normalizeOrderOffMode(modeInput, current.mode || ORDER_OFF_MODE_NATURAL_DAY);
    await upsertUserRuleByName(user.id, {
        rule_name: ORDER_OFF_THRESHOLD_RULE_NAME,
        rule_detail: { threshold, mode }
    }, {
        desc: 'set by h5'
    });
    return json(res, 200, {
        ok: true,
        threshold,
        mode,
        mode_label: orderOffModeLabel(mode),
        rule_name: ORDER_OFF_THRESHOLD_RULE_NAME
    });
}

async function handleBlacklistAdd(req, res) {
    const user = await requireAuth(req);
    const body = await readJsonBody(req);
    const gameAccount = String(body.game_account || '').trim();
    const reason = String(body.reason || '').trim() || '人工下架';
    if (!gameAccount) return json(res, 400, { ok: false, message: 'game_account 不能为空' });
    const out = await upsertUserBlacklistEntry(
        user.id,
        {
            game_account: gameAccount,
            reason
        },
        {
            source: 'h5',
            operator: user.account || 'h5_user',
            desc: 'manual by h5'
        }
    );
    return json(res, 200, { ok: true, data: out });
}

async function handleBlacklistRemove(req, res) {
    const user = await requireAuth(req);
    const body = await readJsonBody(req);
    const gameAccount = String(body.game_account || '').trim();
    if (!gameAccount) return json(res, 400, { ok: false, message: 'game_account 不能为空' });
    const ok = await hardDeleteUserBlacklistEntry(user.id, gameAccount, {
        source: 'h5',
        operator: user.account || 'h5_user',
        desc: 'manual remove by h5'
    });
    return json(res, 200, { ok: true, removed: ok });
}

async function resolveUuzuhaoAuthByUser(userId) {
    const rows = await listUserPlatformAuth(userId, { with_payload: true });
    const hit = rows.find((r) => String(r.platform || '') === 'uuzuhao' && String(r.auth_status || '') === 'valid');
    if (!hit) throw httpError(422, '缺少可用的 uuzuhao 授权');

    const payload = hit && typeof hit.auth_payload === 'object' ? hit.auth_payload : {};
    const appKey = String(payload.app_key || '').trim();
    const appSecret = String(payload.app_secret || '').trim();
    if (!appKey || !appSecret) {
        throw httpError(422, 'uuzuhao 授权缺少 app_key/app_secret');
    }
    return payload;
}

async function handleProductOnlineQuery(req, res) {
    const user = await requireAuth(req);
    const body = await readJsonBody(req);
    const gameAccount = String(body.game_account || '').trim();
    const gameName = String(body.game_name || 'WZRY').trim() || 'WZRY';
    if (!gameAccount) return json(res, 400, { ok: false, message: 'game_account 不能为空' });

    const auth = await resolveUuzuhaoAuthByUser(user.id);
    let result;
    try {
        result = await queryAccountOnlineStatus(gameAccount, gameName, { auth });
    } catch (e) {
        const msg = String(e && e.message ? e.message : e || '').trim();
        if (/uuzuhao .*未配置|不支持的 game_name|accountId 不能为空/i.test(msg)) {
            throw httpError(422, msg);
        }
        if (/code=\d+/i.test(msg) || /HTTP \d+/i.test(msg) || /API 返回非JSON/i.test(msg)) {
            throw httpError(502, `在线查询失败: ${msg}`);
        }
        throw e;
    }
    return json(res, 200, {
        ok: true,
        data: {
            game_account: gameAccount,
            game_name: result.game_name,
            online: Boolean(result.online)
        }
    });
}

async function handleProductForbiddenPlay(req, res) {
    const user = await requireAuth(req);
    const body = await readJsonBody(req);
    const gameAccount = String(body.game_account || '').trim();
    const gameName = String(body.game_name || 'WZRY').trim() || 'WZRY';
    const enabledRaw = body.enabled;

    if (!gameAccount) return json(res, 400, { ok: false, message: 'game_account 不能为空' });
    if (enabledRaw === undefined || enabledRaw === null || enabledRaw === '') {
        return json(res, 400, { ok: false, message: 'enabled 不能为空' });
    }

    const enabled = (enabledRaw === true) || String(enabledRaw).trim().toLowerCase() === 'true';
    const auth = await resolveUuzuhaoAuthByUser(user.id);
    let result;
    try {
        result = await setForbiddenPlay(gameAccount, enabled, { auth, game_name: gameName, type: 2 });
    } catch (e) {
        const msg = String(e && e.message ? e.message : e || '').trim();
        if (/uuzuhao .*未配置|不支持的 game_name|accountId 不能为空|enabled 仅支持/i.test(msg)) {
            throw httpError(422, msg);
        }
        if (/code=\d+/i.test(msg) || /HTTP \d+/i.test(msg) || /API 返回非JSON/i.test(msg)) {
            throw httpError(502, `禁玩处理失败: ${msg}`);
        }
        throw e;
    }

    return json(res, 200, {
        ok: true,
        data: {
            game_account: gameAccount,
            game_name: result.game_name,
            enabled: Boolean(result.enabled)
        }
    });
}

async function handleProductPurchaseConfig(req, res) {
    const user = await requireAuth(req);
    const body = await readJsonBody(req);
    const gameAccount = String(body.game_account || '').trim();
    const purchasePrice = Number(body.purchase_price);
    const purchaseDate = String(body.purchase_date || '').trim();
    if (!gameAccount) return json(res, 400, { ok: false, message: 'game_account 不能为空' });
    if (!Number.isFinite(purchasePrice) || purchasePrice < 0) {
        return json(res, 400, { ok: false, message: 'purchase_price 不合法' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(purchaseDate)) {
        return json(res, 400, { ok: false, message: 'purchase_date 格式应为 YYYY-MM-DD' });
    }
    const out = await updateUserGameAccountPurchaseByUserAndAccount(
        user.id,
        gameAccount,
        purchasePrice,
        purchaseDate,
        'manual purchase config by h5'
    );
    return json(res, 200, {
        ok: true,
        data: {
            game_account: out.game_account,
            purchase_price: Number(out.purchase_price || 0),
            purchase_date: String(out.purchase_date || '').slice(0, 10)
        }
    });
}

function tryServeStatic(urlObj, res) {
    const reqPath = urlObj.pathname === '/' ? '/index.html' : urlObj.pathname;
    const fullPath = path.resolve(PUBLIC_DIR, `.${reqPath}`);
    if (!fullPath.startsWith(PUBLIC_DIR)) return false;
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) return false;

    const ext = path.extname(fullPath).toLowerCase();
    const contentType = ext === '.html'
        ? 'text/html; charset=utf-8'
        : ext === '.js'
        ? 'application/javascript; charset=utf-8'
        : ext === '.css'
        ? 'text/css; charset=utf-8'
        : 'application/octet-stream';
    text(res, 200, fs.readFileSync(fullPath), contentType);
    return true;
}

async function bootstrap() {
    await initUserDb();
    await initUserGameAccountDb();
    await initUserBlacklistDb();
    await initUserPlatformRestrictDb();
    await initOrderDb();
    await initUserSessionDb();
    await initUserRuleDb();
    await authBff.init();
    await orderBff.init();

    const server = http.createServer(async (req, res) => {
        const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        try {
            if (req.method === 'POST' && urlObj.pathname === '/api/login') return await handleLogin(req, res);
            if (req.method === 'POST' && urlObj.pathname === '/api/refresh') return await handleRefresh(req, res);
            if (req.method === 'GET' && urlObj.pathname === '/api/products') return await handleProducts(req, res, urlObj);
            if (req.method === 'POST' && urlObj.pathname === '/api/products/sync') return await handleProductSyncNow(req, res);
            if (req.method === 'GET' && urlObj.pathname === '/api/orders') return await handleOrders(req, res, urlObj);
            if (req.method === 'GET' && urlObj.pathname === '/api/orders/complaint') return await orderBff.handleGetOrderComplaint(req, res, urlObj);
            if (req.method === 'POST' && urlObj.pathname === '/api/orders/sync') return await handleOrderSyncNow(req, res);
            if (req.method === 'GET' && urlObj.pathname === '/api/stats/dashboard') return await handleStatsDashboard(req, res, urlObj);
            if (req.method === 'GET' && urlObj.pathname === '/api/stats/calendar') return await handleStatsCalendar(req, res, urlObj);
            if (req.method === 'POST' && urlObj.pathname === '/api/stats/refresh') return await handleStatsRefresh(req, res);
            if (req.method === 'GET' && urlObj.pathname === '/api/user-rules/order-off-threshold') return await handleGetOrderOffThreshold(req, res);
            if (req.method === 'POST' && urlObj.pathname === '/api/user-rules/order-off-threshold') return await handleSetOrderOffThreshold(req, res);
            if (req.method === 'POST' && urlObj.pathname === '/api/products/online') return await handleProductOnlineQuery(req, res);
            if (req.method === 'POST' && urlObj.pathname === '/api/products/forbidden/play') return await handleProductForbiddenPlay(req, res);
            if (req.method === 'POST' && urlObj.pathname === '/api/products/purchase-config') return await handleProductPurchaseConfig(req, res);
            if (req.method === 'POST' && urlObj.pathname === '/api/blacklist/add') return await handleBlacklistAdd(req, res);
            if (req.method === 'POST' && urlObj.pathname === '/api/blacklist/remove') return await handleBlacklistRemove(req, res);
            if (req.method === 'GET' && urlObj.pathname === '/api/auth/platforms') return await authBff.handleGetPlatformAuthList(req, res, urlObj);
            if (req.method === 'POST' && urlObj.pathname === '/api/auth/platforms/upsert') return await authBff.handleUpsertPlatformAuth(req, res);
            if (req.method === 'GET' && urlObj.pathname === '/api/ping') return json(res, 200, { ok: true, ts: Date.now() });

            if (req.method === 'GET' && tryServeStatic(urlObj, res)) return;
            return json(res, 404, { ok: false, message: 'Not Found' });
        } catch (e) {
            const statusCode = Number(e && e.statusCode) || 500;
            return json(res, statusCode, { ok: false, message: String(e.message || e) });
        }
    });

    server.listen(PORT, HOST, () => {
        // eslint-disable-next-line no-console
        console.log(`[H5] local server running at http://${HOST}:${PORT}`);
    });
}

bootstrap().catch((e) => {
    // eslint-disable-next-line no-console
    console.error('[H5] boot failed:', e.message);
    process.exit(1);
});
