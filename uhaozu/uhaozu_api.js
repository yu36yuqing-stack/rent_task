const {
    nowText,
    initUhaozuGoodsAccountCacheDb,
    listUhaozuResolvedGoodsCache,
    listUhaozuAccountRoleCache,
    listUhaozuActiveGoodsDetailFailCache,
    upsertUhaozuGoodsResolved,
    upsertUhaozuGoodsDetailFail
} = require('../database/uhaozu_goods_account_cache_db');

const DEFAULT_UHAOZU_API_BASE = 'https://mapi.uhaozu.com';
const DEFAULT_UHAOZU_TIMEOUT_MS = 15000;
const DEFAULT_GOODS_DETAIL_FAIL_TTL_SEC = 3600;

function buildDefaultHeaders(cookie) {
    return {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'tml': '{"platform":"20","terminal":"0"}',
    'sec-ch-ua-platform': '"macOS"',
    'sec-ch-ua': '"Not(A:Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
    'sec-ch-ua-mobile': '?0',
    'X-Requested-With': 'XMLHttpRequest',
    'Content-Type': 'application/json;charset=UTF-8',
    'Origin': 'https://b.uhaozu.com',
    'Sec-Fetch-Site': 'same-site',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    'Referer': 'https://b.uhaozu.com/goods',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Cookie': cookie
};
}

function buildOrderHeaders(cookie) {
    return {
        ...buildDefaultHeaders(cookie),
        Referer: 'https://b.uhaozu.com/order'
    };
}

function resolveAuth(auth = {}) {
    const cfg = {
        api_base: String(auth.api_base || DEFAULT_UHAOZU_API_BASE),
        timeout_ms: Number(auth.timeout_ms || DEFAULT_UHAOZU_TIMEOUT_MS),
        cookie: String(auth.cookie || '').trim()
    };
    if (!cfg.cookie) throw new Error('uhaozu cookie 未配置');
    return cfg;
}

function formatV(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    return `${y}${m}${day}${h}${min}${s}`;
}

async function requestJson(url, options = {}, timeoutMs = DEFAULT_UHAOZU_TIMEOUT_MS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        const text = await res.text();
        let json;
        try {
            json = text ? JSON.parse(text) : {};
        } catch (e) {
            throw new Error(`U号租返回非JSON: status=${res.status}, body=${text.slice(0, 200)}`);
        }
        if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${json.message || json.msg || text.slice(0, 200)}`);
        }
        return json;
    } finally {
        clearTimeout(timer);
    }
}

function isApiSuccess(json) {
    if (!json || typeof json !== 'object') return false;
    if (json.success === true) return true;
    if (json.code === 0) return true;
    if (json.status === 200) return true;
    return false;
}

function mapStatus(item) {
    const goodsStatus = Number(item.goodsStatus);
    const rentStatus = Number(item.rentStatus);
    const auditReason = String(item.auditReason || item.auditReasonDesc || '').trim();

    if (auditReason) {
        return { status: '审核失败', reason: auditReason };
    }
    // 文档说明：goodsStatus=4 下架；goodsStatus=3 上架，rentStatus 区分待租/出租中
    if (goodsStatus === 4) return { status: '下架', reason: '' };
    if (goodsStatus === 3 && rentStatus === 0) return { status: '租赁中', reason: '' };
    if (goodsStatus === 3 && rentStatus === 1) return { status: '上架', reason: '' };

    // 兜底
    if (rentStatus === 0) return { status: '租赁中', reason: '' };
    if (rentStatus === 1) return { status: '上架', reason: '' };
    return { status: '未知', reason: '' };
}

async function normalizeList(rawList, auth = {}) {
    const maps = await loadAccountMaps();
    const { accountByRemark, roleByAccount, entries } = maps;
    const goodsAccountCache = await loadGoodsAccountCache();
    const staged = rawList.map(item => {
        const id = String(item.id || item.goodsId || item.productId || '');
        const accountFromApi = String(item.gameAccount || item.accountNo || item.account || '').trim();
        const accountFromCache = id ? String(goodsAccountCache[id] || '').trim() : '';
        const roleName = String(item.gameRoleName || item.remark || item.remarkName || '').trim();
        const resolved = accountFromApi || accountFromCache || '';
        const { status, reason } = mapStatus(item);

        return {
            id,
            account: resolved,
            accountFromApi,
            accountFromCache,
            roleName,
            status,
            reason,
            remark: String(item.remark || item.remarkName || roleName || item.gameNickName || resolved || id),
            goodsStatus: item.goodsStatus,
            rentStatus: item.rentStatus,
            raw: item
        };
    }).filter(i => i.id);

    const { fetchedCount, cacheHitCount } = await fillMissingAccountsByGoodsId(staged, goodsAccountCache, auth);

    const used = new Set(staged.map(i => i.account).filter(Boolean));
    for (const row of staged) {
        if (row.account) continue;
        const byRemark = resolveAccountByRole(row.roleName, accountByRemark);
        const guessed = byRemark || guessAccountByFuzzy(row.roleName, entries, used);
        if (guessed) {
            row.account = guessed;
            used.add(guessed);
        }
    }

    const out = staged.filter(i => i.account);
    for (const row of out) {
        if (row.account && row.roleName) roleByAccount[row.account] = row.roleName;
        await upsertUhaozuGoodsResolved({
            goods_id: String(row.id || '').trim(),
            game_account: String(row.account || '').trim(),
            role_name: String(row.roleName || '').trim(),
            game_id: String(row.raw && row.raw.gameId || '').trim(),
            desc: 'upsert by uhaozu normalize list'
        });
        delete row.accountFromApi;
        delete row.accountFromCache;
        delete row.roleName;
    }
    console.log(`[UhaozuAPI] 账号补全完成 total=${staged.length} resolved=${out.length} cacheHit=${cacheHitCount} fetched=${fetchedCount}`);
    return out;
}

function extractListAndTotal(json) {
    let list = [];
    let total = 0;

    if (Array.isArray(json.object)) list = json.object;
    else if (json.object && typeof json.object === 'object') list = Object.values(json.object);
    else if (json.object && Array.isArray(json.object.list)) list = json.object.list;
    else if (json.data && Array.isArray(json.data.list)) list = json.data.list;
    else if (json.data && Array.isArray(json.data.rows)) list = json.data.rows;

    if (json.totalCount !== undefined) total = Number(json.totalCount) || 0;
    else if (json.object && json.object.totalCount !== undefined) total = Number(json.object.totalCount) || 0;
    else if (json.data && json.data.totalCount !== undefined) total = Number(json.data.totalCount) || 0;
    else total = list.length;

    return { list, total };
}

function buildListPayload(page, pageSize, overrides = {}) {
    return {
        gameId: -1,
        serverId: '',
        carrierId: '',
        operationType: 2,
        goodsBaseType: -1,
        hasNoDeposit: '',
        hasDiscounts: '',
        loginMethod: '',
        keyWords: '',
        options: [],
        optionsSize: 0,
        selfSupport: 1,
        order: '',
        pageSize,
        page,
        originRentalByHourStart: '',
        originRentalByHourEnd: '',
        shardingProperties: [],
        antiAddictionGoods: 0,
        loginRate: false,
        loginMethodV2: '',
        checkCotenantForB: '',
        auditReason: '',
        hidden: null,
        ...overrides
    };
}

async function listGoodsPage(page = 1, pageSize = 30, overrides = {}, auth = {}) {
    const cfg = resolveAuth(auth);
    const headers = buildDefaultHeaders(cfg.cookie);
    const v = formatV();
    const url = `${cfg.api_base}/merchants/goods/list?v=${v}`;
    const payload = buildListPayload(page, pageSize, overrides);
    const json = await requestJson(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
    }, cfg.timeout_ms);
    if (!isApiSuccess(json)) {
        throw new Error(`U号租列表API失败: ${json.message || json.msg || JSON.stringify(json).slice(0, 200)}`);
    }
    return json;
}

function buildOrderListPayload(pageNum = 1, pageSize = 30, overrides = {}) {
    const ext = { ...overrides };
    delete ext.pageNum;
    delete ext.pageSize;
    delete ext.__path;
    return {
        pageNum,
        pageSize,
        startDate: '',
        endDate: '',
        timeType: 1,
        unionType: '',
        dealComplain: 0,
        status: '',
        complainStatus: '',
        createrNames: [],
        ...ext
    };
}

function extractOrderListAndMeta(json = {}) {
    const list = Array.isArray(json.object) ? json.object : [];
    const pages = Number(json.pages || 0);
    const totalCount = Number(json.totalCount || list.length || 0);
    return { list, pages, totalCount };
}

async function listOrderPage(pageNum = 1, pageSize = 30, overrides = {}, auth = {}) {
    const cfg = resolveAuth(auth);
    const headers = buildOrderHeaders(cfg.cookie);
    const path = String(overrides.__path || auth.order_list_path || '/merchants/order/submit/orderList').trim();
    const url = `${cfg.api_base}${path}`;
    const payload = buildOrderListPayload(pageNum, pageSize, overrides);
    const json = await requestJson(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
    }, cfg.timeout_ms);

    if (!isApiSuccess(json) || String(json.responseCode || '') !== '0000') {
        throw new Error(`U号租订单API失败: ${json.responseMsg || json.message || json.msg || JSON.stringify(json).slice(0, 200)}`);
    }
    const isCountOnly = json && json.object && !Array.isArray(json.object)
        && json.object.dealComplainCount !== undefined
        && json.object.leaseCount !== undefined
        && json.object.lockingCount !== undefined
        && json.pages === undefined
        && json.totalCount === undefined;
    if (isCountOnly) {
        throw new Error(`U号租订单接口返回计数对象而非列表，请确认 order_list_path。当前 path=${path}`);
    }
    return json;
}

async function listAllOrderPages(pageSize = 30, overrides = {}, auth = {}) {
    const all = [];
    let pageNum = Number(overrides.pageNum || 1);
    let pages = 0;
    let totalCount = 0;
    let guard = 0;

    while (guard++ < 200) {
        const json = await listOrderPage(pageNum, pageSize, overrides, auth);
        const meta = extractOrderListAndMeta(json);
        if (pageNum === Number(overrides.pageNum || 1)) {
            pages = meta.pages;
            totalCount = meta.totalCount;
        }
        if (!Array.isArray(meta.list) || meta.list.length === 0) break;
        all.push(...meta.list);
        if (pages > 0 && pageNum >= pages) break;
        if (all.length >= totalCount && totalCount > 0) break;
        pageNum += 1;
    }

    return {
        order_list: all,
        total_count: totalCount || all.length,
        pages
    };
}

async function listAllGoods(pageSize = 30, auth = {}) {
    const all = [];
    let page = 1;
    let total = 0;
    let guard = 0;
    while (guard++ < 200) {
        const json = await listGoodsPage(page, pageSize, {}, auth);
        const { list, total: t } = extractListAndTotal(json);
        if (page === 1) total = t;
        if (!Array.isArray(list) || list.length === 0) break;
        all.push(...list);
        if (all.length >= total) break;
        page += 1;
    }
    return all;
}

async function queryGoodsDetailByGoodsId(goodsId, auth = {}) {
    const cfg = resolveAuth(auth);
    const headers = buildDefaultHeaders(cfg.cookie);
    const id = String(goodsId);
    const url = `${cfg.api_base}/merchants/goods/modify/query/${encodeURIComponent(id)}`;
    const json = await requestJson(url, {
        method: 'POST',
        headers: {
            ...headers,
            'Content-Type': 'application/json;charset=UTF-8'
        },
        body: ''
    }, cfg.timeout_ms);
    if (!isApiSuccess(json) || String(json.responseCode || '') !== '0000') return null;
    const goods = json && json.object && json.object.goods && typeof json.object.goods === 'object'
        ? json.object.goods
        : null;
    if (!goods) return null;
    return {
        account: String(goods.gameAccount || goods.accountNo || goods.account || '').trim(),
        role_name: String(goods.gameRoleName || '').trim(),
        game_id: String(goods.gameId || '').trim(),
        goods_id: String(goods.id || id).trim()
    };
}

async function findGoodsByAccount(account, auth = {}) {
    const target = String(account);
    // gameAccount 字段在全量列表常被脱敏为空；优先走 keyWords 精确搜索。
    const searchRes = await listGoodsPage(1, 30, { keyWords: target }, auth);
    const search = extractListAndTotal(searchRes).list;
    if (search.length > 0) return search[0];
    const list = await listAllGoods(30, auth);
    return list.find(item => String(item.gameAccount || item.accountNo || item.account || '') === target) || null;
}

async function callUnshelf(goodsId, auth = {}) {
    const cfg = resolveAuth(auth);
    const headers = buildDefaultHeaders(cfg.cookie);
    const url = `${cfg.api_base}/merchants/goods/unShelves/${encodeURIComponent(String(goodsId))}`;
    const json = await requestJson(url, {
        method: 'POST',
        headers: {
            ...headers,
            'Content-Type': 'application/json;charset=UTF-8'
        },
        body: ''
    }, cfg.timeout_ms);
    return isApiSuccess(json);
}

async function callShelf(goodsId, auth = {}) {
    const cfg = resolveAuth(auth);
    const headers = buildDefaultHeaders(cfg.cookie);
    const id = String(goodsId);
    const url = `${cfg.api_base}/api/goods/shelves/${encodeURIComponent(id)}`;
    const json = await requestJson(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ goodsId: Number(id), forbidplayConfirm: false })
    }, cfg.timeout_ms);
    return isApiSuccess(json);
}

function normalizeText(s) {
    return String(s || '')
        .toLowerCase()
        .replace(/\s+/g, '')
        .replace(/[^\p{Script=Han}\p{L}\p{N}]/gu, '');
}

async function loadAccountMaps() {
    await initUhaozuGoodsAccountCacheDb();
    const roleByAccount = {};

    try {
        const rows = await listUhaozuAccountRoleCache();
        for (const row of rows) {
            const acc = String(row.game_account || '').trim();
            const role = String(row.role_name || '').trim();
            if (acc && role) roleByAccount[acc] = role;
        }
    } catch (e) {
        console.warn(`[UhaozuAPI] 读取账号映射缓存表失败: ${e.message}`);
    }

    const accountByRemark = {};
    const entries = [];
    for (const [acc, role] of Object.entries(roleByAccount)) {
        const key = normalizeText(role);
        if (key) {
            accountByRemark[key] = acc;
            entries.push({ account: acc, remark: role, key });
        }
    }
    return { roleByAccount, accountByRemark, entries };
}

async function loadGoodsAccountCache() {
    await initUhaozuGoodsAccountCacheDb();
    const rows = await listUhaozuResolvedGoodsCache();
    const out = {};
    for (const row of rows) {
        const goodsId = String(row.goods_id || row.cache_key || '').trim();
        const gameAccount = String(row.game_account || '').trim();
        if (!goodsId || !gameAccount) continue;
        out[goodsId] = gameAccount;
    }
    return out;
}

async function loadGoodsDetailFailCache() {
    await initUhaozuGoodsAccountCacheDb();
    const rows = await listUhaozuActiveGoodsDetailFailCache();
    const out = {};
    for (const row of rows) {
        const goodsId = String(row.goods_id || row.cache_key || '').trim();
        if (!goodsId) continue;
        out[goodsId] = {
            fail_expire_at: String(row.fail_expire_at || '').trim(),
            reason: String(row.fail_reason || '').trim()
        };
    }
    return out;
}

async function fillMissingAccountsByGoodsId(rows, goodsAccountCache, auth = {}) {
    let fetchedCount = 0;
    let cacheHitCount = 0;
    let detailHitCount = 0;
    let detailSkipCount = 0;
    const failCache = await loadGoodsDetailFailCache();
    const failTtlSec = Math.max(60, Number(auth.goods_detail_fail_ttl_sec || DEFAULT_GOODS_DETAIL_FAIL_TTL_SEC));
    const nowValue = nowText();

    for (const row of rows) {
        if (row.account) {
            if (row.accountFromCache) cacheHitCount += 1;
            continue;
        }
        const id = String(row.id || '');
        if (!id) continue;

        const cached = String(goodsAccountCache[id] || '').trim();
        if (cached) {
            row.account = cached;
            row.accountFromCache = cached;
            cacheHitCount += 1;
            continue;
        }

        const failMeta = failCache[id] && typeof failCache[id] === 'object' ? failCache[id] : null;
        if (failMeta && String(failMeta.fail_expire_at || '') > nowValue) {
            detailSkipCount += 1;
            console.log(`[UhaozuAPI] goods detail skip by fail ttl goodsId=${id} ttl_sec=${failTtlSec} gameId=${String(row.raw && row.raw.gameId || '')} gameName=${String(row.raw && row.raw.gameName || '')} roleName=${row.roleName}`);
            continue;
        }

        try {
            const detail = await queryGoodsDetailByGoodsId(id, auth);
            const account = String(detail && detail.account || '').trim();
            if (account) {
                row.account = account;
                if (!row.roleName) row.roleName = String(detail.role_name || '').trim();
                goodsAccountCache[id] = account;
                await upsertUhaozuGoodsResolved({
                    goods_id: id,
                    game_account: account,
                    role_name: String(row.roleName || '').trim(),
                    game_id: String(row.raw && row.raw.gameId || detail.game_id || '').trim(),
                    desc: 'upsert by uhaozu goods detail resolve'
                });
                fetchedCount += 1;
                detailHitCount += 1;
                console.log(`[UhaozuAPI] goods detail resolve goodsId=${id} gameId=${String(row.raw && row.raw.gameId || detail.game_id || '')} gameName=${String(row.raw && row.raw.gameName || '')} account=${account} roleName=${String(row.roleName || '')}`);
            } else {
                const failExpireAt = nowText(Date.now() + failTtlSec * 1000);
                await upsertUhaozuGoodsDetailFail({
                    goods_id: id,
                    fail_reason: 'empty_account',
                    fail_expire_at: failExpireAt,
                    desc: 'upsert by uhaozu goods detail empty account'
                });
                failCache[id] = { fail_expire_at: failExpireAt, reason: 'empty_account' };
                console.warn(`[UhaozuAPI] goods detail empty goodsId=${id} gameId=${String(row.raw && row.raw.gameId || '')} gameName=${String(row.raw && row.raw.gameName || '')} roleName=${String(row.roleName || '')}`);
            }
        } catch (e) {
            const failExpireAt = nowText(Date.now() + failTtlSec * 1000);
            await upsertUhaozuGoodsDetailFail({
                goods_id: id,
                fail_reason: String(e.message || e),
                fail_expire_at: failExpireAt,
                desc: 'upsert by uhaozu goods detail query error'
            });
            failCache[id] = { fail_expire_at: failExpireAt, reason: String(e.message || e) };
            console.warn(`[UhaozuAPI] goods detail query失败 goodsId=${id}: ${e.message}`);
        }
    }
    return { fetchedCount, cacheHitCount, detailHitCount, detailSkipCount };
}

function resolveAccountByRole(roleName, accountByRemark) {
    const roleKey = normalizeText(roleName);
    if (!roleKey) return '';
    if (accountByRemark[roleKey]) return accountByRemark[roleKey];

    let matched = '';
    for (const [remarkKey, acc] of Object.entries(accountByRemark)) {
        if (remarkKey.includes(roleKey) || roleKey.includes(remarkKey)) {
            if (matched && matched !== acc) return '';
            matched = acc;
        }
    }
    return matched;
}

function similarityScore(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 100;
    if (a.includes(b) || b.includes(a)) return 80;

    const sa = new Set(a.split(''));
    const sb = new Set(b.split(''));
    let common = 0;
    for (const ch of sa) if (sb.has(ch)) common += 1;
    return common * 10;
}

function guessAccountByFuzzy(roleName, entries, usedAccounts) {
    const roleKey = normalizeText(roleName);
    if (!roleKey) return '';

    let best = { account: '', score: 0 };
    let second = { account: '', score: 0 };

    for (const entry of entries) {
        if (usedAccounts.has(entry.account)) continue;
        const score = similarityScore(roleKey, entry.key);
        if (score > best.score) {
            second = best;
            best = { account: entry.account, score };
        } else if (score > second.score) {
            second = { account: entry.account, score };
        }
    }

    if (best.score >= 20 && best.score > second.score) return best.account;
    return '';
}

// 与 uhaozu_logic.js 保持同样接口（先不替换主集成）
async function collectUhaozuData(_browser, _uhaozuUrl, options = {}) {
    const auth = options.auth || {};
    const raw = await listAllGoods(30, auth);
    const data = await normalizeList(raw, auth);
    return { page: null, data };
}

async function uhaozuOffShelf(_page, account, options = {}) {
    const auth = options.auth || {};
    try {
        const goods = await findGoodsByAccount(account, auth);
        if (!goods) {
            console.log(`[UhaozuAPI] 下架失败，未找到账号: ${account}`);
            return false;
        }
        const ok = await callUnshelf(goods.id, auth);
        if (ok) console.log(`[UhaozuAPI] 下架成功: account=${account}, goodsId=${goods.id}`);
        else console.warn(`[UhaozuAPI] 下架失败: account=${account}, goodsId=${goods.id}`);
        return ok;
    } catch (e) {
        console.error(`[UhaozuAPI] 下架异常: account=${account}, err=${e.message}`);
        return false;
    }
}

async function uhaozuOnShelf(_page, account, options = {}) {
    const auth = options.auth || {};
    try {
        const goods = await findGoodsByAccount(account, auth);
        if (!goods) {
            console.log(`[UhaozuAPI] 上架失败，未找到账号: ${account}`);
            return false;
        }
        const ok = await callShelf(goods.id, auth);
        if (ok) console.log(`[UhaozuAPI] 上架成功: account=${account}, goodsId=${goods.id}`);
        else console.warn(`[UhaozuAPI] 上架失败: account=${account}, goodsId=${goods.id}`);
        return ok;
    } catch (e) {
        console.error(`[UhaozuAPI] 上架异常: account=${account}, err=${e.message}`);
        return false;
    }
}

module.exports = {
    collectUhaozuData,
    uhaozuOffShelf,
    uhaozuOnShelf,
    listOrderPage,
    listAllOrderPages,

    // 便于单测/诊断
    _internals: {
        formatV,
        requestJson,
        isApiSuccess,
        mapStatus,
        normalizeText,
        normalizeList,
        extractListAndTotal,
        buildListPayload,
        loadAccountMaps,
        loadGoodsAccountCache,
        loadGoodsDetailFailCache,
        fillMissingAccountsByGoodsId,
        queryGoodsDetailByGoodsId,
        resolveAccountByRole,
        similarityScore,
        guessAccountByFuzzy,
        listGoodsPage,
        listAllGoods,
        findGoodsByAccount,
        callUnshelf,
        callShelf,
        buildOrderHeaders,
        buildOrderListPayload,
        extractOrderListAndMeta
    }
};
