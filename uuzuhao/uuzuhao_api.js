const crypto = require('crypto');

const API_BASE = 'https://acctrade-api.youpin898.com';
const TIMEOUT_MS = 15000;

const PATH_LIST = '/api/youpin/rent-connector/product/v1/list';
const PATH_ON = '/api/youpin/rent-connector/product/v1/on';
const PATH_OFF = '/api/youpin/rent-connector/product/v1/off';
const PATH_GAME_ONLINE = '/api/youpin/rent-connector/product/v1/game/online';
const PATH_ORDER_LIST = '/api/youpin/rent-connector/order/v1/list';

const GAME_ID_BY_NAME = {
    WZRY: 1
};

function toSignValue(value) {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.map(v => String(v)).join(',');
    if (typeof value === 'object') {
        // 文档里业务参数基本是标量/数组；对象仅做兜底序列化。
        return JSON.stringify(value);
    }
    return String(value);
}

function createSign(params, appSecret) {
    const keys = Object.keys(params)
        .filter(k => k !== 'sign')
        .filter(k => {
            const v = params[k];
            if (v === null || v === undefined) return false;
            const s = toSignValue(v);
            return s !== '';
        })
        .sort(); // ASCII 升序

    const pairs = keys.map(k => `${k}=${toSignValue(params[k])}`);
    const src = `${pairs.join('&')}${appSecret}`;
    return crypto.createHash('md5').update(src, 'utf8').digest('hex').toUpperCase();
}

function resolveAuth(auth = {}) {
    const cfg = {
        app_key: String(auth.app_key || '').trim(),
        app_secret: String(auth.app_secret || '').trim(),
        api_base: String(auth.api_base || API_BASE).trim(),
        timeout_ms: Number(auth.timeout_ms || TIMEOUT_MS)
    };
    if (!cfg.app_key) throw new Error('uuzuhao app_key 未配置');
    if (!cfg.app_secret) throw new Error('uuzuhao app_secret 未配置');
    return cfg;
}

async function postSigned(path, businessParams = {}, auth = {}) {
    const cfg = resolveAuth(auth);
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = {
        ...businessParams,
        appKey: cfg.app_key,
        timestamp
    };
    payload.sign = createSign(payload, cfg.app_secret);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeout_ms);

    try {
        const res = await fetch(`${cfg.api_base}${path}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=UTF-8' },
            body: JSON.stringify(payload),
            signal: controller.signal
        });

        const text = await res.text();
        let json;
        try {
            json = JSON.parse(text);
        } catch (e) {
            throw new Error(`API 返回非JSON: status=${res.status}, body=${text.slice(0, 200)}`);
        }

        if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${json.msg || text}`);
        }
        if (json.code !== 0) {
            throw new Error(`code=${json.code}, msg=${json.msg || '未知错误'}`);
        }
        return json;
    } finally {
        clearTimeout(timer);
    }
}

function mapProductToRobotItem(p) {
    // 文档语义：
    // tabKey: SALE=在租(可租/上架), RENT=出租中, OFF=已下架
    // saleStatus: 1000 在租, 2000 出租中
    // productStatus: 1000 上架; 2100/2200/2300 下架
    let status = '未知';
    if (p._tabKey === 'RENT') status = '租赁中';
    else if (p._tabKey === 'OFF') status = '下架';
    else if (p._tabKey === 'SALE') status = '上架';
    else if (p.saleStatus === 2000) status = '租赁中';
    else if (p.productStatus === 1000) status = '上架';
    else if ([2100, 2200, 2300].includes(p.productStatus)) status = '下架';

    let reason = '';
    if (status === '下架') {
        if (p.productStatus === 2100 || p.offType === 'SELLER_BLACK') reason = '系统下架';
        else if (p.productStatus === 2200 || p.offType === 'CUSTOMER') reason = '客服下架';
        else if (p.productStatus === 2300 || p.offType === 'SELLER') reason = '商家下架';
        else if (p.productOffReasonDesc) reason = p.productOffReasonDesc;
        else if (p.productOffDesc) reason = p.productOffDesc;
        else if (p.offType) reason = String(p.offType);
    }

    return {
        id: String(p.productId || ''),
        account: String(p.accountNo || ''),
        // 备注名优先展示商家备注（remarkName）
        remark: p.remarkName || p.roleName || p.productTitle || String(p.accountNo || p.productId || ''),
        status,
        reason,
        saleStatus: p.saleStatus,
        productStatus: p.productStatus,
        raw: p
    };
}

async function listProductsByTab(tabKey, auth = {}) {
    const rows = [];
    let lastId = '';
    let guard = 0;

    while (guard++ < 200) {
        const req = { tabKey, limit: 50 };
        if (lastId) req.lastId = lastId;
        const json = await postSigned(PATH_LIST, req, auth);
        const data = json.data || {};
        const list = Array.isArray(data.productPublishList) ? data.productPublishList : [];
        rows.push(...list.map(item => ({ ...item, _tabKey: tabKey })));

        const nextLastId = data.lastId || '';
        if (!nextLastId || list.length === 0 || nextLastId === lastId) break;
        lastId = nextLastId;
    }

    return rows;
}

async function listAllProducts(auth = {}) {
    const [sale, rent, off] = await Promise.all([
        listProductsByTab('SALE', auth), // 在租
        listProductsByTab('RENT', auth), // 出租中
        listProductsByTab('OFF', auth) // 已下架
    ]);

    const all = [...sale, ...rent, ...off];
    // 按 productId 去重，优先保留非 OFF 记录
    const byId = new Map();
    for (const p of all) {
        const id = String(p.productId || '');
        if (!id) continue;
        if (!byId.has(id)) {
            byId.set(id, p);
            continue;
        }
        const prev = byId.get(id);
        const prevScore = prev.saleStatus === 2000 ? 3 : (prev.productStatus === 1000 ? 2 : 1);
        const curScore = p.saleStatus === 2000 ? 3 : (p.productStatus === 1000 ? 2 : 1);
        if (curScore > prevScore) byId.set(id, p);
    }
    return Array.from(byId.values());
}

async function findProductByAccount(account, auth = {}) {
    const target = String(account);
    const all = await listAllProducts(auth);
    return all.find(p => String(p.accountNo || '') === target) || null;
}

// 与 youpin_logic.js 保持同样接口（先不替换主集成）
async function collectYoupinData(_browser, _youpinUrl, options = {}) {
    const auth = options.auth || {};
    const all = await listAllProducts(auth);
    const data = all.map(mapProductToRobotItem).filter(i => i.account);
    return { page: null, data };
}

async function youpinOffShelf(_page, account, options = {}) {
    const auth = options.auth || {};
    try {
        const product = await findProductByAccount(account, auth);
        if (!product) {
            console.log(`[YouyouAPI] 下架失败，未找到账号: ${account}`);
            return false;
        }
        await postSigned(PATH_OFF, { productId: String(product.productId) }, auth);
        console.log(`[YouyouAPI] 下架成功: account=${account}, productId=${product.productId}`);
        return true;
    } catch (e) {
        console.error(`[YouyouAPI] 下架异常: account=${account}, err=${e.message}`);
        return false;
    }
}

function parseApiErrorMessage(msg = '') {
    const text = String(msg || '').trim();
    const m = /code=(\d+),\s*msg=(.*)$/i.exec(text);
    if (!m) return { code: 0, msg: text };
    return {
        code: Number(m[1] || 0),
        msg: String(m[2] || '').trim()
    };
}

async function youpinOnShelf(_page, account, options = {}) {
    const auth = options.auth || {};
    try {
        const product = await findProductByAccount(account, auth);
        if (!product) {
            console.log(`[YouyouAPI] 上架失败，未找到账号: ${account}`);
            return options.with_detail ? { ok: false, code: 0, msg: '未找到账号' } : false;
        }
        await postSigned(PATH_ON, { productId: String(product.productId) }, auth);
        console.log(`[YouyouAPI] 上架成功: account=${account}, productId=${product.productId}`);
        return options.with_detail ? { ok: true, code: 0, msg: '' } : true;
    } catch (e) {
        console.error(`[YouyouAPI] 上架异常: account=${account}, err=${e.message}`);
        const parsed = parseApiErrorMessage(e && e.message);
        return options.with_detail ? { ok: false, code: parsed.code, msg: parsed.msg || String(e && e.message || '') } : false;
    }
}

function resolveGameIdByName(gameName = 'WZRY') {
    const key = String(gameName || 'WZRY').trim().toUpperCase();
    const gameId = Number(GAME_ID_BY_NAME[key] || 0);
    if (!gameId) throw new Error(`uuzuhao 不支持的 game_name: ${gameName}`);
    return gameId;
}

// 查询账号游戏在线状态：
// - accountId 对应项目里的 game_account
// - game_name 目前支持 WZRY（映射 gameId=1）
// - 使用与商品接口一致的 appKey + sign 签名方式
async function queryAccountOnlineStatus(accountId, gameName = 'WZRY', options = {}) {
    const auth = options.auth || {};
    const acc = String(accountId || '').trim();
    if (!acc) throw new Error('accountId 不能为空');

    const gameId = resolveGameIdByName(gameName);
    const json = await postSigned(PATH_GAME_ONLINE, {
        accountId: acc,
        gameId
    }, auth);

    const gameOnline = Boolean(json && json.data && json.data.gameOnline);
    return {
        account: acc,
        game_name: String(gameName || 'WZRY').trim().toUpperCase(),
        game_id: gameId,
        online: gameOnline,
        raw: json
    };
}

function sanitizeOrderListParams(params = {}) {
    const orderStatus = Number(params.orderStatus);
    if (!Number.isFinite(orderStatus)) {
        throw new Error('orderStatus 必填且必须是数字');
    }

    const page = Math.max(1, Number(params.page || 1));
    const pageSize = Math.min(50, Math.max(1, Number(params.pageSize || 10)));
    const req = { orderStatus, page, pageSize };

    if (params.updateStartTime !== undefined && params.updateStartTime !== null && params.updateStartTime !== '') {
        req.updateStartTime = Number(params.updateStartTime);
    }
    if (params.updateEndTime !== undefined && params.updateEndTime !== null && params.updateEndTime !== '') {
        req.updateEndTime = Number(params.updateEndTime);
    }
    if (params.userId !== undefined && params.userId !== null && params.userId !== '') {
        req.userId = Number(params.userId);
    }
    return req;
}

// 获取订单列表（单页）：
// - 对接文档 3.2.2 /order/v1/list
// - 鉴权与签名复用 postSigned（appKey+timestamp+sign）
async function listOrders(params = {}, options = {}) {
    const auth = options.auth || {};
    const req = sanitizeOrderListParams(params);
    const json = await postSigned(PATH_ORDER_LIST, req, auth);
    const data = json && json.data ? json.data : {};
    const orderList = Array.isArray(data.orderList) ? data.orderList : [];
    const totalCount = Number(data.totalCount || 0);
    return {
        order_list: orderList,
        total_count: totalCount,
        page: req.page,
        page_size: req.pageSize,
        raw: json
    };
}

// 获取订单列表（分页聚合）
async function listAllOrders(params = {}, options = {}) {
    const base = sanitizeOrderListParams(params);
    const maxPages = Math.max(1, Number(options.maxPages || 100));
    const all = [];
    let page = base.page;
    let total = 0;

    for (let i = 0; i < maxPages; i += 1) {
        const res = await listOrders({ ...base, page }, options);
        total = res.total_count;
        all.push(...res.order_list);
        if (res.order_list.length < base.pageSize) break;
        if (all.length >= total && total > 0) break;
        page += 1;
    }

    return {
        order_list: all,
        total_count: total,
        page_start: base.page,
        page_size: base.pageSize
    };
}

module.exports = {
    collectYoupinData,
    youpinOffShelf,
    youpinOnShelf,
    queryAccountOnlineStatus,
    listOrders,
    listAllOrders,

    // 便于单测/诊断
    _internals: {
        createSign,
        postSigned,
        listProductsByTab,
        listAllProducts,
        findProductByAccount,
        mapProductToRobotItem,
        resolveGameIdByName,
        sanitizeOrderListParams
    }
};
