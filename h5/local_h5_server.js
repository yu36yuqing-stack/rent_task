#!/usr/bin/env node
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { initUserDb, verifyUserLogin } = require('../database/user_db');
const { initUserGameAccountDb, listUserGameAccounts } = require('../database/user_game_account_db');
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
const { createAccessToken } = require('../user/auth_token');
const { parseAccessTokenOrThrow } = require('../api/auth_middleware');
const { queryAccountOnlineStatus } = require('../uuzuhao/uuzuhao_api');

const HOST = process.env.H5_HOST || '0.0.0.0';
const PORT = Number(process.env.H5_PORT || 8080);
const PUBLIC_DIR = path.join(__dirname, 'public');

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
    if (!token) throw new Error('未登录或 token 缺失');
    const { user } = await parseAccessTokenOrThrow(token);
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
    if (!account || !password) {
        return json(res, 400, { ok: false, message: '账号和密码不能为空' });
    }
    const result = await verifyUserLogin(account, password);
    if (!result.ok) {
        return json(res, 401, { ok: false, message: result.reason || '登录失败' });
    }
    const token = createAccessToken(result.user);
    return json(res, 200, {
        ok: true,
        token,
        user: {
            id: result.user.id,
            account: result.user.account,
            name: result.user.name,
            user_type: result.user.user_type
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
    const totalPaid = sourceList.reduce((sum, x) => {
        return sum + Number(x.today_paid_count || 0);
    }, 0);

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
    if (!hit) throw new Error('缺少可用的 uuzuhao 授权');

    const payload = hit && typeof hit.auth_payload === 'object' ? hit.auth_payload : {};
    const appKey = String(payload.app_key || '').trim();
    const appSecret = String(payload.app_secret || '').trim();
    if (!appKey || !appSecret) {
        throw new Error('uuzuhao 授权缺少 app_key/app_secret');
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
    const result = await queryAccountOnlineStatus(gameAccount, gameName, { auth });
    return json(res, 200, {
        ok: true,
        data: {
            game_account: gameAccount,
            game_name: result.game_name,
            online: Boolean(result.online)
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

    const server = http.createServer(async (req, res) => {
        const urlObj = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
        try {
            if (req.method === 'POST' && urlObj.pathname === '/api/login') return await handleLogin(req, res);
            if (req.method === 'GET' && urlObj.pathname === '/api/products') return await handleProducts(req, res, urlObj);
            if (req.method === 'POST' && urlObj.pathname === '/api/products/online') return await handleProductOnlineQuery(req, res);
            if (req.method === 'POST' && urlObj.pathname === '/api/blacklist/add') return await handleBlacklistAdd(req, res);
            if (req.method === 'POST' && urlObj.pathname === '/api/blacklist/remove') return await handleBlacklistRemove(req, res);
            if (req.method === 'GET' && urlObj.pathname === '/api/ping') return json(res, 200, { ok: true, ts: Date.now() });

            if (req.method === 'GET' && tryServeStatic(urlObj, res)) return;
            return json(res, 404, { ok: false, message: 'Not Found' });
        } catch (e) {
            return json(res, 500, { ok: false, message: String(e.message || e) });
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
