#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { initUserDb, verifyUserLogin, getActiveUserById, updateUserNotifyConfigByUserId } = require('../database/user_db');
const {
    initUserGameAccountDb,
    listUserGameAccounts,
    updateUserGameAccountPurchaseByUserAndAccount,
    updateUserGameAccountSwitchByUserAndAccount
} = require('../database/user_game_account_db');
const {
    initUserBlacklistDb,
    listUserBlacklistByUserWithMeta
} = require('../database/user_blacklist_db');
const { deleteBlacklistWithGuard } = require('../blacklist/blacklist_release_guard');
const { manualRemoveBlacklistMode2 } = require('../blacklist/blacklist_manual_remove_v2');
const { getBlacklistV2Mode, buildProjectedBlacklistByUser } = require('../blacklist/blacklist_reconciler');
const { setReasonSourceAndReconcile, upsertSourceAndReconcile, clearSourceAndReconcile } = require('../blacklist/blacklist_source_gateway');
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
const { listOpenProductSyncAnomaliesByUser } = require('../database/product_sync_anomaly_db');
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
const {
    queryOnlineStatusCached,
    queryForbiddenStatusCached,
    setForbiddenPlayWithSnapshot
} = require('../product/prod_probe_cache_service');
const { runFullUserPipeline } = require('../pipeline/user_pipeline');
const {
    initProdRiskEventDb,
    listRiskEventsByUser,
    resolveOpenRiskEvent
} = require('../database/prod_risk_event_db');
const {
    initProdGuardTaskDb,
    listGuardTasksByUser,
    updateGuardTaskStatus
} = require('../database/prod_guard_task_db');
const {
    buildPlatformStatusNorm,
    pickOverallStatusNorm,
    isRestrictedLikeStatus
} = require('../product/prod_channel_status');
const { startProdRiskTaskWorker } = require('../product/prod_status_guard');
const { resolveDisplayNameByRow } = require('../product/display_name');
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
const USER_PIPELINE_LOCK_KEY_PREFIX = String(process.env.USER_PIPELINE_LOCK_KEY_PREFIX || 'pipeline_user');
const USER_PIPELINE_LOCK_LEASE_SEC = Math.max(60, Number(process.env.USER_PIPELINE_LOCK_LEASE_SEC || 900));
const USER_PIPELINE_LOCK_WAIT_MS = Math.max(0, Number(process.env.USER_PIPELINE_LOCK_WAIT_MS || 5000));
const COOLDOWN_BLACKLIST_REASON = '冷却期下架';
const MAINTENANCE_BLACKLIST_REASON = '维护中';
const PROBE_CACHE_TTL_SEC = Math.max(1, Number(process.env.PROBE_CACHE_TTL_SEC || 60));
const ACTION_READ_ONLY = ['1', 'true', 'yes', 'on'].includes(String(process.env.ACTION_READ_ONLY || 'false').toLowerCase());
const ACTION_ENABLED = !['0', 'false', 'no', 'off'].includes(String(process.env.ACTION_ENABLE || 'true').toLowerCase());
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

function normalizeAtMode(modeText, fallback = 'none') {
    const v = String(modeText || '').trim().toLowerCase();
    if (v === 'owner' || v === 'all' || v === 'none') return v;
    return fallback;
}

function normalizeMobileListInput(input) {
    const rawList = Array.isArray(input) ? input : String(input || '').split(',');
    const out = [];
    for (const one of rawList) {
        const raw = String(one || '').trim();
        if (!raw) continue;
        const digits = raw.replace(/\D+/g, '');
        if (!digits) continue;
        const mobile = digits.startsWith('86') && digits.length === 13 ? digits.slice(2) : digits;
        if (!/^\d{11}$/.test(mobile)) continue;
        if (!out.includes(mobile)) out.push(mobile);
    }
    return out;
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

function safeJsonParse(text, fallback = null) {
    const raw = String(text || '').trim();
    if (!raw) return fallback;
    try {
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
}

function parseCooldownUntilSecFromDesc(descText) {
    const raw = String(descText || '').trim();
    if (!raw) return 0;
    try {
        const obj = JSON.parse(raw);
        const direct = Number((obj && obj.cooldown_until) || 0);
        if (Number.isFinite(direct) && direct > 0) return direct;
        const winner = obj && obj.winner_detail && typeof obj.winner_detail === 'object'
            ? obj.winner_detail
            : {};
        const winnerSec = Number((winner && winner.cooldown_until) || 0);
        if (Number.isFinite(winnerSec) && winnerSec > 0) return winnerSec;
        return 0;
    } catch {
        return 0;
    }
}

function parseMaintenanceSinceFromDesc(descText) {
    const raw = String(descText || '').trim();
    if (!raw) return '';
    try {
        const obj = JSON.parse(raw);
        const direct = String((obj && obj.maintain_since) || '').trim();
        if (direct) return direct;
        const winner = obj && obj.winner_detail && typeof obj.winner_detail === 'object'
            ? obj.winner_detail
            : {};
        const winnerSince = String((winner && winner.maintain_since) || '').trim();
        if (winnerSince) return winnerSince;
        return '';
    } catch {
        return '';
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
    if (reason === COOLDOWN_BLACKLIST_REASON) {
        const untilSec = parseCooldownUntilSecFromDesc(row.desc);
        const cooldownDate = formatDateTimeByUnixSec(untilSec);
        return cooldownDate || createDate;
    }
    if (reason === MAINTENANCE_BLACKLIST_REASON) {
        const since = parseMaintenanceSinceFromDesc(row.desc);
        return since || createDate;
    }
    return createDate;
}

function resolveBlacklistDisplayDateByMeta(input = {}) {
    const reason = String(input.reason || '').trim();
    const createDate = String(input.create_date || '').trim();
    const descText = String(input.desc || '').trim();
    const winnerDetail = input.winner_detail && typeof input.winner_detail === 'object'
        ? input.winner_detail
        : {};
    if (reason === COOLDOWN_BLACKLIST_REASON) {
        const sec = Number((winnerDetail && winnerDetail.cooldown_until) || 0);
        const fromWinner = formatDateTimeByUnixSec(sec);
        if (fromWinner) return fromWinner;
        const fromDesc = formatDateTimeByUnixSec(parseCooldownUntilSecFromDesc(descText));
        return fromDesc || createDate;
    }
    if (reason === MAINTENANCE_BLACKLIST_REASON) {
        const fromDesc = parseMaintenanceSinceFromDesc(descText);
        return fromDesc || createDate;
    }
    return createDate;
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

function normalizeAccountSwitch(raw) {
    const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const out = {};
    for (const [key, value] of Object.entries(src)) {
        const cfg = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
        const label = String(cfg.label || '').trim();
        out[key] = {
            label: label || key,
            enabled: cfg.enabled === undefined ? true : Boolean(cfg.enabled)
        };
    }
    return out;
}

function resolveProdGuardSwitch(raw) {
    const sw = normalizeAccountSwitch(raw);
    const cfg = sw.prod_guard && typeof sw.prod_guard === 'object'
        ? sw.prod_guard
        : { label: '在线风控', enabled: true };
    return {
        label: String(cfg.label || '在线风控').trim() || '在线风控',
        enabled: cfg.enabled === undefined ? true : Boolean(cfg.enabled)
    };
}

async function cleanupProdGuardStateByAccount(userId, gameAccount) {
    const uid = Number(userId || 0);
    const acc = String(gameAccount || '').trim();
    if (!uid || !acc) return;
    await clearSourceAndReconcile(uid, acc, 'guard_online', {
        operator: 'h5',
        desc: 'disable prod_guard by h5'
    });
    await clearSourceAndReconcile(uid, acc, 'guard_forbidden', {
        operator: 'h5',
        desc: 'disable prod_guard by h5'
    });
    const taskRows = await listGuardTasksByUser(uid, { page: 1, page_size: 500 });
    for (const task of (taskRows && Array.isArray(taskRows.list) ? taskRows.list : [])) {
        if (String((task && task.game_account) || '').trim() !== acc) continue;
        if (String((task && task.status) || '').trim() !== 'pending' && String((task && task.status) || '').trim() !== 'watching') continue;
        await updateGuardTaskStatus(task.id, {
            status: 'done',
            blacklist_applied: 0,
            forbidden_applied: 0,
            last_error: '',
            desc: 'skip_by_account_switch_prod_guard_disabled'
        });
    }
    await resolveOpenRiskEvent(uid, acc, 'online_non_renting', {
        status: 'ignored',
        desc: 'skip_by_account_switch_prod_guard_disabled'
    });
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
    const gameName = String(urlObj.searchParams.get('game_name') || 'WZRY').trim() || 'WZRY';
    const filterRaw = String(urlObj.searchParams.get('filter') || 'all').trim().toLowerCase();
    const filter = (filterRaw === 'restricted' || filterRaw === 'renting' || filterRaw === 'all')
        ? filterRaw
        : 'all';
    const mode = Number(getBlacklistV2Mode());
    const blacklistRows = await listUserBlacklistByUserWithMeta(user.id);
    const keyOfGameAccount = (gameId, gameAccount) => `${String(gameId || '1').trim() || '1'}::${String(gameAccount || '').trim()}`;
    const platformLabel = (platform) => {
        const key = String(platform || '').trim();
        if (key === 'uuzuhao') return '悠悠';
        if (key === 'uhaozu') return 'U号租';
        if (key === 'zuhaowang') return '租号王';
        return key || '未知平台';
    };
    const legacyMap = {};
    for (const row of blacklistRows) {
        const acc = String((row && row.game_account) || '').trim();
        const gid = String((row && row.game_id) || '1').trim() || '1';
        if (!acc) continue;
        legacyMap[keyOfGameAccount(gid, acc)] = row;
    }
    const blacklistMap = {};
    if (mode >= 2) {
        const projected = await buildProjectedBlacklistByUser(user.id, { include_legacy_bootstrap: true });
        for (const identityKey of Object.keys(projected || {})) {
            const p = projected[identityKey] || {};
            const legacy = legacyMap[identityKey] || {};
            const reason = String(p.reason || '').trim();
            const createDate = String((legacy && legacy.create_date) || '').trim();
            const winnerDetail = p.winner_detail && typeof p.winner_detail === 'object' ? p.winner_detail : {};
            blacklistMap[identityKey] = {
                reason,
                remark: String((legacy && legacy.remark) || '').trim(),
                create_date: createDate,
                display_date: resolveBlacklistDisplayDateByMeta({
                    reason,
                    create_date: createDate,
                    desc: String((legacy && legacy.desc) || '').trim(),
                    winner_detail: winnerDetail
                })
            };
        }
    } else {
        for (const row of blacklistRows) {
            const acc = String((row && row.game_account) || '').trim();
            const gid = String((row && row.game_id) || '1').trim() || '1';
            if (!acc) continue;
            blacklistMap[keyOfGameAccount(gid, acc)] = {
                reason: String((row && row.reason) || '').trim(),
                remark: String((row && row.remark) || '').trim(),
                create_date: String((row && row.create_date) || '').trim(),
                display_date: resolveBlacklistDisplayDate(row)
            };
        }
    }

    const orderOffRule = await getOrderOffRuleByUser(user.id);
    const allRows = await listAllAccountsByUser(user.id);
    const scopedRows = allRows.list.filter((x) => String((x && x.game_name) || '').trim() === gameName);
    const syncAnomalyRows = await listOpenProductSyncAnomaliesByUser(user.id);
    const scopedSyncAnomalies = syncAnomalyRows
        .map((row) => {
            const missingAccounts = Array.isArray(row && row.missing_accounts) ? row.missing_accounts : [];
            const scopedMissing = missingAccounts.filter((item) => String((item && item.game_name) || '').trim() === gameName);
            if (scopedMissing.length === 0) return null;
            return {
                platform: String((row && row.platform) || '').trim(),
                platform_label: platformLabel(row && row.platform),
                expected_count: Number((row && row.expected_count) || 0),
                pulled_count: Number((row && row.pulled_count) || 0),
                missing_count: scopedMissing.length,
                first_seen_at: String((row && row.first_seen_at) || '').trim(),
                last_seen_at: String((row && row.last_seen_at) || '').trim(),
                missing_accounts: scopedMissing
            };
        })
        .filter(Boolean);
    const syncMissingKeySet = new Set();
    for (const row of scopedSyncAnomalies) {
        const missingAccounts = Array.isArray(row && row.missing_accounts) ? row.missing_accounts : [];
        for (const item of missingAccounts) {
            syncMissingKeySet.add(keyOfGameAccount(item && item.game_id, item && item.game_account));
        }
    }
    const allAccs = scopedRows.map((x) => ({
        game_account: String((x && x.game_account) || '').trim(),
        game_id: String((x && x.game_id) || '1').trim() || '1',
        game_name: String((x && x.game_name) || 'WZRY').trim() || 'WZRY'
    })).filter((x) => x.game_account);
    const accountRowMap = new Map(
        scopedRows
            .map((x) => [keyOfGameAccount(x && x.game_id, x && x.game_account), x])
            .filter(([acc]) => Boolean(acc))
    );
    const paidMap = allAccs.length > 0
        ? (orderOffRule.mode === ORDER_OFF_MODE_ROLLING_24H
            ? await listRolling24hPaidOrderCountByAccounts(user.id, allAccs)
            : await listTodayPaidOrderCountByAccounts(user.id, allAccs))
        : {};
    const rentingWindowMap = allAccs.length > 0
        ? await listRentingOrderWindowByAccounts(user.id, allAccs)
        : {};
    const restrictRowsRaw = allAccs.length > 0
        ? await listPlatformRestrictByUserAndAccounts(user.id, allAccs.map((x) => x.game_account))
        : [];
    const restrictRows = [];
    for (const row of restrictRowsRaw) {
        const acc = String((row && row.game_account) || '').trim();
        const detail = row && typeof row.detail === 'object' ? row.detail : {};
        const platform = String((row && row.platform) || detail.platform || '').trim();
        const hit = accountRowMap.get(acc);
        const channelStatus = hit && typeof hit.channel_status === 'object' ? hit.channel_status : {};
        const channelPrdInfo = hit && typeof hit.channel_prd_info === 'object' ? hit.channel_prd_info : {};
        const statusText = String((channelStatus && channelStatus[platform]) || '').trim();
        const uuzuhaoReason = String((((channelPrdInfo || {}).uuzuhao || {}).reason) || '').trim();
        const isUuzuhaoSellerOff = platform === 'uuzuhao'
            && statusText === '下架'
            && (uuzuhaoReason === '商家下架' || uuzuhaoReason.includes('卖家下架'));
        const shouldClear = Boolean(platform) && (
            ['上架', '租赁中', '出租中'].includes(statusText) || isUuzuhaoSellerOff
        );
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
        const matchedRows = scopedRows.filter((x) => String((x && x.game_account) || '').trim() === acc);
        const matchedKeys = matchedRows.length > 0
            ? matchedRows.map((x) => keyOfGameAccount(x && x.game_id, x && x.game_account))
            : [keyOfGameAccount('1', acc)];
        const detail = row && typeof row.detail === 'object' ? row.detail : {};
        const platform = String((row && row.platform) || detail.platform || '').trim();
        const msg = String(detail.msg || '').trim();
        const platformName = platform === 'uuzuhao' ? '悠悠'
            : platform === 'uhaozu' ? 'U号'
            : platform === 'zuhaowang' ? '租号王'
            : platform;
        const text = platformName && msg ? `${platformName}: ${msg}` : (msg || platformName || RESTRICT_REASON);
        for (const matchedKey of matchedKeys) {
            if (!restrictMap[matchedKey]) restrictMap[matchedKey] = [];
            if (!restrictPlatformMap[matchedKey]) restrictPlatformMap[matchedKey] = {};
            restrictMap[matchedKey].push(text);
            if (platform) restrictPlatformMap[matchedKey][platform] = text;
        }
    }
    const fullList = scopedRows.map((x) => {
        const acc = String(x.game_account || '').trim();
        const identityKey = keyOfGameAccount(x && x.game_id, acc);
        const bl = blacklistMap[identityKey] || null;
        const restrictList = Array.isArray(restrictMap[identityKey]) ? restrictMap[identityKey] : [];
        const channelStatus = x.channel_status || {};
        const channelPrdInfo = x.channel_prd_info || {};
        const platformStatusNorm = buildPlatformStatusNorm(channelStatus, channelPrdInfo, restrictPlatformMap[identityKey] || {});
        const overallStatusNorm = pickOverallStatusNorm(platformStatusNorm);
        const modeRestricted = Boolean(bl) || restrictList.length > 0 || isRestrictedLikeStatus(overallStatusNorm.code);
        const modeReason = bl
            ? String(bl.reason || '').trim()
            : (restrictList.join('；') || String(overallStatusNorm.reason || '').trim());
        const onlineSnapshot = x.online_probe_snapshot && typeof x.online_probe_snapshot === 'object'
            ? x.online_probe_snapshot
            : {};
        const forbiddenSnapshot = x.forbidden_probe_snapshot && typeof x.forbidden_probe_snapshot === 'object'
            ? x.forbidden_probe_snapshot
            : {};
        const accountSwitch = normalizeAccountSwitch(x.switch);
        const prodGuardSwitch = resolveProdGuardSwitch(accountSwitch);
        const onlineLabelRaw = String(onlineSnapshot.label || '').trim();
        const onlineTag = prodGuardSwitch.enabled && (onlineLabelRaw === '在线' || onlineLabelRaw === '离线')
            ? onlineLabelRaw
            : '';
        const forbiddenLabelRaw = String(forbiddenSnapshot.label || '').trim();
        return {
            id: x.id,
            game_name: x.game_name,
            game_account: acc,
            role_name: String(x.account_remark || '').trim() || acc,
            display_name: resolveDisplayNameByRow(x, acc),
            purchase_price: Number(x.purchase_price || 0),
            purchase_date: String(x.purchase_date || '').slice(0, 10),
            channel_status: channelStatus,
            platform_status_norm: platformStatusNorm,
            overall_status_norm: overallStatusNorm,
            today_paid_count: Number(paidMap[identityKey] || 0),
            renting_order_start_time: String(((rentingWindowMap[identityKey] || {}).start_time) || '').trim(),
            renting_order_end_time: String(((rentingWindowMap[identityKey] || {}).end_time) || '').trim(),
            renting_order_count: Number(((rentingWindowMap[identityKey] || {}).count) || 0),
            online_tag: onlineTag,
            online_query_time: prodGuardSwitch.enabled ? String(onlineSnapshot.query_time || '').trim() : '',
            forbidden_status: forbiddenLabelRaw,
            forbidden_query_time: String(forbiddenSnapshot.query_time || '').trim(),
            switch: accountSwitch,
            prod_guard_enabled: Boolean(prodGuardSwitch.enabled),
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

    const totalBlacklisted = scopedRows.reduce((sum, x) => {
        const acc = String(x.game_account || '').trim();
        return sum + (blacklistMap[keyOfGameAccount(x && x.game_id, acc)] ? 1 : 0);
    }, 0);
    const totalRestricted = fullList.reduce((sum, x) => sum + (x.mode_restricted ? 1 : 0), 0);
    const totalRenting = fullList.reduce((sum, x) => {
        return sum + (isRentingByChannelStatus(x.channel_status) ? 1 : 0);
    }, 0);
    // 顶部总数与卡片数强制同口径：
    // 统一以 listTodayPaidOrderCountByAccounts 的结果聚合，不受筛选分页影响。
    const totalPaid = fullList
        .reduce((sum, x) => sum + Number(paidMap[keyOfGameAccount(x && x.game_id, x && x.game_account)] || 0), 0);

    return json(res, 200, {
        ok: true,
        game_name: gameName,
        page,
        page_size: pageSize,
        total,
        filter,
        stats: {
            total_all: scopedRows.length,
            master_total: scopedRows.length,
            sync_effective_total: Math.max(0, scopedRows.length - syncMissingKeySet.size),
            total_blacklisted: totalBlacklisted,
            total_restricted: totalRestricted,
            total_renting: totalRenting,
            total_paid: totalPaid,
            sync_anomaly_count: scopedSyncAnomalies.length,
            sync_anomaly_text: scopedSyncAnomalies.length > 0
                ? scopedSyncAnomalies
                    .slice(0, 2)
                    .map((row) => `${row.platform_label}少回${row.missing_count}个`)
                    .join('；')
                : '',
            sync_anomalies: scopedSyncAnomalies
        },
        order_count_mode: orderOffRule.mode,
        order_count_label: orderOffRule.mode === ORDER_OFF_MODE_ROLLING_24H ? '近24h订单' : '今日订单',
        list
    });
}

async function handleProductSyncNow(req, res) {
    const user = await requireAuth(req);
    const uid = Number(user && user.id || 0);
    if (!uid) return json(res, 400, { ok: false, message: 'user_id 非法' });
    const lockKey = `${USER_PIPELINE_LOCK_KEY_PREFIX}_${uid}`;
    const lockOwner = `h5/products/sync user_id=${uid} pid=${process.pid}`;
    const lock = await acquireOrderSyncLockWithWait({
        key: lockKey,
        owner: lockOwner,
        lease_sec: USER_PIPELINE_LOCK_LEASE_SEC,
        wait_ms: USER_PIPELINE_LOCK_WAIT_MS,
        poll_ms: STATS_REFRESH_LOCK_POLL_MS
    });
    if (!lock.acquired) {
        throw httpError(409, `用户任务执行中，请稍后重试（lock=${lockKey}）`);
    }
    try {
        const fullUser = await getActiveUserById(uid);
        if (!fullUser || String(fullUser.status || '').trim() !== 'enabled') {
            throw httpError(401, '用户不存在或已禁用');
        }
        const out = await runFullUserPipeline(fullUser, {
            logger: console,
            actionEnabled: ACTION_ENABLED,
            readOnly: ACTION_READ_ONLY
        });
        if (!out || !out.ok) {
            const msg = Array.isArray(out && out.errors) && out.errors.length > 0
                ? String(out.errors[0] || 'pipeline_failed')
                : 'pipeline_failed';
            return json(res, 500, {
                ok: false,
                message: msg,
                data: out || null,
                lock_key: lockKey,
                lock_waited_ms: Number(lock.waited_ms || 0)
            });
        }
        return json(res, 200, {
            ok: true,
            data: out || null,
            lock_key: lockKey,
            lock_waited_ms: Number(lock.waited_ms || 0)
        });
    } finally {
        await releaseLock(lockKey, `release by ${lockOwner}`);
    }
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
            const displayName = hit ? resolveDisplayNameByRow(hit, acc) : fallback;
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
    const statDate = String(urlObj.searchParams.get('stat_date') || '').trim();
    const data = await getOrderStatsDashboardByUser(user.id, {
        period,
        stat_date: statDate,
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

async function handleGetProfile(req, res) {
    const user = await requireAuth(req);
    const fullUser = await getActiveUserById(user.id);
    if (!fullUser || String(fullUser.status || '').trim() !== 'enabled') {
        throw httpError(401, '用户不存在或已禁用');
    }
    const ding = fullUser.notify_config && fullUser.notify_config.dingding && typeof fullUser.notify_config.dingding === 'object'
        ? fullUser.notify_config.dingding
        : {};
    const primaryAtMode = normalizeAtMode(ding.at_mode, 'none');
    const primaryAtMobiles = normalizeMobileListInput(ding.at_mobiles || []);
    const fallbackAtMode = normalizeAtMode(ding.complaint_at_mode, 'none');
    const fallbackAtMobiles = normalizeMobileListInput(ding.complaint_at_mobiles || []);
    const atMode = primaryAtMode !== 'none' ? primaryAtMode : fallbackAtMode;
    const atMobiles = primaryAtMobiles.length > 0 ? primaryAtMobiles : fallbackAtMobiles;
    const rule = await getOrderOffRuleByUser(fullUser.id);
    return json(res, 200, {
        ok: true,
        profile: {
            user: {
                id: Number(fullUser.id || 0),
                account: String(fullUser.account || '').trim(),
                name: String(fullUser.name || '').trim()
            },
            notify: {
                at_mode: atMode,
                at_mobiles: atMobiles
            },
            order_off: {
                threshold: rule.threshold,
                mode: rule.mode,
                mode_label: orderOffModeLabel(rule.mode)
            }
        }
    });
}

async function handleSetProfileNotify(req, res) {
    const user = await requireAuth(req);
    const body = await readJsonBody(req);
    const atMode = normalizeAtMode(body.at_mode, 'none');
    const atMobiles = normalizeMobileListInput(body.at_mobiles || []);

    const fullUser = await getActiveUserById(user.id);
    if (!fullUser || String(fullUser.status || '').trim() !== 'enabled') {
        throw httpError(401, '用户不存在或已禁用');
    }
    const oldCfg = fullUser.notify_config && typeof fullUser.notify_config === 'object'
        ? fullUser.notify_config
        : {};
    const oldDing = oldCfg.dingding && typeof oldCfg.dingding === 'object'
        ? oldCfg.dingding
        : {};
    const nextDing = {
        ...oldDing,
        at_mode: atMode,
        at_mobiles: atMobiles,
        complaint_at_mode: atMode,
        complaint_at_mobiles: atMobiles
    };
    const updated = await updateUserNotifyConfigByUserId(user.id, {
        ...oldCfg,
        dingding: nextDing
    }, 'set by h5 profile notify');
    const ding = updated.notify_config && updated.notify_config.dingding && typeof updated.notify_config.dingding === 'object'
        ? updated.notify_config.dingding
        : {};
    return json(res, 200, {
        ok: true,
        notify: {
            at_mode: normalizeAtMode(ding.at_mode, 'none'),
            at_mobiles: normalizeMobileListInput(ding.at_mobiles || [])
        }
    });
}

async function handleSetProfileOrderOff(req, res) {
    const user = await requireAuth(req);
    const body = await readJsonBody(req);
    const threshold = normalizeOrderOffThreshold(body.threshold, NaN);
    if (!Number.isFinite(threshold)) {
        return json(res, 400, { ok: false, message: 'threshold 必须是 1~10 的整数' });
    }
    const modeInput = body.mode === undefined || body.mode === null ? '' : String(body.mode || '').trim().toLowerCase();
    if (modeInput && modeInput !== ORDER_OFF_MODE_NATURAL_DAY && modeInput !== ORDER_OFF_MODE_ROLLING_24H) {
        return json(res, 400, { ok: false, message: 'mode 仅支持 natural_day / rolling_24h' });
    }
    const current = await getOrderOffRuleByUser(user.id);
    const mode = normalizeOrderOffMode(modeInput, current.mode || ORDER_OFF_MODE_NATURAL_DAY);
    await upsertUserRuleByName(user.id, {
        rule_name: ORDER_OFF_THRESHOLD_RULE_NAME,
        rule_detail: { threshold, mode }
    }, {
        desc: 'set by h5 profile'
    });
    return json(res, 200, {
        ok: true,
        order_off: {
            threshold,
            mode,
            mode_label: orderOffModeLabel(mode)
        }
    });
}

async function handleBlacklistAdd(req, res) {
    const user = await requireAuth(req);
    const body = await readJsonBody(req);
    const gameAccount = String(body.game_account || '').trim();
    const reason = String(body.reason || '').trim() || '人工下架';
    if (!gameAccount) return json(res, 400, { ok: false, message: 'game_account 不能为空' });
    const out = await setReasonSourceAndReconcile(user.id, gameAccount, reason, {
        source: 'h5',
        operator: user.account || 'h5_user',
        desc: 'manual by h5',
        detail: { trigger: 'h5_manual_add' }
    });
    return json(res, 200, { ok: true, data: out });
}

async function handleBlacklistRemove(req, res) {
    const user = await requireAuth(req);
    const body = await readJsonBody(req);
    const gameAccount = String(body.game_account || '').trim();
    if (!gameAccount) return json(res, 400, { ok: false, message: 'game_account 不能为空' });
    const mode = Number(getBlacklistV2Mode());
    if (mode >= 2) {
        const out = await manualRemoveBlacklistMode2(user.id, gameAccount, {
            source: 'h5',
            operator: user.account || 'h5_user',
            desc: 'manual remove by h5 mode2',
            game_name: String(body.game_name || 'WZRY').trim() || 'WZRY'
        });
        return json(res, 200, {
            ok: true,
            mode,
            removed: Boolean(out && out.removed),
            blocked: Boolean(out && out.blocked),
            blocked_reason: String((out && out.blocked_reason) || ''),
            winner_source: String((out && out.winner_source) || ''),
            cleared_sources: Array.isArray(out && out.cleared_sources) ? out.cleared_sources : []
        });
    }
    const out = await deleteBlacklistWithGuard(user.id, gameAccount, {
        source: 'h5',
        operator: user.account || 'h5_user',
        desc: 'manual remove by h5'
    });
    return json(res, 200, {
        ok: true,
        removed: Boolean(out && out.removed),
        blocked: Boolean(out && out.blocked),
        blocked_reason: String((out && out.blocked_reason) || '')
    });
}

async function handleProductMaintenanceToggle(req, res) {
    const user = await requireAuth(req);
    const body = await readJsonBody(req);
    const gameAccount = String(body.game_account || '').trim();
    const enabled = body.enabled === true || String(body.enabled || '').trim().toLowerCase() === 'true';
    if (!gameAccount) return json(res, 400, { ok: false, message: 'game_account 不能为空' });

    if (enabled) {
        const now = new Date();
        const p = (n) => String(n).padStart(2, '0');
        const maintainSince = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
        const out = await upsertSourceAndReconcile(user.id, gameAccount, 'manual_maintenance', {
            active: true,
            reason: MAINTENANCE_BLACKLIST_REASON,
            detail: {
                type: 'manual_maintenance',
                maintain_since: maintainSince,
                operator: user.account || 'h5_user'
            }
        }, {
            source: 'h5_maintenance',
            operator: user.account || 'h5_user',
            desc: 'manual maintenance by h5'
        });
        return json(res, 200, { ok: true, data: { ...out, maintenance_enabled: true } });
    }

    const out = await deleteBlacklistWithGuard(
        user.id,
        gameAccount,
        {
            source: 'h5_maintenance',
            operator: user.account || 'h5_user',
            desc: 'manual maintenance end by h5',
            reason_expected: MAINTENANCE_BLACKLIST_REASON
        }
    );
    if (!out || !out.removed) {
        if (out && out.blocked) {
            return json(res, 409, {
                ok: false,
                message: `该账号当前命中${String(out.blocked_reason || '风控')}，已进入风控跟进，暂不可结束维护`
            });
        }
        return json(res, 409, { ok: false, message: '该账号当前不是“维护中”状态，无法结束维护' });
    }
    return json(res, 200, {
        ok: true,
        data: {
            game_account: gameAccount,
            maintenance_enabled: false
        }
    });
}

async function handleProductOnlineQuery(req, res) {
    const user = await requireAuth(req);
    const body = await readJsonBody(req);
    const gameAccount = String(body.game_account || '').trim();
    const gameName = String(body.game_name || 'WZRY').trim() || 'WZRY';
    if (!gameAccount) return json(res, 400, { ok: false, message: 'game_account 不能为空' });

    let result;
    try {
        result = await queryOnlineStatusCached(user.id, gameAccount, {
            game_name: gameName,
            ttl_sec: PROBE_CACHE_TTL_SEC,
            desc: 'update by h5 online query'
        });
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
    const queryTime = String(result.query_time || '').trim();
    console.log(`[ProbeCache][online] user_id=${user.id} account=${gameAccount} hit=${Boolean(result.cached)} online=${Boolean(result.online)} query_time=${queryTime} ttl_sec=${PROBE_CACHE_TTL_SEC}`);
    return json(res, 200, {
        ok: true,
        cached: Boolean(result.cached),
        data: {
            game_account: gameAccount,
            game_name: result.game_name,
            online: Boolean(result.online),
            query_time: queryTime
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
    let result;
    try {
        result = await setForbiddenPlayWithSnapshot(user.id, gameAccount, enabled, {
            game_name: gameName,
            desc: 'update by h5 forbidden play'
        });
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

    const queryTime = String(result.query_time || '').trim();
    return json(res, 200, {
        ok: true,
        data: {
            game_account: gameAccount,
            game_name: result.game_name,
            enabled: Boolean(result.enabled),
            query_time: queryTime
        }
    });
}

async function handleProductForbiddenQuery(req, res) {
    const user = await requireAuth(req);
    const body = await readJsonBody(req);
    const gameAccount = String(body.game_account || '').trim();
    const gameName = String(body.game_name || 'WZRY').trim() || 'WZRY';
    if (!gameAccount) return json(res, 400, { ok: false, message: 'game_account 不能为空' });

    let result;
    try {
        result = await queryForbiddenStatusCached(user.id, gameAccount, {
            game_name: gameName,
            ttl_sec: PROBE_CACHE_TTL_SEC,
            desc: 'update by h5 forbidden query'
        });
    } catch (e) {
        const msg = String(e && e.message ? e.message : e || '').trim();
        if (/uuzuhao .*未配置|不支持的 game_name|accountId 不能为空|type 仅支持/i.test(msg)) {
            throw httpError(422, msg);
        }
        if (/code=\d+/i.test(msg) || /HTTP \d+/i.test(msg) || /API 返回非JSON/i.test(msg)) {
            throw httpError(502, `禁玩查询失败: ${msg}`);
        }
        throw e;
    }
    const queryTime = String(result.query_time || '').trim();
    console.log(`[ProbeCache][forbidden] user_id=${user.id} account=${gameAccount} hit=${Boolean(result.cached)} enabled=${Boolean(result.enabled)} query_time=${queryTime} ttl_sec=${PROBE_CACHE_TTL_SEC}`);

    return json(res, 200, {
        ok: true,
        cached: Boolean(result.cached),
        data: {
            game_account: gameAccount,
            game_name: result.game_name,
            enabled: Boolean(result.enabled),
            type: Number(result.type || 1),
            query_time: queryTime
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

async function handleProductAccountSwitchToggle(req, res) {
    const user = await requireAuth(req);
    const body = await readJsonBody(req);
    const gameAccount = String(body.game_account || '').trim();
    const switchKey = String(body.switch_key || '').trim();
    const enabledRaw = body.enabled;
    if (!gameAccount) return json(res, 400, { ok: false, message: 'game_account 不能为空' });
    if (switchKey !== 'prod_guard') return json(res, 400, { ok: false, message: 'switch_key 不支持' });
    if (enabledRaw === undefined || enabledRaw === null || enabledRaw === '') {
        return json(res, 400, { ok: false, message: 'enabled 不能为空' });
    }
    const enabled = enabledRaw === true || String(enabledRaw).trim().toLowerCase() === 'true';
    const nextSwitch = await updateUserGameAccountSwitchByUserAndAccount(user.id, gameAccount, {
        prod_guard: {
            label: '在线风控',
            enabled
        }
    }, 'toggle account switch by h5');
    if (!enabled) {
        await cleanupProdGuardStateByAccount(user.id, gameAccount);
    }
    const prodGuard = resolveProdGuardSwitch(nextSwitch);
    return json(res, 200, {
        ok: true,
        data: {
            game_account: gameAccount,
            switch: nextSwitch,
            prod_guard_enabled: Boolean(prodGuard.enabled)
        }
    });
}

async function handleRiskCenterList(req, res, urlObj) {
    const user = await requireAuth(req);
    const page = normalizePage(urlObj.searchParams.get('page'), 1);
    const pageSize = Math.min(100, normalizePage(urlObj.searchParams.get('page_size'), 20));
    const status = String(urlObj.searchParams.get('status') || '').trim();
    const riskType = String(urlObj.searchParams.get('risk_type') || '').trim();

    const [eventResult, taskResult, allRows] = await Promise.all([
        listRiskEventsByUser(user.id, { page, page_size: pageSize, status, risk_type: riskType }),
        listGuardTasksByUser(user.id, { page: 1, page_size: 500, risk_type: riskType }),
        listAllAccountsByUser(user.id)
    ]);

    const rowMap = new Map(
        (allRows.list || [])
            .map((x) => [String((x && x.game_account) || '').trim(), x])
            .filter(([acc]) => Boolean(acc))
    );
    const taskMapByEvent = new Map();
    const taskMapByAccountRisk = new Map();
    for (const task of (taskResult.list || [])) {
        const eventId = Number(task.event_id || 0);
        if (eventId > 0 && !taskMapByEvent.has(eventId)) taskMapByEvent.set(eventId, task);
        const k = `${String(task.game_account || '').trim()}::${String(task.risk_type || '').trim()}`;
        if (!k.startsWith('::') && !taskMapByAccountRisk.has(k)) taskMapByAccountRisk.set(k, task);
    }
    const list = (eventResult.list || []).map((ev) => {
        const acc = String(ev.game_account || '').trim();
        const riskTypeText = String(ev.risk_type || '').trim();
        const k = `${acc}::${riskTypeText}`;
        const task = taskMapByEvent.get(Number(ev.id || 0)) || taskMapByAccountRisk.get(k) || null;
        const row = rowMap.get(acc) || null;
        const snapshot = safeJsonParse(ev.snapshot, {});
        const latestOrder = snapshot && snapshot.latest_order && typeof snapshot.latest_order === 'object'
            ? snapshot.latest_order
            : {};
        return {
            id: ev.id,
            risk_type: riskTypeText,
            risk_level: ev.risk_level,
            event_status: ev.status,
            hit_at: ev.hit_at,
            resolved_at: ev.resolved_at,
            game_account: acc,
            display_name: row ? resolveDisplayNameByRow(row, acc) : acc,
            snapshot,
            latest_order_no: String(latestOrder.order_no || '').trim(),
            latest_order_end_time: String(latestOrder.end_time || '').trim(),
            task: task ? {
                id: Number(task.id || 0),
                task_type: String(task.task_type || '').trim(),
                status: String(task.status || '').trim(),
                next_check_at: Number(task.next_check_at || 0),
                last_online_tag: String(task.last_online_tag || '').trim(),
                retry_count: Number(task.retry_count || 0),
                max_retry: Number(task.max_retry || 0),
                probe_loop_count: Number(task.probe_loop_count || 0),
                forbidden_on_at: String(task.forbidden_on_at || '').trim(),
                forbidden_off_at: String(task.forbidden_off_at || '').trim(),
                last_error: String(task.last_error || '').trim(),
                modify_date: String(task.modify_date || '').trim()
            } : null,
            modify_date: ev.modify_date
        };
    });

    return json(res, 200, {
        ok: true,
        page,
        page_size: pageSize,
        total: Number(eventResult.total || 0),
        list
    });
}

function tryServeStatic(req, urlObj, res) {
    const reqPath = urlObj.pathname === '/' ? '/index.html' : urlObj.pathname;
    const fullPath = path.resolve(PUBLIC_DIR, `.${reqPath}`);
    if (!fullPath.startsWith(PUBLIC_DIR)) return false;
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) return false;

    const stat = fs.statSync(fullPath);
    const etag = `W/\"${stat.size}-${Number(stat.mtimeMs || 0)}\"`;
    const ifNoneMatch = String(req.headers['if-none-match'] || '').trim();
    if (ifNoneMatch && ifNoneMatch === etag) {
        res.writeHead(304, { ETag: etag });
        res.end();
        return true;
    }

    const ext = path.extname(fullPath).toLowerCase();
    const contentType = ext === '.html'
        ? 'text/html; charset=utf-8'
        : ext === '.js'
        ? 'application/javascript; charset=utf-8'
        : ext === '.css'
        ? 'text/css; charset=utf-8'
        : ext === '.png'
        ? 'image/png'
        : ext === '.jpg' || ext === '.jpeg'
        ? 'image/jpeg'
        : ext === '.webp'
        ? 'image/webp'
        : ext === '.svg'
        ? 'image/svg+xml'
        : ext === '.ico'
        ? 'image/x-icon'
        : 'application/octet-stream';
    const isHtml = ext === '.html';
    const isJsOrCss = ext === '.js' || ext === '.css';
    const isGameIcon = reqPath.startsWith('/assets/game_icons/');
    const cacheControl = isHtml
        ? 'no-cache'
        : isJsOrCss
        ? 'no-cache'
        : isGameIcon
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=86400';
    res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': cacheControl,
        ETag: etag,
        'Last-Modified': stat.mtime.toUTCString()
    });
    if (req.method === 'HEAD') {
        res.end();
        return true;
    }
    res.end(fs.readFileSync(fullPath));
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
    await initProdRiskEventDb();
    await initProdGuardTaskDb();
    await authBff.init();
    await orderBff.init();
    startProdRiskTaskWorker({ logger: console });

    const server = http.createServer(async (req, res) => {
        const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        try {
            if (req.method === 'POST' && urlObj.pathname === '/api/login') return await handleLogin(req, res);
            if (req.method === 'POST' && urlObj.pathname === '/api/refresh') return await handleRefresh(req, res);
            if (req.method === 'GET' && urlObj.pathname === '/api/products') return await handleProducts(req, res, urlObj);
            if (req.method === 'POST' && urlObj.pathname === '/api/products/sync') return await handleProductSyncNow(req, res);
            if (req.method === 'GET' && urlObj.pathname === '/api/orders') return await handleOrders(req, res, urlObj);
            if (req.method === 'GET' && urlObj.pathname === '/api/orders/complaint') return await orderBff.handleGetOrderComplaint(req, res, urlObj);
            if (req.method === 'GET' && urlObj.pathname === '/api/orders/detail') return await orderBff.handleGetOrderDetail(req, res, urlObj);
            if (req.method === 'POST' && urlObj.pathname === '/api/orders/sync') return await handleOrderSyncNow(req, res);
            if (req.method === 'GET' && urlObj.pathname === '/api/stats/dashboard') return await handleStatsDashboard(req, res, urlObj);
            if (req.method === 'GET' && urlObj.pathname === '/api/stats/calendar') return await handleStatsCalendar(req, res, urlObj);
            if (req.method === 'POST' && urlObj.pathname === '/api/stats/refresh') return await handleStatsRefresh(req, res);
            if (req.method === 'GET' && urlObj.pathname === '/api/profile') return await handleGetProfile(req, res);
            if (req.method === 'POST' && urlObj.pathname === '/api/profile/notify') return await handleSetProfileNotify(req, res);
            if (req.method === 'POST' && urlObj.pathname === '/api/profile/order-off') return await handleSetProfileOrderOff(req, res);
            if (req.method === 'GET' && urlObj.pathname === '/api/user-rules/order-off-threshold') return await handleGetOrderOffThreshold(req, res);
            if (req.method === 'POST' && urlObj.pathname === '/api/user-rules/order-off-threshold') return await handleSetOrderOffThreshold(req, res);
            if (req.method === 'POST' && urlObj.pathname === '/api/products/online') return await handleProductOnlineQuery(req, res);
            if (req.method === 'POST' && urlObj.pathname === '/api/products/forbidden/play') return await handleProductForbiddenPlay(req, res);
            if (req.method === 'POST' && urlObj.pathname === '/api/products/forbidden/query') return await handleProductForbiddenQuery(req, res);
            if (req.method === 'POST' && urlObj.pathname === '/api/products/purchase-config') return await handleProductPurchaseConfig(req, res);
            if (req.method === 'POST' && urlObj.pathname === '/api/products/account-switch/toggle') return await handleProductAccountSwitchToggle(req, res);
            if (req.method === 'GET' && urlObj.pathname === '/api/risk-center/events') return await handleRiskCenterList(req, res, urlObj);
            if (req.method === 'POST' && urlObj.pathname === '/api/blacklist/add') return await handleBlacklistAdd(req, res);
            if (req.method === 'POST' && urlObj.pathname === '/api/blacklist/remove') return await handleBlacklistRemove(req, res);
            if (req.method === 'POST' && urlObj.pathname === '/api/products/maintenance/toggle') return await handleProductMaintenanceToggle(req, res);
            if (req.method === 'GET' && urlObj.pathname === '/api/auth/platforms') return await authBff.handleGetPlatformAuthList(req, res, urlObj);
            if (req.method === 'POST' && urlObj.pathname === '/api/auth/platforms/upsert') return await authBff.handleUpsertPlatformAuth(req, res);
            if (req.method === 'POST' && urlObj.pathname === '/api/auth/platforms/upsert-from-curl') return await authBff.handleUpsertPlatformAuthFromCurl(req, res);
            if (req.method === 'GET' && urlObj.pathname === '/api/ping') return json(res, 200, { ok: true, ts: Date.now() });

            if ((req.method === 'GET' || req.method === 'HEAD') && tryServeStatic(req, urlObj, res)) return;
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
