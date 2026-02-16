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
    listPlatformRestrictByUserAndAccounts
} = require('../database/user_platform_restrict_db');
const { initOrderDb, listTodayPaidOrderCountByAccounts } = require('../database/order_db');
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
const { listOrdersForUser, syncOrdersByUser } = require('../order/order');
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

function normalizeOrderOffThreshold(v, fallback = 3) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(1, Math.min(10, Math.floor(n)));
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
            remark: String((row && row.remark) || '').trim()
        };
    }

    const allRows = await listAllAccountsByUser(user.id);
    const allAccs = allRows.list.map((x) => String(x.game_account || '').trim()).filter(Boolean);
    const paidMap = allAccs.length > 0 ? await listTodayPaidOrderCountByAccounts(user.id, allAccs) : {};
    const restrictRows = allAccs.length > 0 ? await listPlatformRestrictByUserAndAccounts(user.id, allAccs) : [];
    const restrictMap = {};
    for (const row of restrictRows) {
        const acc = String((row && row.game_account) || '').trim();
        if (!acc) continue;
        if (!restrictMap[acc]) restrictMap[acc] = [];
        const detail = row && typeof row.detail === 'object' ? row.detail : {};
        const platform = String((row && row.platform) || detail.platform || '').trim();
        const msg = String(detail.msg || '').trim();
        const platformName = platform === 'uuzuhao' ? '悠悠'
            : platform === 'uhaozu' ? 'U号'
            : platform === 'zuhaowang' ? '租号王'
            : platform;
        const text = platformName && msg ? `${platformName}: ${msg}` : (msg || platformName || RESTRICT_REASON);
        restrictMap[acc].push(text);
    }
    const fullList = allRows.list.map((x) => {
        const acc = String(x.game_account || '').trim();
        const bl = blacklistMap[acc] || null;
        const restrictList = Array.isArray(restrictMap[acc]) ? restrictMap[acc] : [];
        const modeRestricted = Boolean(bl) || restrictList.length > 0;
        const modeReason = bl
            ? String(bl.reason || '').trim()
            : restrictList.join('；');
        return {
            id: x.id,
            game_name: x.game_name,
            game_account: acc,
            role_name: String(x.account_remark || '').trim() || acc,
            purchase_price: Number(x.purchase_price || 0),
            purchase_date: String(x.purchase_date || '').slice(0, 10),
            channel_status: x.channel_status || {},
            today_paid_count: Number(paidMap[acc] || 0),
            blacklisted: Boolean(bl),
            blacklist_reason: bl ? bl.reason : '',
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
        list
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
    return json(res, 200, { ok: true, ...data });
}

async function handleOrderSyncNow(req, res) {
    const user = await requireAuth(req);
    const out = await syncOrdersByUser(user.id, {
        user,
        uuzuhao: { maxPages: 20 },
        uhaozu: { maxPages: 20 },
        zuhaowang: { maxPages: 20 }
    });
    return json(res, 200, { ok: true, ...out });
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
    const out = await refreshOrderStatsDailyByUser(user.id, {
        days,
        game_name: gameName,
        desc: 'manual by h5 stats refresh'
    });
    return json(res, 200, { ok: true, ...out });
}

async function handleGetOrderOffThreshold(req, res) {
    const user = await requireAuth(req);
    const rule = await getUserRuleByName(user.id, ORDER_OFF_THRESHOLD_RULE_NAME);
    const detail = rule && rule.rule_detail && typeof rule.rule_detail === 'object' ? rule.rule_detail : {};
    const threshold = normalizeOrderOffThreshold(detail.threshold ?? detail.order_off_threshold ?? detail.value, 3);
    return json(res, 200, { ok: true, threshold, rule_name: ORDER_OFF_THRESHOLD_RULE_NAME });
}

async function handleSetOrderOffThreshold(req, res) {
    const user = await requireAuth(req);
    const body = await readJsonBody(req);
    const threshold = normalizeOrderOffThreshold(body.threshold, NaN);
    if (!Number.isFinite(threshold)) {
        return json(res, 400, { ok: false, message: 'threshold 必须是 1~10 的整数' });
    }
    await upsertUserRuleByName(user.id, {
        rule_name: ORDER_OFF_THRESHOLD_RULE_NAME,
        rule_detail: { threshold }
    }, {
        desc: 'set by h5'
    });
    return json(res, 200, { ok: true, threshold, rule_name: ORDER_OFF_THRESHOLD_RULE_NAME });
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

    const server = http.createServer(async (req, res) => {
        const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        try {
            if (req.method === 'POST' && urlObj.pathname === '/api/login') return await handleLogin(req, res);
            if (req.method === 'POST' && urlObj.pathname === '/api/refresh') return await handleRefresh(req, res);
            if (req.method === 'GET' && urlObj.pathname === '/api/products') return await handleProducts(req, res, urlObj);
            if (req.method === 'GET' && urlObj.pathname === '/api/orders') return await handleOrders(req, res, urlObj);
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
