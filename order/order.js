const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const { listUserPlatformAuth } = require('../database/user_platform_auth_db');
const { initOrderDb, upsertOrder, listTodayPaidOrderCountByAccounts } = require('../database/order_db');
const { getLastSyncTimestamp, setLastSyncTimestamp } = require('../database/order_sync_db');
const { getUserRuleByName } = require('../database/user_rule_db');
const {
    listUserBlacklistByUserWithMeta,
    upsertUserBlacklistEntry,
    hardDeleteUserBlacklistEntry
} = require('../database/user_blacklist_db');
const { listAllOrders } = require('../uuzuhao/uuzuhao_api');
const { listAllOrderPages } = require('../uhaozu/uhaozu_api');
const { getOrderListByEncryptedPayload } = require('../zuhaowang/zuhaowang_api');
const { listAllUserGameAccountsByUser } = require('../product/product');
const { listActiveUsers, USER_TYPE_ADMIN, USER_STATUS_ENABLED } = require('../database/user_db');
const { openDatabase } = require('../database/sqlite_client');
const {
    CHANNEL_UUZUHAO,
    UUZUHAO_ORDER_FIELD_MAPPING,
    UHAOZU_ORDER_FIELD_MAPPING,
    ZUHAOWANG_ORDER_FIELD_MAPPING,
    mapUuzuhaoOrderToUserOrder,
    mapUhaozuOrderToOrder,
    mapZuhaowangOrderToOrder
} = require('./order_mapping');

const CHANNEL_UHAOZU = 'uhaozu';
const CHANNEL_ZHW = 'zuhaowang';
const CHANNEL_ZHW_YUANBAO = 'zuhaowang-yuanbao';
const ORDER_3_OFF_SOURCE = 'order_3_off';
const ORDER_3_OFF_THRESHOLD = 3;
const ORDER_OFF_THRESHOLD_RULE_NAME = 'X单下架阈值';
const ORDER_3_OFF_BLOCK_RECOVER_RULE_NAME = '3单下架-不恢复时段';

function normalizeOrderOffThreshold(v, fallback = ORDER_3_OFF_THRESHOLD) {
    const n = Number(v);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(1, Math.min(10, Math.floor(n)));
}

function buildOrderOffReasonByThreshold(threshold) {
    return `${normalizeOrderOffThreshold(threshold)}单下架`;
}

function isOrderOffReason(reasonText) {
    const text = String(reasonText || '').trim();
    return /^\d+单下架$/.test(text);
}

async function getOrderOffThresholdByUser(userId) {
    const uid = Number(userId || 0);
    if (!uid) return ORDER_3_OFF_THRESHOLD;
    const rule = await getUserRuleByName(uid, ORDER_OFF_THRESHOLD_RULE_NAME);
    if (!rule || !rule.rule_detail || typeof rule.rule_detail !== 'object') {
        return ORDER_3_OFF_THRESHOLD;
    }
    const detail = rule.rule_detail;
    const raw = detail.threshold ?? detail.order_off_threshold ?? detail.value;
    return normalizeOrderOffThreshold(raw, ORDER_3_OFF_THRESHOLD);
}

function summarizeOrderRange(orderList = [], fields = {}) {
    const startKey = String(fields.start || '');
    const endKey = String(fields.end || '');
    if (!Array.isArray(orderList) || orderList.length === 0 || !startKey || !endKey) {
        return { min_start: '', max_end: '' };
    }
    let minStart = Number.MAX_SAFE_INTEGER;
    let maxEnd = 0;
    for (const row of orderList) {
        const s = Number(row && row[startKey]);
        const e = Number(row && row[endKey]);
        if (Number.isFinite(s) && s > 0 && s < minStart) minStart = s;
        if (Number.isFinite(e) && e > 0 && e > maxEnd) maxEnd = e;
    }
    return {
        min_start: minStart === Number.MAX_SAFE_INTEGER ? '' : new Date(minStart > 1e12 ? minStart : minStart * 1000).toISOString(),
        max_end: maxEnd > 0 ? new Date(maxEnd > 1e12 ? maxEnd : maxEnd * 1000).toISOString() : ''
    };
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

function pad2(n) {
    return String(n).padStart(2, '0');
}

function toDateText(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function toDateTimeText(d) {
    return `${toDateText(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function startOfDay(d) {
    const out = new Date(d);
    out.setHours(0, 0, 0, 0);
    return out;
}

function addDays(d, n) {
    const out = new Date(d);
    out.setDate(out.getDate() + n);
    return out;
}

function resolveDateRangeByQuickFilter(filter = 'today', now = new Date()) {
    const day0 = startOfDay(now);
    const businessDate = now.getHours() < 6 ? addDays(day0, -1) : day0;
    const businessDayStart = new Date(businessDate);
    businessDayStart.setHours(6, 0, 0, 0);
    const businessDayEnd = addDays(businessDayStart, 1);
    const f = String(filter || 'today').trim().toLowerCase();
    if (f === 'yesterday') {
        return { start: addDays(businessDayStart, -1), end: businessDayStart };
    }
    if (f === 'week') {
        const weekday = businessDate.getDay() || 7;
        const weekStart = addDays(businessDate, 1 - weekday);
        weekStart.setHours(6, 0, 0, 0);
        return { start: weekStart, end: businessDayEnd };
    }
    if (f === 'last7') {
        return { start: addDays(businessDayStart, -6), end: businessDayEnd };
    }
    if (f === 'month') {
        const start = new Date(businessDate.getFullYear(), businessDate.getMonth(), 1);
        start.setHours(6, 0, 0, 0);
        return { start, end: businessDayEnd };
    }
    if (f === 'last30') {
        return { start: addDays(businessDayStart, -29), end: businessDayEnd };
    }
    return { start: businessDayStart, end: businessDayEnd };
}

function normalizeOrderListOptions(options = {}) {
    const page = Math.max(1, Number(options.page || 1));
    const pageSize = Math.min(100, Math.max(1, Number(options.page_size || options.pageSize || 20)));
    const quickFilter = String(options.quick_filter || options.quickFilter || 'today').trim().toLowerCase();
    const statusFilterRaw = String(options.status_filter || options.statusFilter || 'all').trim().toLowerCase();
    const statusFilter = (statusFilterRaw === 'progress' || statusFilterRaw === 'done' || statusFilterRaw === 'all')
        ? statusFilterRaw
        : 'all';
    const gameName = String(options.game_name || options.gameName || 'WZRY').trim() || 'WZRY';
    return { page, pageSize, quickFilter, statusFilter, gameName };
}

async function listOrdersForUser(userId, options = {}) {
    await initOrderDb();
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    const cfg = normalizeOrderListOptions(options);
    const range = resolveDateRangeByQuickFilter(cfg.quickFilter, new Date());
    const rangeStart = toDateTimeText(range.start);
    const rangeEnd = toDateTimeText(range.end);
    const todayRange = resolveDateRangeByQuickFilter('today', new Date());
    const todayStart = toDateTimeText(todayRange.start);
    const todayEnd = toDateTimeText(todayRange.end);

    const where = [
        'user_id = ?',
        'is_deleted = 0',
        "COALESCE(game_name, '') = ?",
        'end_time >= ?',
        'end_time < ?'
    ];
    const params = [uid, cfg.gameName, rangeStart, rangeEnd];

    if (cfg.statusFilter === 'progress') {
        where.push("COALESCE(order_status, '') IN ('租赁中', '出租中')");
    } else if (cfg.statusFilter === 'done') {
        where.push("COALESCE(order_status, '') NOT IN ('租赁中', '出租中')");
    }

    const whereSql = where.join(' AND ');
    const db = openDatabase();
    try {
        const totalRow = await dbGet(db, `
            SELECT COUNT(*) AS total
            FROM "order"
            WHERE ${whereSql}
        `, params);
        const countsRow = await dbGet(db, `
            SELECT
              SUM(CASE WHEN COALESCE(order_status, '') IN ('租赁中', '出租中') THEN 1 ELSE 0 END) AS progress_cnt,
              SUM(CASE WHEN COALESCE(order_status, '') NOT IN ('租赁中', '出租中') THEN 1 ELSE 0 END) AS done_cnt
            FROM "order"
            WHERE user_id = ?
              AND is_deleted = 0
              AND COALESCE(game_name, '') = ?
              AND end_time >= ?
              AND end_time < ?
        `, [uid, cfg.gameName, rangeStart, rangeEnd]);
        const todayRow = await dbGet(db, `
            SELECT COUNT(*) AS today_total
            FROM "order"
            WHERE user_id = ?
              AND is_deleted = 0
              AND COALESCE(game_name, '') = ?
              AND end_time >= ?
              AND end_time < ?
        `, [uid, cfg.gameName, todayStart, todayEnd]);
        const offset = (cfg.page - 1) * cfg.pageSize;
        const list = await dbAll(db, `
            SELECT
              channel, order_no, game_id, game_name, game_account, role_name,
              order_status, order_amount, rent_hour, ren_way, rec_amount,
              start_time, end_time, create_date, modify_date
            FROM "order"
            WHERE ${whereSql}
            ORDER BY end_time DESC, id DESC
            LIMIT ? OFFSET ?
        `, [...params, cfg.pageSize, offset]);
        return {
            page: cfg.page,
            page_size: cfg.pageSize,
            total: Number((totalRow && totalRow.total) || 0),
            quick_filter: cfg.quickFilter,
            status_filter: cfg.statusFilter,
            game_name: cfg.gameName,
            range: {
                start: rangeStart,
                end: rangeEnd
            },
            stats: {
                progress: Number((countsRow && countsRow.progress_cnt) || 0),
                done: Number((countsRow && countsRow.done_cnt) || 0),
                today_total: Number((todayRow && todayRow.today_total) || 0)
            },
            list
        };
    } finally {
        db.close();
    }
}

function shouldTriggerOrderSyncNow(options = {}) {
    const now = options.now instanceof Date ? options.now : new Date();
    const intervalMin = Math.max(1, Number(options.interval_min || 30));
    const windowSec = Math.max(0, Number(options.window_sec || 90));
    const force = Boolean(options.force);
    if (force) return true;

    const totalSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    const intervalSec = intervalMin * 60;
    const offset = totalSec % intervalSec;
    return offset <= windowSec || (intervalSec - offset) <= windowSec;
}

function startOrderSyncWorkerIfNeeded(options = {}) {
    const enabled = Boolean(options.enabled);
    const force = Boolean(options.force);
    const intervalMin = Math.max(1, Number(options.interval_min || 30));
    const windowSec = Math.max(0, Number(options.window_sec || 90));
    const taskDir = String(options.task_dir || path.join(__dirname, '..'));
    const runRecord = options.run_record && typeof options.run_record === 'object' ? options.run_record : null;
    const logger = options.logger && typeof options.logger.log === 'function' ? options.logger : console;
    const now = new Date();
    const totalSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
    const intervalSec = intervalMin * 60;
    const offset = totalSec % intervalSec;
    const toNext = intervalSec - offset;
    logger.log(`[OrderSync] window_check now=${now.toISOString()} totalSec=${totalSec} intervalSec=${intervalSec} offset=${offset} windowSec=${windowSec} nextInSec=${toNext}`);

    if (!enabled) {
        logger.log('[OrderSync] 异步订单同步开关关闭，跳过触发');
        return { triggered: false, reason: 'disabled', pid: 0 };
    }
    if (!shouldTriggerOrderSyncNow({ now: new Date(), interval_min: intervalMin, window_sec: windowSec, force })) {
        logger.log('[OrderSync] 未命中30分钟窗口，跳过触发');
        return { triggered: false, reason: 'out_of_window', pid: 0 };
    }

    const workerScript = path.join(taskDir, 'order', 'order_worker.js');
    if (!fs.existsSync(workerScript)) {
        logger.warn(`[OrderSync] worker 不存在: ${workerScript}`);
        return { triggered: false, reason: 'worker_missing', pid: 0 };
    }

    const child = fork(workerScript, [], {
        cwd: taskDir,
        env: { ...process.env, ORDER_WORKER_TRIGGER_TS: String(Date.now()) },
        detached: true,
        stdio: 'ignore'
    });
    child.unref();
    logger.log(`[OrderSync] 已异步触发订单同步 pid=${child.pid}`);

    if (runRecord) {
        runRecord.actions = Array.isArray(runRecord.actions) ? runRecord.actions : [];
        runRecord.actions.push({
            type: 'order_sync_spawn',
            item: { pid: child.pid },
            reason: `interval=${intervalMin}m window=${windowSec}s`,
            time: Date.now(),
            success: true
        });
    }
    return { triggered: true, reason: 'spawned', pid: Number(child.pid || 0) };
}

function isAuthUsable(row = {}) {
    if (!row || typeof row !== 'object') return false;
    if (String(row.auth_status || '') !== 'valid') return false;
    const exp = String(row.expire_at || '').trim();
    if (!exp) return true;
    const ts = Date.parse(exp);
    if (Number.isNaN(ts)) return true;
    return ts > Date.now();
}

function normalizeOrderPlatform(platform) {
    const p = String(platform || '').trim().toLowerCase();
    if (p === CHANNEL_UUZUHAO) return CHANNEL_UUZUHAO;
    if (p === CHANNEL_UHAOZU) return CHANNEL_UHAOZU;
    if (p === CHANNEL_ZHW || p === CHANNEL_ZHW_YUANBAO) return CHANNEL_ZHW;
    return '';
}

async function listAuthorizedOrderPlatforms(userId) {
    const uid = Number(userId || 0);
    if (!uid) return [];
    const rows = await listUserPlatformAuth(uid, { with_payload: false });
    const out = [];
    for (const row of rows) {
        if (!isAuthUsable(row)) continue;
        const p = normalizeOrderPlatform(row.platform);
        if (!p) continue;
        if (!out.includes(p)) out.push(p);
    }
    return out;
}

function listSuccessfulOrderPlatforms(syncResult = {}) {
    const out = [];
    const p = syncResult && typeof syncResult === 'object' ? syncResult : {};
    if (p.uuzuhao && !p.uuzuhao.error) out.push(CHANNEL_UUZUHAO);
    if (p.uhaozu && !p.uhaozu.error) out.push(CHANNEL_UHAOZU);
    if (p.zuhaowang && !p.zuhaowang.error) out.push(CHANNEL_ZHW);
    return out;
}

async function resolveUuzuhaoAuthByUser(userId) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    const rows = await listUserPlatformAuth(uid, { with_payload: true });
    const hit = rows.find((r) => String(r.platform || '') === CHANNEL_UUZUHAO && isAuthUsable(r));
    if (!hit || !hit.auth_payload || typeof hit.auth_payload !== 'object') {
        throw new Error(`user_id=${uid} 缺少可用 ${CHANNEL_UUZUHAO} 授权`);
    }
    return hit.auth_payload;
}

async function resolveUhaozuAuthByUser(userId) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    const rows = await listUserPlatformAuth(uid, { with_payload: true });
    const hit = rows.find((r) => String(r.platform || '') === CHANNEL_UHAOZU && isAuthUsable(r));
    if (!hit || !hit.auth_payload || typeof hit.auth_payload !== 'object') {
        throw new Error(`user_id=${uid} 缺少可用 ${CHANNEL_UHAOZU} 授权`);
    }
    return hit.auth_payload;
}

async function resolveZuhaowangAuthByUser(userId) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    const rows = await listUserPlatformAuth(uid, { with_payload: true });
    const hit = rows.find((r) => String(r.platform || '') === CHANNEL_ZHW_YUANBAO && isAuthUsable(r));
    if (!hit || !hit.auth_payload || typeof hit.auth_payload !== 'object') {
        throw new Error(`user_id=${uid} 缺少可用 ${CHANNEL_ZHW_YUANBAO} 授权`);
    }
    const payload = hit.auth_payload || {};
    const token = String(payload.token || '').trim();
    return {
        ...payload,
        // 订单链路读取独立平台授权；商品链路仍走 zuhaowang 平台 token_get/token_post。
        token_yuanbao: String(payload.token_yuanbao || token).trim(),
        token_get: String(payload.token_get || token).trim(),
        token_post: String(payload.token_post || token).trim()
    };
}

async function buildUuzuhaoProductIndex(userId) {
    const rows = await listAllUserGameAccountsByUser(userId);
    const index = new Map();
    for (const row of rows) {
        const prdId = String((((row || {}).channel_prd_info || {}).uuzuhao || {}).prd_id || '').trim();
        if (!prdId) continue;
        const gameAccount = String(row.game_account || '').trim();
        const roleName = String(row.account_remark || '').trim();
        if (!index.has(prdId)) {
            index.set(prdId, { game_account: gameAccount, role_name: roleName });
            continue;
        }
        const prev = index.get(prdId) || {};
        // 重复 prd_id 时优先保留信息更完整的一条。
        index.set(prdId, {
            game_account: prev.game_account || gameAccount,
            role_name: prev.role_name || roleName
        });
    }
    return index;
}

async function buildUhaozuProductIndex(userId) {
    const rows = await listAllUserGameAccountsByUser(userId);
    const index = new Map();
    for (const row of rows) {
        const prdId = String((((row || {}).channel_prd_info || {}).uhaozu || {}).prd_id || '').trim();
        if (!prdId) continue;
        const gameAccount = String(row.game_account || '').trim();
        const roleName = String(row.account_remark || '').trim();
        if (!index.has(prdId)) {
            index.set(prdId, { game_account: gameAccount, role_name: roleName });
            continue;
        }
        const prev = index.get(prdId) || {};
        index.set(prdId, {
            game_account: prev.game_account || gameAccount,
            role_name: prev.role_name || roleName
        });
    }
    return index;
}

async function buildZuhaowangAccountIndex(userId) {
    const rows = await listAllUserGameAccountsByUser(userId);
    const index = new Map();
    for (const row of rows) {
        const acc = String(row.game_account || '').trim();
        if (!acc) continue;
        const roleName = String(row.account_remark || '').trim();
        if (!index.has(acc)) index.set(acc, { role_name: roleName });
        else {
            const prev = index.get(acc) || {};
            index.set(acc, { role_name: prev.role_name || roleName });
        }
    }
    return index;
}

function formatDateBySec(sec) {
    const n = Number(sec || 0);
    if (!Number.isFinite(n) || n <= 0) return '';
    const d = new Date(n * 1000);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function getOrder3OffEnabled(user = {}) {
    const sw = user && user.switch && typeof user.switch === 'object' ? user.switch : {};
    if (sw.order_3_off === undefined) return true;
    return Boolean(sw.order_3_off);
}

function parseTimeToMinute(v) {
    const text = String(v || '').trim();
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text);
    if (!m) return -1;
    return Number(m[1]) * 60 + Number(m[2]);
}

function isNowInWindow(beginTime, endTime, now = new Date()) {
    const beginMin = parseTimeToMinute(beginTime);
    const endMin = parseTimeToMinute(endTime);
    if (beginMin < 0 || endMin < 0) return false;
    const nowMin = now.getHours() * 60 + now.getMinutes();
    if (beginMin === endMin) return true;
    if (beginMin < endMin) return nowMin >= beginMin && nowMin < endMin;
    return nowMin >= beginMin || nowMin < endMin;
}

async function loadOrder3OffBlockRecoverRule(userId) {
    const rule = await getUserRuleByName(userId, ORDER_3_OFF_BLOCK_RECOVER_RULE_NAME);
    if (!rule) {
        return {
            exists: false,
            in_window: false,
            begin_time: '',
            end_time: ''
        };
    }
    const detail = rule && rule.rule_detail && typeof rule.rule_detail === 'object' ? rule.rule_detail : {};
    const beginTime = String(detail.begin_time || '').trim();
    const endTime = String(detail.end_time || '').trim();
    const inWindow = isNowInWindow(beginTime, endTime, new Date());
    return {
        exists: true,
        in_window: inWindow,
        begin_time: beginTime,
        end_time: endTime
    };
}

async function reconcileOrder3OffBlacklistByUser(user = {}) {
    const uid = Number(user.id || 0);
    if (!uid) throw new Error('user_id 不合法');

    const order3OffEnabled = getOrder3OffEnabled(user);
    const orderOffThreshold = await getOrderOffThresholdByUser(uid);
    const orderOffReason = buildOrderOffReasonByThreshold(orderOffThreshold);
    const rows = await listAllUserGameAccountsByUser(uid);
    const accountToRemark = new Map();
    for (const row of rows) {
        const acc = String(row.game_account || '').trim();
        if (!acc) continue;
        const remark = String(row.account_remark || '').trim();
        if (!accountToRemark.has(acc)) accountToRemark.set(acc, remark);
        else if (!accountToRemark.get(acc) && remark) accountToRemark.set(acc, remark);
    }
    const allAccounts = Array.from(accountToRemark.keys());
    const todayPaidCounts = allAccounts.length > 0 ? await listTodayPaidOrderCountByAccounts(uid, allAccounts) : {};
    const countDetails = allAccounts
        .map((acc) => ({ game_account: acc, count: Number(todayPaidCounts[acc] || 0) }))
        .sort((a, b) => b.count - a.count || a.game_account.localeCompare(b.game_account));

    const targetSet = new Set();
    if (order3OffEnabled) {
        for (const acc of allAccounts) {
            const c = Number(todayPaidCounts[acc] || 0);
            if (c >= orderOffThreshold) targetSet.add(acc);
        }
    }

    const blockRecoverRule = await loadOrder3OffBlockRecoverRule(uid);
    const current = await listUserBlacklistByUserWithMeta(uid);
    const currentSet = new Set(
        current
            .filter((x) => isOrderOffReason(x.reason))
            .map((x) => String(x.game_account || '').trim())
            .filter(Boolean)
    );

    const toAdd = [];
    const toDelete = [];
    const toDeleteBlocked = [];
    for (const acc of targetSet) {
        if (!currentSet.has(acc)) toAdd.push(acc);
    }
    for (const acc of currentSet) {
        if (targetSet.has(acc)) continue;
        if (blockRecoverRule.in_window) {
            toDeleteBlocked.push(acc);
            continue;
        }
        toDelete.push(acc);
    }

    console.log(`[Order3Off] user_id=${uid} enabled=${order3OffEnabled} total_accounts=${allAccounts.length} threshold=${orderOffThreshold}`);
    console.log(`[Order3Off] count_details=${JSON.stringify(countDetails)}`);
    console.log(`[Order3Off] current=${JSON.stringify(Array.from(currentSet))} target=${JSON.stringify(Array.from(targetSet))}`);
    console.log(`[Order3Off] to_add=${JSON.stringify(toAdd)} to_delete=${JSON.stringify(toDelete)} blocked_delete=${JSON.stringify(toDeleteBlocked)}`);

    let added = 0;
    let deleted = 0;
    for (const acc of toAdd) {
        await upsertUserBlacklistEntry(uid, {
            game_account: acc,
            remark: accountToRemark.get(acc) || '',
            reason: orderOffReason
        }, {
            source: ORDER_3_OFF_SOURCE,
            operator: 'order_worker',
            desc: `auto by ${ORDER_3_OFF_SOURCE}`
        });
        added += 1;
    }
    for (const acc of toDelete) {
        const ok = await hardDeleteUserBlacklistEntry(uid, acc, {
            source: ORDER_3_OFF_SOURCE,
            operator: 'order_worker',
            desc: `auto remove by ${ORDER_3_OFF_SOURCE}`
        });
        if (ok) deleted += 1;
    }

    return {
        enabled: order3OffEnabled,
        count_basis: 'rec_amount_gt_0_or_renting',
        threshold: orderOffThreshold,
        reason: orderOffReason,
        total_accounts: allAccounts.length,
        count_details: countDetails,
        hit_accounts: targetSet.size,
        added,
        deleted,
        delete_blocked: toDeleteBlocked.length,
        recover_block_rule: blockRecoverRule,
        target_accounts: Array.from(targetSet)
    };
}

// 拉取 uuzuhao 订单并入库：
// - game_account / role_name 通过 productId 关联 user_game_account 获取
// - 订单接口参数支持 orderStatus/updateStartTime/updateEndTime/page/pageSize
async function syncUuzuhaoOrdersToDb(userId, options = {}) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');

    const auth = await resolveUuzuhaoAuthByUser(uid);
    const nowSec = Math.floor(Date.now() / 1000);
    const lastSyncTs = await getLastSyncTimestamp(uid, CHANNEL_UUZUHAO);
    const overlapSec = 3 * 3600;
    // 默认策略：用上次拉取时间向前回退3小时，保证冗余覆盖；首次无游标时兜底最近30天。
    const startSec = lastSyncTs > 0
        ? Math.max(0, lastSyncTs - overlapSec)
        : (nowSec - 30 * 24 * 3600);
    const endSec = nowSec;

    const query = {
        orderStatus: options.orderStatus ?? 0,
        updateStartTime: Number(options.updateStartTime || startSec),
        updateEndTime: Number(options.updateEndTime || endSec),
        page: options.page,
        pageSize: options.pageSize
    };
    console.log(`[OrderSync][uuzuhao] user_id=${uid} begin window=${JSON.stringify({
        updateStartTime: query.updateStartTime,
        updateEndTime: query.updateEndTime,
        updateStartTimeText: new Date(query.updateStartTime * 1000).toISOString(),
        updateEndTimeText: new Date(query.updateEndTime * 1000).toISOString(),
        last_sync_ts: lastSyncTs
    })}`);
    const productIndex = await buildUuzuhaoProductIndex(uid);

    const pulled = await listAllOrders(query, { auth, maxPages: options.maxPages });
    const orderList = Array.isArray(pulled.order_list) ? pulled.order_list : [];
    const range = summarizeOrderRange(orderList, { start: 'rentStartTime', end: 'rentEndTime' });
    console.log(`[OrderSync][uuzuhao] user_id=${uid} pulled=${orderList.length} total_count=${Number(pulled.total_count || 0)} page_start=${pulled.page_start || 1} page_size=${pulled.page_size || 0} order_range=${JSON.stringify(range)}`);

    await initOrderDb();
    let upserted = 0;
    let linked = 0;
    let unlinked = 0;
    for (const raw of orderList) {
        const productId = String(raw.productId || '').trim();
        const ref = productIndex.get(productId) || { game_account: '', role_name: '' };
        const mapped = mapUuzuhaoOrderToUserOrder(raw, ref);
        if (!mapped.order_no) continue;
        if (ref.game_account || ref.role_name) linked += 1;
        else unlinked += 1;
        await upsertOrder({
            user_id: uid,
            ...mapped,
            desc: String(options.desc || 'sync by order/uuzuhao')
        });
        upserted += 1;
    }
    await setLastSyncTimestamp(uid, CHANNEL_UUZUHAO, nowSec, 'order sync watermark');
    console.log(`[OrderSync][uuzuhao] user_id=${uid} upserted=${upserted} linked=${linked} unlinked=${unlinked} set_last_sync_ts=${nowSec}`);

    return {
        user_id: uid,
        channel: CHANNEL_UUZUHAO,
        window: {
            updateStartTime: query.updateStartTime,
            updateEndTime: query.updateEndTime,
            last_sync_ts: lastSyncTs,
            current_sync_ts: nowSec
        },
        pulled: orderList.length,
        total_count: Number(pulled.total_count || 0),
        upserted,
        linked,
        unlinked,
        mapping: UUZUHAO_ORDER_FIELD_MAPPING
    };
}

// 拉取 uhaozu 订单并入库：
// - game_account / role_name 通过 goodsId 关联 user_game_account 获取
// - 时间窗口按游标回退 2 天，接口参数用 startDate/endDate（日期）
async function syncUhaozuOrdersToDb(userId, options = {}) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');

    const auth = await resolveUhaozuAuthByUser(uid);
    const nowSec = Math.floor(Date.now() / 1000);
    const lastSyncTs = await getLastSyncTimestamp(uid, CHANNEL_UHAOZU);
    const overlapSec = 2 * 24 * 3600;
    const startSec = lastSyncTs > 0
        ? Math.max(0, lastSyncTs - overlapSec)
        : (nowSec - 30 * 24 * 3600);
    const endSec = nowSec;
    // uhaozu 订单接口仅支持按“日期”查询；为避免跨日状态变更漏拉，这里按 2 天回退窗口。
    const startDateSec = startSec;

    const query = {
        pageNum: Number(options.pageNum || 1),
        pageSize: Number(options.pageSize || 30),
        startDate: String(options.startDate || formatDateBySec(startDateSec)),
        endDate: String(options.endDate || formatDateBySec(endSec)),
        timeType: Number(options.timeType || 1),
        unionType: options.unionType ?? '',
        dealComplain: Number(options.dealComplain || 0),
        status: options.status ?? '',
        complainStatus: options.complainStatus ?? '',
        createrNames: Array.isArray(options.createrNames) ? options.createrNames : [],
        __path: options.order_path || ''
    };
    console.log(`[OrderSync][uhaozu] user_id=${uid} begin window=${JSON.stringify({
        startSec,
        endSec,
        startDateSec,
        startDate: query.startDate,
        endDate: query.endDate,
        timeType: query.timeType,
        pageNum: query.pageNum,
        pageSize: query.pageSize,
        order_path: query.__path || '/merchants/order/submit/orderList',
        last_sync_ts: lastSyncTs
    })}`);
    const productIndex = await buildUhaozuProductIndex(uid);

    const pulled = await listAllOrderPages(query.pageSize, query, auth);
    const orderList = Array.isArray(pulled.order_list) ? pulled.order_list : [];
    const range = summarizeOrderRange(orderList, { start: 'startTime', end: 'endTime' });
    console.log(`[OrderSync][uhaozu] user_id=${uid} pulled=${orderList.length} total_count=${Number(pulled.total_count || 0)} pages=${Number(pulled.pages || 0)} order_range=${JSON.stringify(range)}`);

    await initOrderDb();
    let upserted = 0;
    let linked = 0;
    let unlinked = 0;
    for (const raw of orderList) {
        const goodsId = String(raw.goodsId || '').trim();
        const ref = productIndex.get(goodsId) || { game_account: '', role_name: '' };
        const mapped = mapUhaozuOrderToOrder(raw, ref);
        if (!mapped.order_no) continue;
        if (ref.game_account || ref.role_name) linked += 1;
        else unlinked += 1;
        await upsertOrder({
            user_id: uid,
            ...mapped,
            desc: String(options.desc || 'sync by order/uhaozu')
        });
        upserted += 1;
    }
    await setLastSyncTimestamp(uid, CHANNEL_UHAOZU, nowSec, 'order sync watermark');
    console.log(`[OrderSync][uhaozu] user_id=${uid} upserted=${upserted} linked=${linked} unlinked=${unlinked} set_last_sync_ts=${nowSec}`);

    return {
        user_id: uid,
        channel: CHANNEL_UHAOZU,
        window: {
            startDate: query.startDate,
            endDate: query.endDate,
            last_sync_ts: lastSyncTs,
            current_sync_ts: nowSec
        },
        pulled: orderList.length,
        total_count: Number(pulled.total_count || 0),
        upserted,
        linked,
        unlinked,
        mapping: UHAOZU_ORDER_FIELD_MAPPING
    };
}

async function listZuhaowangOrdersByPayloads(auth, options = {}) {
    const tokenType = options.token_type || '';
    if (Array.isArray(options.page_payloads) && options.page_payloads.length > 0) {
        const all = [];
        for (const p of options.page_payloads) {
            const res = await getOrderListByEncryptedPayload(p || {}, auth, { token_type: tokenType });
            const list = Array.isArray(res.order_list) ? res.order_list : [];
            if (list.length === 0) break;
            all.push(...list);
        }
        return { order_list: all, total_count: all.length };
    }
    if (options.request_payload && typeof options.request_payload === 'object' && options.auto_paginate === true) {
        const all = [];
        const pageSize = Number(options.request_payload.pageSize || 15);
        const maxPages = Math.max(1, Number(options.maxPages || 50));
        let pageNum = Number(options.request_payload.pageNum ?? 0);
        for (let i = 0; i < maxPages; i += 1) {
            const req = {
                ...options.request_payload,
                pageNum
            };
            const res = await getOrderListByEncryptedPayload(req, auth, { token_type: tokenType });
            const list = Array.isArray(res.order_list) ? res.order_list : [];
            if (list.length === 0) break;
            all.push(...list);
            if (list.length < pageSize) break;
            pageNum += 1;
        }
        return { order_list: all, total_count: all.length };
    }
    if (options.request_payload && typeof options.request_payload === 'object') {
        return getOrderListByEncryptedPayload(options.request_payload, auth, { token_type: tokenType });
    }
    throw new Error('zuhaowang 订单同步需要提供 request_payload 或 page_payloads（含 ak/data）');
}

// 拉取 zuhaowang 订单并入库：
// - 当前使用密文透传模式（ak/data），调用方需提供每页 payload
// - game_account 优先用订单 accountNo，role_name 优先关联 user_game_account.account_remark
async function syncZuhaowangOrdersToDb(userId, options = {}) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    const auth = await resolveZuhaowangAuthByUser(uid);
    const nowSec = Math.floor(Date.now() / 1000);
    const lastSyncTs = await getLastSyncTimestamp(uid, CHANNEL_ZHW);
    const overlapSec = 3 * 3600;
    const startSec = lastSyncTs > 0
        ? Math.max(0, lastSyncTs - overlapSec)
        : (nowSec - 30 * 24 * 3600);
    const endSec = nowSec;

    // 元宝助手订单查询真实参数（Frida 抓包）：
    // {"pageNum":0,"pageSize":15,"queryType":0,"sortType":1,"fromDate":"yyyy-MM-dd","toDate":"yyyy-MM-dd"}
    const requestPayload = options.request_payload && typeof options.request_payload === 'object'
        ? options.request_payload
        : {
            pageNum: Number(options.pageNum ?? 0),
            pageSize: Number(options.pageSize ?? 15),
            queryType: Number(options.queryType ?? 0),
            sortType: Number(options.sortType ?? 1),
            fromDate: String(options.fromDate || formatDateBySec(startSec)),
            toDate: String(options.toDate || formatDateBySec(endSec))
        };
    console.log(`[OrderSync][zuhaowang] user_id=${uid} begin window=${JSON.stringify({
        pageNum: requestPayload.pageNum,
        pageSize: requestPayload.pageSize,
        queryType: requestPayload.queryType,
        sortType: requestPayload.sortType,
        fromDate: requestPayload.fromDate,
        toDate: requestPayload.toDate,
        last_sync_ts: lastSyncTs
    })}`);

    const pulled = await listZuhaowangOrdersByPayloads(auth, {
        ...options,
        request_payload: requestPayload,
        auto_paginate: options.auto_paginate !== false
    });
    const orderList = Array.isArray(pulled.order_list) ? pulled.order_list : [];
    const range = summarizeOrderRange(orderList, { start: 'startTime', end: 'endTime' });
    console.log(`[OrderSync][zuhaowang] user_id=${uid} pulled=${orderList.length} total_count=${Number(pulled.total_count || 0)} order_range=${JSON.stringify(range)}`);
    const accountIndex = await buildZuhaowangAccountIndex(uid);

    await initOrderDb();
    let upserted = 0;
    let linked = 0;
    let unlinked = 0;
    for (const raw of orderList) {
        const acc = String(raw.accountNo || '').trim();
        const ref = accountIndex.get(acc) || { role_name: '' };
        const mapped = mapZuhaowangOrderToOrder(raw, {
            game_account: acc,
            role_name: ref.role_name || String(raw.roleName || raw.remark || '').trim()
        });
        if (!mapped.order_no) continue;
        if (ref.role_name) linked += 1;
        else unlinked += 1;
        await upsertOrder({
            user_id: uid,
            ...mapped,
            desc: String(options.desc || 'sync by order/zuhaowang')
        });
        upserted += 1;
    }
    await setLastSyncTimestamp(uid, CHANNEL_ZHW, nowSec, 'order sync watermark');
    console.log(`[OrderSync][zuhaowang] user_id=${uid} upserted=${upserted} linked=${linked} unlinked=${unlinked} set_last_sync_ts=${nowSec}`);

    return {
        user_id: uid,
        channel: CHANNEL_ZHW,
        window: {
            fromDate: requestPayload.fromDate,
            toDate: requestPayload.toDate,
            last_sync_ts: lastSyncTs,
            current_sync_ts: nowSec
        },
        pulled: orderList.length,
        total_count: Number(pulled.total_count || 0),
        upserted,
        linked,
        unlinked,
        mapping: ZUHAOWANG_ORDER_FIELD_MAPPING
    };
}

async function syncOrdersByUser(userId, options = {}) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    const result = {
        user_id: uid,
        started_at: new Date().toISOString(),
        platforms: {},
        ok: true
    };
    console.log(`[OrderSync] user_id=${uid} begin`);

    try {
        result.platforms.uuzuhao = await syncUuzuhaoOrdersToDb(uid, options.uuzuhao || {});
        console.log(`[OrderSync] user_id=${uid} platform=uuzuhao done ${JSON.stringify({
            pulled: result.platforms.uuzuhao.pulled,
            upserted: result.platforms.uuzuhao.upserted,
            total_count: result.platforms.uuzuhao.total_count
        })}`);
    } catch (e) {
        result.platforms.uuzuhao = { error: String(e.message || e) };
        console.error(`[OrderSync] user_id=${uid} platform=uuzuhao error=${result.platforms.uuzuhao.error}`);
        result.ok = false;
    }

    try {
        result.platforms.uhaozu = await syncUhaozuOrdersToDb(uid, options.uhaozu || {});
        console.log(`[OrderSync] user_id=${uid} platform=uhaozu done ${JSON.stringify({
            pulled: result.platforms.uhaozu.pulled,
            upserted: result.platforms.uhaozu.upserted,
            total_count: result.platforms.uhaozu.total_count
        })}`);
    } catch (e) {
        result.platforms.uhaozu = { error: String(e.message || e) };
        console.error(`[OrderSync] user_id=${uid} platform=uhaozu error=${result.platforms.uhaozu.error}`);
        result.ok = false;
    }

    try {
        result.platforms.zuhaowang = await syncZuhaowangOrdersToDb(uid, options.zuhaowang || {});
        console.log(`[OrderSync] user_id=${uid} platform=zuhaowang done ${JSON.stringify({
            pulled: result.platforms.zuhaowang.pulled,
            upserted: result.platforms.zuhaowang.upserted,
            total_count: result.platforms.zuhaowang.total_count
        })}`);
    } catch (e) {
        result.platforms.zuhaowang = { error: String(e.message || e) };
        console.error(`[OrderSync] user_id=${uid} platform=zuhaowang error=${result.platforms.zuhaowang.error}`);
        result.ok = false;
    }

    const expectedPlatforms = await listAuthorizedOrderPlatforms(uid);
    const successPlatforms = listSuccessfulOrderPlatforms(result.platforms);
    const missingPlatforms = expectedPlatforms.filter((p) => !successPlatforms.includes(p));
    const canReconcileOrder3Off = expectedPlatforms.length > 0 && missingPlatforms.length === 0;
    result.order_3_off_gate = {
        expected: expectedPlatforms,
        success: successPlatforms,
        missing: missingPlatforms,
        can_reconcile: canReconcileOrder3Off
    };

    if (canReconcileOrder3Off) {
        try {
            const currentUser = options.user && Number(options.user.id) === uid
                ? options.user
                : { id: uid, switch: { order_3_off: true } };
            result.order_3_off = await reconcileOrder3OffBlacklistByUser(currentUser);
        } catch (e) {
            result.order_3_off = { error: String(e.message || e) };
            result.ok = false;
        }
    } else {
        result.order_3_off = {
            skipped: true,
            reason: expectedPlatforms.length === 0
                ? 'no_authorized_platform'
                : 'authorized_platform_sync_incomplete',
            missing_platforms: missingPlatforms
        };
    }

    result.finished_at = new Date().toISOString();
    console.log(`[OrderSync] user_id=${uid} end ok=${result.ok} gate=${JSON.stringify(result.order_3_off_gate || {})}`);
    return result;
}

async function syncOrdersForAllUsers(options = {}) {
    const users = await listActiveUsers();
    const targets = users
        .filter((u) => String(u.user_type || '') !== USER_TYPE_ADMIN)
        .filter((u) => String(u.status || '') === USER_STATUS_ENABLED);

    const summary = {
        started_at: new Date().toISOString(),
        total_users: targets.length,
        processed_users: 0,
        ok_users: 0,
        failed_users: 0,
        results: []
    };

    for (const user of targets) {
        console.log(`[OrderSync] all_users begin user_id=${user.id} account=${user.account}`);
        const one = await syncOrdersByUser(user.id, {
            ...options,
            user
        });
        summary.results.push({
            user_id: user.id,
            account: user.account,
            ...one
        });
        summary.processed_users += 1;
        if (one.ok) summary.ok_users += 1;
        else summary.failed_users += 1;
        console.log(`[OrderSync] all_users end user_id=${user.id} ok=${one.ok}`);
    }

    summary.finished_at = new Date().toISOString();
    console.log(`[OrderSync] all_users summary=${JSON.stringify({
        total_users: summary.total_users,
        processed_users: summary.processed_users,
        ok_users: summary.ok_users,
        failed_users: summary.failed_users
    })}`);
    return summary;
}

module.exports = {
    shouldTriggerOrderSyncNow,
    startOrderSyncWorkerIfNeeded,
    reconcileOrder3OffBlacklistByUser,
    syncUuzuhaoOrdersToDb,
    syncUhaozuOrdersToDb,
    syncZuhaowangOrdersToDb,
    syncOrdersByUser,
    syncOrdersForAllUsers,
    listOrdersForUser,
    resolveUuzuhaoAuthByUser,
    resolveUhaozuAuthByUser,
    resolveZuhaowangAuthByUser,
    buildUuzuhaoProductIndex,
    buildUhaozuProductIndex,
    buildZuhaowangAccountIndex,
    UUZUHAO_ORDER_FIELD_MAPPING,
    UHAOZU_ORDER_FIELD_MAPPING,
    ZUHAOWANG_ORDER_FIELD_MAPPING
};
