const crypto = require('crypto');

// 来自 youyouzuhao_api.md
const APP_KEY = 'd8303c79f9354ea2bed061cb28609f3b';
const APP_SECRET = '902d9ba500a84c81b80115b1d7fd51e2';

// 可通过环境变量覆盖，便于灰度/测试
const API_BASE = process.env.YOUYOUZUHAO_API_BASE || 'https://acctrade-api.youpin898.com';
const TIMEOUT_MS = Number(process.env.YOUYOUZUHAO_API_TIMEOUT_MS || 15000);

const PATH_LIST = '/api/youpin/rent-connector/product/v1/list';
const PATH_ON = '/api/youpin/rent-connector/product/v1/on';
const PATH_OFF = '/api/youpin/rent-connector/product/v1/off';

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

async function postSigned(path, businessParams = {}) {
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = {
        ...businessParams,
        appKey: APP_KEY,
        timestamp
    };
    payload.sign = createSign(payload, APP_SECRET);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
        const res = await fetch(`${API_BASE}${path}`, {
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

async function listProductsByTab(tabKey) {
    const rows = [];
    let lastId = '';
    let guard = 0;

    while (guard++ < 200) {
        const req = { tabKey, limit: 50 };
        if (lastId) req.lastId = lastId;
        const json = await postSigned(PATH_LIST, req);
        const data = json.data || {};
        const list = Array.isArray(data.productPublishList) ? data.productPublishList : [];
        rows.push(...list.map(item => ({ ...item, _tabKey: tabKey })));

        const nextLastId = data.lastId || '';
        if (!nextLastId || list.length === 0 || nextLastId === lastId) break;
        lastId = nextLastId;
    }

    return rows;
}

async function listAllProducts() {
    const [sale, rent, off] = await Promise.all([
        listProductsByTab('SALE'), // 在租
        listProductsByTab('RENT'), // 出租中
        listProductsByTab('OFF') // 已下架
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

async function findProductByAccount(account) {
    const target = String(account);
    const all = await listAllProducts();
    return all.find(p => String(p.accountNo || '') === target) || null;
}

// 与 youpin_logic.js 保持同样接口（先不替换主集成）
async function collectYoupinData(_browser, _youpinUrl) {
    const all = await listAllProducts();
    const data = all.map(mapProductToRobotItem).filter(i => i.account);
    return { page: null, data };
}

async function youpinOffShelf(_page, account) {
    try {
        const product = await findProductByAccount(account);
        if (!product) {
            console.log(`[YouyouAPI] 下架失败，未找到账号: ${account}`);
            return false;
        }
        await postSigned(PATH_OFF, { productId: String(product.productId) });
        console.log(`[YouyouAPI] 下架成功: account=${account}, productId=${product.productId}`);
        return true;
    } catch (e) {
        console.error(`[YouyouAPI] 下架异常: account=${account}, err=${e.message}`);
        return false;
    }
}

async function youpinOnShelf(_page, account) {
    try {
        const product = await findProductByAccount(account);
        if (!product) {
            console.log(`[YouyouAPI] 上架失败，未找到账号: ${account}`);
            return false;
        }
        await postSigned(PATH_ON, { productId: String(product.productId) });
        console.log(`[YouyouAPI] 上架成功: account=${account}, productId=${product.productId}`);
        return true;
    } catch (e) {
        console.error(`[YouyouAPI] 上架异常: account=${account}, err=${e.message}`);
        return false;
    }
}

module.exports = {
    collectYoupinData,
    youpinOffShelf,
    youpinOnShelf,

    // 便于单测/诊断
    _internals: {
        createSign,
        postSigned,
        listProductsByTab,
        listAllProducts,
        findProductByAccount,
        mapProductToRobotItem
    }
};
