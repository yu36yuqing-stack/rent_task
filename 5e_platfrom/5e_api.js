const API_BASE = 'https://gate.5eplay.com';
const ACCOUNT_LIST_PATH = '/rentinterface/http/v1/rent/merchant/account/list';
const ORDER_LIST_PATH = '/rentinterface/http/v1/rent/merchant/order/list';
const ACCOUNT_SHELF_UPDATE_PATH = '/rentinterface/http/v1/rent/merchant/account/shelf/update';
const DEFAULT_ORIGIN = 'https://jewelrymerchant.5eplaycdn.com';
const DEFAULT_REFERER = `${DEFAULT_ORIGIN}/`;
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_PAGE_SIZE = 100;
const DEFAULT_MAX_PAGES = 100;
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

class FiveEApiError extends Error {
    constructor(message, options = {}) {
        super(String(message || '5E API error'));
        this.name = 'FiveEApiError';
        this.http_status = Number(options.http_status || 0);
        this.code = options.code === undefined || options.code === null ? '' : String(options.code);
        this.response = options.response || null;
    }
}

function normalizePositiveInt(value, fallback, max = Number.MAX_SAFE_INTEGER) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.min(max, Math.floor(parsed));
}

function normalizeToken(value) {
    return String(value || '').trim().replace(/^Bearer\s+/i, '');
}

function normalizeOptionalUnixSeconds(value) {
    if (value === undefined || value === null || String(value).trim() === '') return 0;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return Math.floor(parsed);
}

function resolveOrderPayRange(payload = {}) {
    const payStartAt = normalizeOptionalUnixSeconds(payload.pay_start_at ?? payload.payStartAt);
    const payEndAt = normalizeOptionalUnixSeconds(payload.pay_end_at ?? payload.payEndAt);
    if ((payStartAt > 0) !== (payEndAt > 0)) {
        throw new Error('5E payStartAt and payEndAt must be configured together');
    }
    if (payStartAt > 0 && payEndAt <= payStartAt) {
        throw new Error('5E payEndAt must be greater than payStartAt');
    }
    return { payStartAt, payEndAt };
}

function resolveAuth(auth = {}) {
    const token = normalizeToken(auth.token || auth.access_token || process.env.FIVE_E_TOKEN);
    if (!token) throw new Error('5E token not configured');
    return {
        token,
        api_base: String(auth.api_base || API_BASE).trim().replace(/\/$/, ''),
        origin: String(auth.origin || DEFAULT_ORIGIN).trim(),
        referer: String(auth.referer || DEFAULT_REFERER).trim(),
        user_agent: String(auth.user_agent || DEFAULT_USER_AGENT).trim(),
        timeout_ms: normalizePositiveInt(auth.timeout_ms, DEFAULT_TIMEOUT_MS, 120000)
    };
}

function toUnixDateTime(value) {
    const seconds = Number(value || 0);
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    const date = new Date(seconds * 1000);
    if (Number.isNaN(date.getTime())) return '';
    const pad = (n) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function shelfStatusLabel(value) {
    const status = Number(value);
    if (status === 1) return 'on_shelf';
    if (status === 0) return 'off_shelf';
    return 'unknown';
}

function rentStatusLabel(value) {
    const status = Number(value);
    if (status === 1) return 'renting';
    if (status === 0) return 'idle';
    return 'unknown';
}

function mapRentAccount(item = {}) {
    return {
        id: String(item.id || ''),
        account_id: String(item.accountNo || '').trim(),
        remark: String(item.remark || '').trim(),
        shelf_status: shelfStatusLabel(item.shelfStatus),
        shelf_status_raw: Number(item.shelfStatus),
        shelf_remark: String(item.shelfRemark || '').trim(),
        rent_status: rentStatusLabel(item.rentStatus),
        rent_status_raw: Number(item.rentStatus),
        steam_id: String(item.steam64Id || '').trim(),
        steam_account: String(item.steamAccount || '').trim(),
        token_email_or_mafile: String(item.steamEmail || '').trim(),
        created_at: String(item.createdAt || '').trim(),
        channel_divide: Number(item.channelDivide || 0),
        account_value: String(item.value || '').trim(),
        login_type: Number(item.loginType || 0),
        mafile_expire_time: String(item.mafileExpireTime || '').trim(),
        mafile_expire_at: toUnixDateTime(item.mafileExpireTime),
        expire_time: String(item.expireTime || '').trim(),
        expire_at: toUnixDateTime(item.expireTime),
        config_time: String(item.configTime || '').trim(),
        pinned_time: String(item.pinnedTime || '').trim(),
        use_coupon: Number(item.useCoupon || 0),
        finished_order_count: Number(item.rentFinishCount || 0),
        income_amount: String(item.rentFinishAmount || '').trim(),
        raw: item
    };
}

function mapRentOrder(item = {}) {
    const durationSeconds = Number(item.totalTimeLength || 0);
    return {
        order_no: String(item.orderNo || '').trim(),
        order_child_no: String(item.orderChildNo || '').trim(),
        order_id: String(item.orderChildNo || item.orderNo || '').trim(),
        account_id: String(item.accountNo || '').trim(),
        pay_success_time: String(item.paySuccessTime || '').trim(),
        pay_success_at: toUnixDateTime(item.paySuccessTime),
        duration_seconds: Number.isFinite(durationSeconds) ? durationSeconds : 0,
        duration_hours: Number.isFinite(durationSeconds) ? Number((durationSeconds / 3600).toFixed(2)) : 0,
        buy_time_type: Number(item.buyTimeType || 0),
        buy_count: Number(item.buyCount || 0),
        unit_price: String(item.buyUnitPrice || '').trim(),
        rent_count: Number(item.rentCount || 0),
        original_amount: String(item.orderAmount || '').trim(),
        discount_amount: String(item.discountAmount || '').trim(),
        paid_amount: String(item.realAmount || '').trim(),
        channel_divide: Number(item.channelDivide || 0),
        income_amount: String(item.channelRevenue || '').trim(),
        order_status: Number(item.orderStatus),
        is_refund: Number(item.isRefund || 0) === 1,
        is_refund_raw: Number(item.isRefund || 0),
        refund_reason: String(item.refundReason || '').trim(),
        is_operable: Number(item.isOperate || 0) === 1,
        is_operable_raw: Number(item.isOperate || 0),
        rent_expire_time: String(item.rentExpireTime || '').trim(),
        rent_expire_at: toUnixDateTime(item.rentExpireTime),
        order_create_time: String(item.orderCreateTime || '').trim(),
        order_created_at: toUnixDateTime(item.orderCreateTime),
        refund_admin_name: String(item.refundAdminNice || '').trim(),
        cash_status: Number(item.cashStatus),
        is_account_owner: Boolean(item.isAccountOwner),
        prop_template_name: String(item.propTemplateName || '').trim(),
        raw: item
    };
}

async function postJson(path, body = {}, auth = {}, options = {}) {
    const cfg = resolveAuth(auth);
    const fetchImpl = options.fetch_impl || globalThis.fetch;
    if (typeof fetchImpl !== 'function') throw new Error('fetch is not available');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeout_ms);
    let response;
    let responseText = '';
    try {
        response = await fetchImpl(`${cfg.api_base}${path}`, {
            method: 'POST',
            headers: {
                accept: 'application/json, text/plain, */*',
                authorization: `Bearer ${cfg.token}`,
                'content-type': 'application/json',
                origin: cfg.origin,
                referer: cfg.referer,
                'user-agent': cfg.user_agent
            },
            body: JSON.stringify(body),
            signal: controller.signal
        });
        responseText = await response.text();
    } catch (error) {
        if (error && error.name === 'AbortError') {
            throw new FiveEApiError(`5E API timeout after ${cfg.timeout_ms}ms`);
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }

    let json;
    try {
        json = JSON.parse(responseText);
    } catch {
        throw new FiveEApiError(`5E API returned non-JSON: HTTP ${Number(response && response.status || 0)}`, {
            http_status: response && response.status
        });
    }

    const businessCode = json.code === undefined || json.code === null ? json.errcode : json.code;
    const businessOk = json.status !== false
        && json.success !== false
        && Number(businessCode || 0) === 0;
    if (!response.ok || !businessOk) {
        const message = String(json.message || json.msg || `HTTP ${response.status}`).trim();
        throw new FiveEApiError(`5E API request failed: code=${String(businessCode ?? '')}, message=${message}`, {
            http_status: response.status,
            code: businessCode,
            response: json
        });
    }

    return json;
}

async function listRentAccounts(payload = {}, auth = {}, options = {}) {
    const page = normalizePositiveInt(payload.page, 1);
    const size = normalizePositiveInt(payload.size, 25, 200);
    const json = await postJson(ACCOUNT_LIST_PATH, { page, size }, auth, options);
    const data = json.data && typeof json.data === 'object' ? json.data : {};
    const rawList = Array.isArray(data.list) ? data.list : [];
    return {
        page,
        size,
        total: Number(data.total || rawList.length || 0),
        list: rawList.map(mapRentAccount),
        timestamp: Number(json.timestamp || 0),
        trace_id: String(json.traceId || '').trim(),
        raw: json
    };
}

async function listRentOrders(payload = {}, auth = {}, options = {}) {
    const page = normalizePositiveInt(payload.page, 1);
    const pageSize = normalizePositiveInt(payload.page_size || payload.pageSize, 25, 200);
    const accountNo = String(payload.account_no || payload.accountNo || '').trim();
    const { payStartAt, payEndAt } = resolveOrderPayRange(payload);
    const body = { page, pageSize };
    if (accountNo) body.accountNo = accountNo;
    if (payStartAt > 0) {
        body.payStartAt = payStartAt;
        body.payEndAt = payEndAt;
    }
    const json = await postJson(ORDER_LIST_PATH, body, auth, options);
    const data = json.data && typeof json.data === 'object' ? json.data : {};
    const rawItems = Array.isArray(data.items) ? data.items : [];
    return {
        page,
        page_size: pageSize,
        account_id: accountNo,
        pay_start_at: payStartAt,
        pay_end_at: payEndAt,
        total: Number(data.totalSize || rawItems.length || 0),
        next_page_token: String(data.nextPageToken || '').trim(),
        real_total_income: String(data.realTotalIncome || '').trim(),
        frozen_total_amount: String(data.freezeTotalAmount || '').trim(),
        total_channel_revenue: String(data.totalChannelRevenue || '').trim(),
        has_total_channel_revenue: Boolean(data.isGetTotalChannelRevenue),
        list: rawItems.map(mapRentOrder),
        timestamp: Number(json.timestamp || 0),
        trace_id: String(json.traceId || '').trim(),
        raw: json
    };
}

async function updateRentAccountShelf(payload = {}, auth = {}, options = {}) {
    const accountNo = String(payload.account_no || payload.accountNo || '').trim();
    const steam64Id = String(payload.steam_id || payload.steam64_id || payload.steam64Id || '').trim();
    const shelfStatus = Number(payload.shelf_status ?? payload.shelfStatus);
    if (!accountNo) throw new Error('5E accountNo not configured');
    if (!steam64Id) throw new Error('5E steam64Id not configured');
    if (shelfStatus !== 0 && shelfStatus !== 1) {
        throw new Error('5E shelfStatus only supports 0(off shelf) or 1(on shelf)');
    }
    const json = await postJson(ACCOUNT_SHELF_UPDATE_PATH, {
        accountNo,
        shelfStatus,
        steam64Id
    }, auth, options);
    return {
        ok: true,
        account_id: accountNo,
        steam_id: steam64Id,
        shelf_status: shelfStatus,
        timestamp: Number(json.timestamp || 0),
        trace_id: String(json.traceId || '').trim(),
        raw: json
    };
}

async function unshelfRentAccount(payload = {}, auth = {}, options = {}) {
    return updateRentAccountShelf({ ...payload, shelf_status: 0 }, auth, options);
}

async function shelfRentAccount(payload = {}, auth = {}, options = {}) {
    return updateRentAccountShelf({ ...payload, shelf_status: 1 }, auth, options);
}

async function listAllRentOrders(payload = {}, auth = {}, options = {}) {
    const pageSize = normalizePositiveInt(
        payload.page_size || payload.pageSize || options.page_size,
        DEFAULT_PAGE_SIZE,
        200
    );
    const maxPages = normalizePositiveInt(options.max_pages, DEFAULT_MAX_PAGES, 500);
    const accountNo = String(payload.account_no || payload.accountNo || '').trim();
    const { payStartAt, payEndAt } = resolveOrderPayRange(payload);
    const rows = [];
    const seen = new Set();
    let page = normalizePositiveInt(payload.page, 1);
    let pages = 0;
    let total = 0;
    let traceId = '';
    let timestamp = 0;

    while (pages < maxPages) {
        const result = await listRentOrders(
            { page, pageSize, accountNo, payStartAt, payEndAt },
            auth,
            { fetch_impl: options.fetch_impl }
        );
        const list = Array.isArray(result.list) ? result.list : [];
        for (const row of list) {
            const key = String(row.order_id || '').trim();
            if (key && seen.has(key)) continue;
            if (key) seen.add(key);
            rows.push(row);
        }
        pages += 1;
        total = Math.max(total, Number(result.total || 0));
        traceId = String(result.trace_id || traceId);
        timestamp = Number(result.timestamp || timestamp || 0);
        if (list.length < pageSize || (total > 0 && rows.length >= total)) break;
        page += 1;
    }

    if (pages >= maxPages && total > rows.length) {
        throw new FiveEApiError(`5E order list exceeded max_pages=${maxPages}`);
    }
    return {
        account_id: accountNo,
        pay_start_at: payStartAt,
        pay_end_at: payEndAt,
        total: total || rows.length,
        list: rows,
        pages,
        timestamp,
        trace_id: traceId
    };
}

async function listAllRentAccounts(auth = {}, options = {}) {
    const pageSize = normalizePositiveInt(options.page_size, DEFAULT_PAGE_SIZE, 200);
    const maxPages = normalizePositiveInt(options.max_pages, DEFAULT_MAX_PAGES, 500);
    const rows = [];
    let page = 1;
    let total = 0;
    let traceId = '';
    let timestamp = 0;

    while (page <= maxPages) {
        const result = await listRentAccounts(
            { page, size: pageSize },
            auth,
            { fetch_impl: options.fetch_impl }
        );
        const list = Array.isArray(result.list) ? result.list : [];
        rows.push(...list);
        total = Math.max(total, Number(result.total || 0));
        traceId = String(result.trace_id || traceId);
        timestamp = Number(result.timestamp || timestamp || 0);
        if (list.length < pageSize || (total > 0 && rows.length >= total)) break;
        page += 1;
    }

    if (page > maxPages && total > rows.length) {
        throw new FiveEApiError(`5E account list exceeded max_pages=${maxPages}`);
    }
    return {
        total: total || rows.length,
        list: rows,
        pages: Math.min(page, maxPages),
        timestamp,
        trace_id: traceId
    };
}

module.exports = {
    API_BASE,
    ACCOUNT_LIST_PATH,
    ORDER_LIST_PATH,
    ACCOUNT_SHELF_UPDATE_PATH,
    FiveEApiError,
    listRentAccounts,
    listAllRentAccounts,
    listRentOrders,
    listAllRentOrders,
    updateRentAccountShelf,
    unshelfRentAccount,
    shelfRentAccount,
    mapRentAccount,
    mapRentOrder,
    shelfStatusLabel,
    rentStatusLabel
};
