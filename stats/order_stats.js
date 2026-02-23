const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');
const { openDatabase } = require('../database/sqlite_client');
const { listActiveUsers, USER_TYPE_ADMIN, USER_STATUS_ENABLED } = require('../database/user_db');
const { initUserGameAccountDb } = require('../database/user_game_account_db');
const {
    initOrderStatsDailyDb,
    replaceOrderStatsRowsForDay,
    listOrderStatsRows
} = require('../database/order_stats_daily_db');
const {
    initOrderStatsJobStateDb,
    getLastRunDate,
    setLastRunDate
} = require('../database/order_stats_job_state_db');
const { resolveDisplayNameByRow } = require('../product/display_name');

const STATS_JOB_KEY_ALL_USERS = 'order_stats_daily_all_users';
const DEFAULT_TARGET_HOUR = 2;
const DEFAULT_TARGET_MINUTE = 0;
const DEFAULT_WINDOW_SEC = 300;
const DEFAULT_RECALC_DAYS = 60;
const DEFAULT_GAME_NAME = 'WZRY';

function pad2(n) {
    return String(n).padStart(2, '0');
}

function toDateText(d) {
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function addDays(d, n) {
    const out = new Date(d);
    out.setDate(out.getDate() + n);
    return out;
}

function startOfDay(d) {
    const out = new Date(d);
    out.setHours(0, 0, 0, 0);
    return out;
}

function getBusinessDateByNow(now = new Date()) {
    const day = startOfDay(now);
    if (now.getHours() < 6) return addDays(day, -1);
    return day;
}

function getBusinessDayStartByDateText(dateText) {
    const [y, m, d] = String(dateText || '').split('-').map((x) => Number(x || 0));
    const out = new Date(y, (m || 1) - 1, d || 1);
    out.setHours(6, 0, 0, 0);
    return out;
}

function toDateTimeText(d) {
    return `${toDateText(d)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

function toNumber(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function toMoney2(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return 0;
    return Number(n.toFixed(2));
}

function dateDiffDaysInclusive(startDateText, endDateText) {
    const [sy, sm, sd] = String(startDateText || '').split('-').map((x) => Number(x || 0));
    const [ey, em, ed] = String(endDateText || '').split('-').map((x) => Number(x || 0));
    const s = new Date(sy, (sm || 1) - 1, sd || 1);
    const e = new Date(ey, (em || 1) - 1, ed || 1);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime())) return 1;
    const diff = Math.floor((e.getTime() - s.getTime()) / (24 * 3600 * 1000)) + 1;
    return Math.max(1, diff);
}

function annualizedDaysByPurchaseDate(periodStartDate, currentDate, purchaseDate) {
    const periodStart = String(periodStartDate || '').slice(0, 10);
    const current = String(currentDate || '').slice(0, 10);
    const purchase = String(purchaseDate || '').slice(0, 10);
    const periodDays = dateDiffDaysInclusive(periodStart, current);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(purchase)) return periodDays;
    if (periodStart >= purchase) return periodDays;
    return dateDiffDaysInclusive(purchase, current);
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

function buildAccountConfigStatus(rows = []) {
    const configured = [];
    const missing = [];
    for (const row of rows) {
        const gameAccount = String(row.game_account || '').trim();
        if (!gameAccount) continue;
        const roleName = String(row.account_remark || '').trim();
        let channelPrdInfo = {};
        try {
            const raw = row.channel_prd_info;
            if (raw && typeof raw === 'object') channelPrdInfo = raw;
            else if (typeof raw === 'string' && raw.trim()) channelPrdInfo = JSON.parse(raw);
        } catch {
            channelPrdInfo = {};
        }
        const displayName = resolveDisplayNameByRow({
            game_account: gameAccount,
            account_remark: roleName,
            role_name: roleName,
            channel_prd_info: channelPrdInfo
        }, gameAccount);
        const purchasePrice = toMoney2(row.purchase_price);
        const purchaseDate = String(row.purchase_date || '').slice(0, 10);
        const ok = purchasePrice > 0 && /^\d{4}-\d{2}-\d{2}$/.test(purchaseDate);
        if (ok) {
            configured.push({
                game_account: gameAccount,
                role_name: roleName,
                display_name: displayName,
                purchase_price: purchasePrice,
                purchase_date: purchaseDate
            });
        } else {
            missing.push({
                game_account: gameAccount,
                role_name: roleName,
                display_name: displayName,
                purchase_price: purchasePrice,
                purchase_date: purchaseDate
            });
        }
    }
    return { configured, missing };
}

async function loadAccountConfigByUser(userId, gameName = DEFAULT_GAME_NAME) {
    await initUserGameAccountDb();
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    const g = String(gameName || DEFAULT_GAME_NAME).trim() || DEFAULT_GAME_NAME;
    const db = openDatabase();
    try {
        const rows = await all(db, `
            SELECT game_account, account_remark, channel_prd_info, purchase_price, purchase_date
            FROM user_game_account
            WHERE user_id = ?
              AND is_deleted = 0
              AND COALESCE(game_name, '') = ?
            ORDER BY id DESC
        `, [uid, g]);
        return buildAccountConfigStatus(rows);
    } finally {
        db.close();
    }
}

function buildPeriodRange(period = 'today', now = new Date()) {
    const p = String(period || 'today').trim().toLowerCase();
    const today = getBusinessDateByNow(now);
    const completedEnd = addDays(today, -1);
    const endBase = p === 'today' ? today : completedEnd;
    if (p === 'yesterday') {
        const d = endBase;
        return { startDate: toDateText(d), endDate: toDateText(d), period: p };
    }
    if (p === 'week') {
        const weekday = endBase.getDay() || 7;
        const weekStart = addDays(endBase, 1 - weekday);
        return { startDate: toDateText(weekStart), endDate: toDateText(endBase), period: p };
    }
    if (p === 'last7') {
        return { startDate: toDateText(addDays(endBase, -6)), endDate: toDateText(endBase), period: p };
    }
    if (p === 'month') {
        const start = new Date(endBase.getFullYear(), endBase.getMonth(), 1);
        return { startDate: toDateText(start), endDate: toDateText(endBase), period: p };
    }
    if (p === 'last30') {
        return { startDate: toDateText(addDays(endBase, -29)), endDate: toDateText(endBase), period: p };
    }
    return { startDate: toDateText(today), endDate: toDateText(today), period: 'today' };
}

function reduceRows(rows = []) {
    const out = {
        order_cnt_total: 0,
        order_cnt_effective: 0,
        order_cnt_progress: 0,
        order_cnt_done: 0,
        order_cnt_refund: 0,
        order_cnt_cancel: 0,
        order_cnt_zero_rec: 0,
        rent_hour_sum: 0,
        amount_order_sum: 0,
        amount_rec_sum: 0,
        amount_refund_sum: 0
    };
    for (const row of rows) {
        out.order_cnt_total += toNumber(row.order_cnt_total, 0);
        out.order_cnt_effective += toNumber(row.order_cnt_effective, 0);
        out.order_cnt_progress += toNumber(row.order_cnt_progress, 0);
        out.order_cnt_done += toNumber(row.order_cnt_done, 0);
        out.order_cnt_refund += toNumber(row.order_cnt_refund, 0);
        out.order_cnt_cancel += toNumber(row.order_cnt_cancel, 0);
        out.order_cnt_zero_rec += toNumber(row.order_cnt_zero_rec, 0);
        out.rent_hour_sum += toNumber(row.rent_hour_sum, 0);
        out.amount_order_sum += toNumber(row.amount_order_sum, 0);
        out.amount_rec_sum += toNumber(row.amount_rec_sum, 0);
        out.amount_refund_sum += toNumber(row.amount_refund_sum, 0);
    }
    out.rent_hour_sum = toMoney2(out.rent_hour_sum);
    out.amount_order_sum = toMoney2(out.amount_order_sum);
    out.amount_rec_sum = toMoney2(out.amount_rec_sum);
    out.amount_refund_sum = toMoney2(out.amount_refund_sum);
    return out;
}

function normalizeDailyRowsFromOrders(orderRows = [], configMap = new Map()) {
    return orderRows.map((r) => {
        const gameAccount = String(r.game_account || '').trim();
        const cfg = configMap.get(gameAccount) || {};
        return {
            channel: String(r.channel || '').trim(),
            game_account: gameAccount,
            // 统计展示统一使用商品表中的最新角色名，避免订单历史脏角色名影响展示。
            role_name: String(cfg.role_name || r.role_name || '').trim(),
            purchase_price: toMoney2(cfg.purchase_price),
            purchase_date: String(cfg.purchase_date || '').slice(0, 10),
            order_cnt_total: toNumber(r.order_cnt_total, 0),
            order_cnt_effective: toNumber(r.order_cnt_effective, 0),
            order_cnt_progress: toNumber(r.order_cnt_progress, 0),
            order_cnt_done: toNumber(r.order_cnt_done, 0),
            order_cnt_refund: toNumber(r.order_cnt_refund, 0),
            order_cnt_cancel: toNumber(r.order_cnt_cancel, 0),
            order_cnt_zero_rec: toNumber(r.order_cnt_zero_rec, 0),
            rent_hour_sum: toMoney2(r.rent_hour_sum),
            amount_order_sum: toMoney2(r.amount_order_sum),
            amount_rec_sum: toMoney2(r.amount_rec_sum),
            amount_refund_sum: toMoney2(r.amount_refund_sum)
        };
    });
}

async function queryDailyRowsFromOrder(userId, statDate, gameName, configuredAccounts = []) {
    const uid = Number(userId || 0);
    const g = String(gameName || DEFAULT_GAME_NAME).trim() || DEFAULT_GAME_NAME;
    const day = String(statDate || '').slice(0, 10);
    if (!uid || !day) return [];
    const accs = Array.from(new Set((configuredAccounts || []).map((a) => String(a.game_account || '').trim()).filter(Boolean)));
    if (accs.length === 0) return [];

    const dayStart = getBusinessDayStartByDateText(day);
    const dayEnd = addDays(dayStart, 1);
    const startText = toDateTimeText(dayStart);
    const endText = toDateTimeText(dayEnd);
    const placeholders = accs.map(() => '?').join(',');
    const db = openDatabase();
    try {
        return await all(db, `
            SELECT
                '' AS channel,
                game_account,
                MAX(COALESCE(role_name, '')) AS role_name,
                COUNT(*) AS order_cnt_total,
                SUM(CASE
                    WHEN COALESCE(order_status, '') IN ('租赁中', '出租中')
                      OR (COALESCE(order_status, '') NOT IN ('租赁中', '出租中') AND COALESCE(rec_amount, 0) > 0)
                    THEN 1 ELSE 0 END
                ) AS order_cnt_effective,
                SUM(CASE WHEN COALESCE(order_status, '') IN ('租赁中', '出租中') THEN 1 ELSE 0 END) AS order_cnt_progress,
                SUM(CASE WHEN COALESCE(order_status, '') IN ('已完成', '部分完成', '结算中') THEN 1 ELSE 0 END) AS order_cnt_done,
                SUM(CASE WHEN COALESCE(order_status, '') IN ('退款中', '已退款') THEN 1 ELSE 0 END) AS order_cnt_refund,
                SUM(CASE WHEN COALESCE(order_status, '') IN ('已撤单', '投诉/撤单') THEN 1 ELSE 0 END) AS order_cnt_cancel,
                SUM(CASE WHEN COALESCE(rec_amount, 0) <= 0 THEN 1 ELSE 0 END) AS order_cnt_zero_rec,
                ROUND(SUM(CASE
                    WHEN COALESCE(order_status, '') IN ('租赁中', '出租中')
                      OR (COALESCE(order_status, '') NOT IN ('租赁中', '出租中') AND COALESCE(rec_amount, 0) > 0)
                    THEN COALESCE(rent_hour, 0)
                    ELSE 0 END
                ), 2) AS rent_hour_sum,
                ROUND(SUM(CASE
                    WHEN COALESCE(order_status, '') IN ('租赁中', '出租中')
                      OR (COALESCE(order_status, '') NOT IN ('租赁中', '出租中') AND COALESCE(rec_amount, 0) > 0)
                    THEN COALESCE(order_amount, 0)
                    ELSE 0 END
                ), 2) AS amount_order_sum,
                ROUND(SUM(COALESCE(rec_amount, 0)), 2) AS amount_rec_sum,
                ROUND(SUM(CASE
                    WHEN COALESCE(order_status, '') IN ('退款中', '已退款') THEN COALESCE(order_amount, 0) - COALESCE(rec_amount, 0)
                    ELSE 0 END
                ), 2) AS amount_refund_sum
            FROM "order"
            WHERE user_id = ?
              AND is_deleted = 0
              AND COALESCE(game_name, '') = ?
              AND game_account IN (${placeholders})
              AND end_time >= ?
              AND end_time < ?
            GROUP BY game_account
        `, [uid, g, ...accs, startText, endText]);
    } finally {
        db.close();
    }
}

async function refreshOrderStatsDailyByUser(userId, options = {}) {
    await initOrderStatsDailyDb();
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    const days = Math.max(1, Number(options.days || DEFAULT_RECALC_DAYS));
    const gameName = String(options.game_name || DEFAULT_GAME_NAME).trim() || DEFAULT_GAME_NAME;
    const now = options.now instanceof Date ? options.now : new Date();
    const baseDate = getBusinessDateByNow(now);
    const desc = String(options.desc || 'daily refresh by stats/order_stats').trim();

    const config = await loadAccountConfigByUser(uid, gameName);
    const configured = Array.isArray(config.configured) ? config.configured : [];
    const configMap = new Map(configured.map((x) => [x.game_account, x]));

    const touched = [];
    for (let i = 0; i < days; i += 1) {
        const day = addDays(baseDate, -i);
        const statDate = toDateText(day);
        const rawRows = await queryDailyRowsFromOrder(uid, statDate, gameName, configured);
        const normalized = normalizeDailyRowsFromOrders(rawRows, configMap);
        await replaceOrderStatsRowsForDay(uid, statDate, gameName, normalized, desc);
        touched.push({ stat_date: statDate, rows: normalized.length });
    }

    return {
        user_id: uid,
        game_name: gameName,
        days,
        touched,
        configured_accounts: configured.length,
        missing_accounts: (config.missing || []).length
    };
}

async function refreshOrderStatsDailyForAllUsers(options = {}) {
    await initOrderStatsDailyDb();
    const users = await listActiveUsers();
    const targets = users
        .filter((u) => String(u.user_type || '') !== USER_TYPE_ADMIN)
        .filter((u) => String(u.status || '') === USER_STATUS_ENABLED);
    const out = [];
    for (const user of targets) {
        try {
            const one = await refreshOrderStatsDailyByUser(user.id, options);
            out.push({ user_id: user.id, account: user.account, ok: true, ...one });
        } catch (e) {
            out.push({ user_id: user.id, account: user.account, ok: false, error: String(e.message || e) });
        }
    }
    return {
        total_users: targets.length,
        ok_users: out.filter((x) => x.ok).length,
        failed_users: out.filter((x) => !x.ok).length,
        results: out
    };
}

function shouldTriggerDailyStatsNow(options = {}) {
    const now = options.now instanceof Date ? options.now : new Date();
    const force = Boolean(options.force);
    if (force) return true;
    const targetHour = Number(options.target_hour ?? DEFAULT_TARGET_HOUR);
    const targetMinute = Number(options.target_minute ?? DEFAULT_TARGET_MINUTE);
    const windowSec = Math.max(0, Number(options.window_sec ?? DEFAULT_WINDOW_SEC));

    const target = new Date(now);
    target.setHours(targetHour, targetMinute, 0, 0);
    const diffSec = Math.abs(Math.floor((now.getTime() - target.getTime()) / 1000));
    return diffSec <= windowSec;
}

function currentDateText(now = new Date()) {
    return toDateText(now);
}

function startOrderStatsWorkerIfNeeded(options = {}) {
    const enabled = Boolean(options.enabled);
    const force = Boolean(options.force);
    const targetHour = Number(options.target_hour ?? DEFAULT_TARGET_HOUR);
    const targetMinute = Number(options.target_minute ?? DEFAULT_TARGET_MINUTE);
    const windowSec = Math.max(0, Number(options.window_sec ?? DEFAULT_WINDOW_SEC));
    const taskDir = String(options.task_dir || path.join(__dirname, '..'));
    const runRecord = options.run_record && typeof options.run_record === 'object' ? options.run_record : null;
    const logger = options.logger && typeof options.logger.log === 'function' ? options.logger : console;
    const now = new Date();

    if (!enabled) {
        logger.log('[OrderStats] 统计任务开关关闭，跳过触发');
        return Promise.resolve({ triggered: false, reason: 'disabled', pid: 0 });
    }

    const inWindow = shouldTriggerDailyStatsNow({
        now,
        target_hour: targetHour,
        target_minute: targetMinute,
        window_sec: windowSec,
        force
    });
    if (!inWindow) {
        logger.log('[OrderStats] 未命中 2:00±窗口，跳过触发');
        return Promise.resolve({ triggered: false, reason: 'out_of_window', pid: 0 });
    }

    return (async () => {
        await initOrderStatsJobStateDb();
        const today = currentDateText(now);
        const lastRunDate = await getLastRunDate(STATS_JOB_KEY_ALL_USERS);
        if (!force && lastRunDate === today) {
            logger.log(`[OrderStats] 今日已执行(${lastRunDate})，跳过触发`);
            return { triggered: false, reason: 'already_run_today', pid: 0 };
        }

        const workerScript = path.join(taskDir, 'stats', 'order_stats_worker.js');
        if (!fs.existsSync(workerScript)) {
            logger.warn(`[OrderStats] worker 不存在: ${workerScript}`);
            return { triggered: false, reason: 'worker_missing', pid: 0 };
        }

        const child = fork(workerScript, [], {
            cwd: taskDir,
            env: {
                ...process.env,
                ORDER_STATS_DAILY_FORCE: force ? '1' : '0'
            },
            detached: true,
            stdio: 'ignore'
        });
        child.unref();

        logger.log(`[OrderStats] 已触发统计 worker pid=${child.pid} target=${targetHour}:${String(targetMinute).padStart(2, '0')} window=${windowSec}s`);
        if (runRecord && Array.isArray(runRecord.actions)) {
            runRecord.actions.push({
                type: 'order_stats_daily_worker',
                item: { pid: child.pid, target_hour: targetHour, target_minute: targetMinute, window_sec: windowSec },
                reason: 'trigger daily stats worker',
                time: Date.now(),
                success: true
            });
        }
        return { triggered: true, reason: 'spawned', pid: child.pid };
    })();
}

async function getOrderStatsDashboardByUser(userId, options = {}) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    await initOrderStatsDailyDb();
    const gameName = String(options.game_name || DEFAULT_GAME_NAME).trim() || DEFAULT_GAME_NAME;
    const now = options.now instanceof Date ? options.now : new Date();
    const periodInfo = buildPeriodRange(options.period, now);
    const rows = await listOrderStatsRows(uid, periodInfo.startDate, periodInfo.endDate, gameName);
    const config = await loadAccountConfigByUser(uid, gameName);
    const latestDisplayNameMap = new Map(
        [...(config.configured || []), ...(config.missing || [])]
            .map((x) => [String(x.game_account || '').trim(), String(x.display_name || x.role_name || '').trim()])
            .filter(([k]) => Boolean(k))
    );

    const summary = reduceRows(rows);
    const periodDays = dateDiffDaysInclusive(periodInfo.startDate, periodInfo.endDate);
    const currentBizDate = toDateText(getBusinessDateByNow(now));
    const byChannelMap = new Map();
    const byAccountMap = new Map();
    for (const row of rows) {
        const ch = String(row.channel || '').trim();
        const acc = String(row.game_account || '').trim();
        if (ch) {
            const prev = byChannelMap.get(ch) || [];
            prev.push(row);
            byChannelMap.set(ch, prev);
        }
        if (acc) {
            const prev = byAccountMap.get(acc) || [];
            prev.push(row);
            byAccountMap.set(acc, prev);
        }
    }
    const by_channel = Array.from(byChannelMap.entries()).map(([channel, arr]) => ({
        channel,
        ...reduceRows(arr)
    })).sort((a, b) => b.amount_rec_sum - a.amount_rec_sum);

    const by_account = Array.from(byAccountMap.entries()).map(([game_account, arr]) => {
        const s = reduceRows(arr);
        const roleName = String((arr[0] && arr[0].role_name) || '').trim();
        const displayName = String(latestDisplayNameMap.get(game_account) || roleName || game_account).trim();
        const hitDays = arr.reduce((sum, r) => sum + (Number(r.order_cnt_effective || 0) >= 3 ? 1 : 0), 0);
        const orderBase = Math.max(1, Number(s.order_cnt_effective || 0));
        const cfgOne = (config.configured || [])
            .find((x) => String(x.game_account || '').trim() === game_account) || {};
        const accountPurchaseBase = toMoney2(cfgOne.purchase_price || 0);
        const accountPurchaseDate = String(cfgOne.purchase_date || '').slice(0, 10);
        const accountAnnualizedDays = annualizedDaysByPurchaseDate(periodInfo.startDate, currentBizDate, accountPurchaseDate);
        const accountPeriodReturnRate = accountPurchaseBase > 0 ? (Number(s.amount_rec_sum || 0) / accountPurchaseBase) : 0;
        const accountAnnualizedRate = accountPurchaseBase > 0
            ? (accountPeriodReturnRate * (365 / Math.max(1, accountAnnualizedDays)))
            : 0;
        return {
            game_account,
            role_name: roleName || game_account,
            display_name: displayName,
            purchase_base: accountPurchaseBase,
            avg_daily_order_cnt: Number((Number(s.order_cnt_effective || 0) / periodDays).toFixed(4)),
            avg_daily_rent_hour: Number((Number(s.rent_hour_sum || 0) / periodDays).toFixed(4)),
            avg_order_price: Number((Number(s.amount_order_sum || 0) / orderBase).toFixed(4)),
            avg_daily_rec: Number((Number(s.amount_rec_sum || 0) / periodDays).toFixed(4)),
            target3_hit_days: hitDays,
            target3_rate: Number((hitDays / periodDays).toFixed(4)),
            period_return_rate: Number(accountPeriodReturnRate.toFixed(6)),
            annualized_return_rate: Number(accountAnnualizedRate.toFixed(6)),
            ...s
        };
    }).sort((a, b) => b.amount_rec_sum - a.amount_rec_sum);

    // 年化收益率统一采用单利口径：
    // 年化 = 区间收益率 * (365 / 区间天数)
    const purchaseBase = (config.configured || []).reduce((sum, x) => sum + toMoney2(x.purchase_price), 0);
    const periodReturnRate = purchaseBase > 0 ? (summary.amount_rec_sum / purchaseBase) : 0;
    const earliestPurchaseDate = (config.configured || [])
        .map((x) => String(x.purchase_date || '').slice(0, 10))
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort()[0] || '';
    const overallAnnualizedDays = annualizedDaysByPurchaseDate(periodInfo.startDate, currentBizDate, earliestPurchaseDate);
    const annualizedRate = purchaseBase > 0 ? (periodReturnRate * (365 / Math.max(1, overallAnnualizedDays))) : 0;

    const orderBase = Math.max(1, summary.order_cnt_total);
    const summaryHitDaysByAccount = by_account.reduce((sum, x) => sum + Number(x.target3_hit_days || 0), 0);
    const configuredCount = Number((config.configured || []).length || 0);
    const target3RateOverall = configuredCount > 0
        ? Number((summaryHitDaysByAccount / (configuredCount * periodDays)).toFixed(4))
        : 0;

    return {
        period: periodInfo.period,
        range: {
            start_date: periodInfo.startDate,
            end_date: periodInfo.endDate
        },
        game_name: gameName,
        summary: {
            ...summary,
            refund_rate: Number((summary.order_cnt_refund / orderBase).toFixed(4)),
            cancel_rate: Number((summary.order_cnt_cancel / orderBase).toFixed(4)),
            avg_daily_order_cnt: Number((Number(summary.order_cnt_effective || 0) / periodDays).toFixed(4)),
            avg_daily_rent_hour: Number((Number(summary.rent_hour_sum || 0) / periodDays).toFixed(4)),
            avg_order_price: Number((Number(summary.amount_order_sum || 0) / Math.max(1, Number(summary.order_cnt_effective || 0))).toFixed(4)),
            avg_daily_rec: Number((Number(summary.amount_rec_sum || 0) / periodDays).toFixed(4)),
            target3_rate: target3RateOverall
        },
        profitability: {
            purchase_base: toMoney2(purchaseBase),
            period_days: periodDays,
            period_rec_amount: toMoney2(summary.amount_rec_sum),
            period_return_rate: Number(periodReturnRate.toFixed(6)),
            annualized_return_rate: Number(annualizedRate.toFixed(6))
        },
        by_channel,
        by_account,
        missing_purchase_accounts: config.missing || [],
        configured_account_count: configuredCount
    };
}

function parseMonthText(monthText, now = new Date()) {
    const raw = String(monthText || '').trim();
    if (/^\d{4}-\d{2}$/.test(raw)) return raw;
    const base = getBusinessDateByNow(now);
    return `${base.getFullYear()}-${pad2(base.getMonth() + 1)}`;
}

function monthStartEnd(monthText) {
    const [y, m] = String(monthText).split('-').map((x) => Number(x || 0));
    const start = new Date(y, (m || 1) - 1, 1);
    const end = new Date(y, (m || 1), 0);
    return {
        startDate: toDateText(start),
        endDate: toDateText(end)
    };
}

async function getIncomeCalendarByUser(userId, options = {}) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    await initOrderStatsDailyDb();
    const gameName = String(options.game_name || DEFAULT_GAME_NAME).trim() || DEFAULT_GAME_NAME;
    const now = options.now instanceof Date ? options.now : new Date();
    const month = parseMonthText(options.month, now);
    const range = monthStartEnd(month);
    const rows = await listOrderStatsRows(uid, range.startDate, range.endDate, gameName);
    const dayMap = new Map();
    for (const r of rows) {
        const day = String(r.stat_date || '').slice(0, 10);
        if (!day) continue;
        dayMap.set(day, toMoney2(Number(dayMap.get(day) || 0) + Number(r.amount_rec_sum || 0)));
    }
    const by_day = Array.from(dayMap.entries())
        .map(([stat_date, amount_rec_sum]) => ({ stat_date, amount_rec_sum: toMoney2(amount_rec_sum) }))
        .sort((a, b) => String(a.stat_date).localeCompare(String(b.stat_date)));
    const total_rec_amount = toMoney2(by_day.reduce((sum, x) => sum + Number(x.amount_rec_sum || 0), 0));
    return {
        month,
        game_name: gameName,
        start_date: range.startDate,
        end_date: range.endDate,
        total_rec_amount,
        by_day
    };
}

module.exports = {
    STATS_JOB_KEY_ALL_USERS,
    shouldTriggerDailyStatsNow,
    startOrderStatsWorkerIfNeeded,
    refreshOrderStatsDailyByUser,
    refreshOrderStatsDailyForAllUsers,
    getOrderStatsDashboardByUser,
    buildPeriodRange,
    getIncomeCalendarByUser
};
