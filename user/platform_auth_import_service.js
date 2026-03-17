const { upsertUserPlatformAuth } = require('../database/user_platform_auth_db');
const { listOrderPage } = require('../uhaozu/uhaozu_api');
const UHAOZU_DEFAULT_BASE_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    tml: '{"platform":"20","terminal":"0"}',
    'sec-ch-ua-platform': '"macOS"',
    'sec-ch-ua': '"Not:A-Brand";v="8", "Chromium";v="144", "Google Chrome";v="144"',
    'sec-ch-ua-mobile': '?0',
    'X-Requested-With': 'XMLHttpRequest',
    'Content-Type': 'application/json;charset=UTF-8',
    Origin: 'https://b.uhaozu.com',
    'Sec-Fetch-Site': 'same-site',
    'Sec-Fetch-Mode': 'cors',
    'Sec-Fetch-Dest': 'empty',
    Referer: 'https://b.uhaozu.com/goods',
    'Accept-Language': 'zh-CN,zh;q=0.9'
};
const UHAOZU_HEADER_NAME_MAP = {
    'user-agent': 'User-Agent',
    accept: 'Accept',
    'accept-encoding': 'Accept-Encoding',
    tml: 'tml',
    'sec-ch-ua-platform': 'sec-ch-ua-platform',
    'sec-ch-ua': 'sec-ch-ua',
    'sec-ch-ua-mobile': 'sec-ch-ua-mobile',
    'x-requested-with': 'X-Requested-With',
    'content-type': 'Content-Type',
    origin: 'Origin',
    'sec-fetch-site': 'Sec-Fetch-Site',
    'sec-fetch-mode': 'Sec-Fetch-Mode',
    'sec-fetch-dest': 'Sec-Fetch-Dest',
    referer: 'Referer',
    'accept-language': 'Accept-Language',
    'cache-control': 'Cache-Control',
    pragma: 'Pragma',
    connection: 'Connection'
};

function parseCurlString(input) {
    const src = String(input || '').trim();
    if (!src) throw new Error('curl 不能为空');
    const tokens = [];
    let cur = '';
    let quote = '';
    let escaped = false;
    for (let i = 0; i < src.length; i += 1) {
        const ch = src[i];
        if (escaped) {
            cur += ch;
            escaped = false;
            continue;
        }
        if (ch === '\\') {
            escaped = true;
            continue;
        }
        if (quote) {
            if (ch === quote) {
                quote = '';
                continue;
            }
            cur += ch;
            continue;
        }
        if (ch === '\'' || ch === '"') {
            quote = ch;
            continue;
        }
        if (/\s/.test(ch)) {
            if (cur) {
                tokens.push(cur);
                cur = '';
            }
            continue;
        }
        cur += ch;
    }
    if (cur) tokens.push(cur);
    return tokens;
}

function extractCurlMeta(curlText = '') {
    const tokens = parseCurlString(curlText);
    if (tokens.length === 0 || String(tokens[0] || '').trim() !== 'curl') {
        throw new Error('请输入完整 curl 命令');
    }
    let url = '';
    let cookie = '';
    const headers = {};
    for (let i = 1; i < tokens.length; i += 1) {
        const token = String(tokens[i] || '');
        if (!url && /^https?:\/\//i.test(token)) {
            url = token;
            continue;
        }
        if ((token === '-H' || token === '--header') && i + 1 < tokens.length) {
            const raw = String(tokens[i + 1] || '');
            const idx = raw.indexOf(':');
            if (idx > 0) {
                const key = raw.slice(0, idx).trim();
                const value = raw.slice(idx + 1).trim();
                headers[key.toLowerCase()] = value;
            }
            i += 1;
            continue;
        }
        if ((token === '-b' || token === '--cookie') && i + 1 < tokens.length) {
            cookie = String(tokens[i + 1] || '').trim();
            i += 1;
        }
    }
    if (!cookie && headers.cookie) cookie = String(headers.cookie || '').trim();
    return { url, cookie, headers };
}

function buildUhaozuDefaultHeaders(headers = {}) {
    const src = headers && typeof headers === 'object' ? headers : {};
    const merged = { ...UHAOZU_DEFAULT_BASE_HEADERS };
    for (const [rawKey, rawValue] of Object.entries(src)) {
        const canonical = UHAOZU_HEADER_NAME_MAP[String(rawKey || '').trim().toLowerCase()];
        if (!canonical || canonical === 'Cookie') continue;
        const next = String(rawValue || '').trim();
        if (!next) continue;
        merged[canonical] = next;
    }
    return merged;
}

function parseUhaozuCurlAuthPayload(curlText = '') {
    const meta = extractCurlMeta(curlText);
    const url = String(meta.url || '').trim();
    if (!/mapi\.uhaozu\.com/i.test(url)) {
        throw new Error('curl 不是 U号租商家后台请求');
    }
    if (!/\/merchants\/order\/submit\/orderList/i.test(url)) {
        throw new Error('请粘贴 U号租订单列表接口的 curl');
    }
    const cookie = String(meta.cookie || '').trim();
    if (!cookie) throw new Error('curl 中未找到 Cookie');
    if (!/(^|;\s*)uid=/.test(cookie)) {
        throw new Error('Cookie 缺少 uid');
    }
    if (!/(^|;\s*)JSESSIONID=/.test(cookie)) {
        throw new Error('Cookie 缺少 JSESSIONID');
    }
    let orderPath = '';
    try {
        orderPath = String(new URL(url).pathname || '').trim();
    } catch {
        orderPath = '';
    }
    const defaultHeaders = buildUhaozuDefaultHeaders(meta.headers);
    return {
        auth_type: 'cookie',
        auth_payload: {
            cookie,
            ...(orderPath && orderPath !== '/merchants/order/submit/orderList' ? { order_list_path: orderPath } : {}),
            default_headers: defaultHeaders
        },
        auth_status: 'valid'
    };
}

async function validateUhaozuAuthPayload(authPayload = {}) {
    const now = new Date();
    const start = new Date(now.getTime() - 24 * 3600 * 1000);
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    await listOrderPage(1, 1, {
        startDate: fmt(start),
        endDate: fmt(now),
        timeType: 1,
        createrNames: []
    }, authPayload);
}

async function upsertUhaozuAuthFromCurl(userId, curlText, options = {}) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 非法');
    const parsed = parseUhaozuCurlAuthPayload(curlText);
    await validateUhaozuAuthPayload(parsed.auth_payload);
    const row = await upsertUserPlatformAuth({
        user_id: uid,
        platform: 'uhaozu',
        auth_type: parsed.auth_type,
        auth_payload: parsed.auth_payload,
        auth_status: parsed.auth_status,
        expire_at: '',
        desc: String(options.desc || 'h5 uhaozu curl auth upsert').trim()
    });
    return row;
}

module.exports = {
    extractCurlMeta,
    buildUhaozuDefaultHeaders,
    parseUhaozuCurlAuthPayload,
    validateUhaozuAuthPayload,
    upsertUhaozuAuthFromCurl
};
