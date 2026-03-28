const path = require('path');
const fs = require('fs');
const { fork } = require('child_process');
const { openDatabase, openStatsDatabase } = require('../database/sqlite_client');
const { listActiveUsers, USER_TYPE_ADMIN, USER_STATUS_ENABLED } = require('../database/user_db');
const { initUserGameAccountDb } = require('../database/user_game_account_db');
const {
    initOrderStatsDailyDb,
    replaceOrderStatsRowsForDay,
    listOrderStatsRows
} = require('../database/order_stats_daily_db');
const {
    initOrderStatsCostDailyDb,
    upsertCostSnapshotForDay,
    listCostSnapshotsByUser
} = require('../database/order_stats_cost_daily_db');
const {
    initOrderStatsWeeklySnapshotDb,
    replaceWeeklySnapshotsFromDate,
    listWeeklySnapshotsByUser
} = require('../database/order_stats_weekly_snapshot_db');
const {
    initOrderStatsJobStateDb,
    getLastRunDate,
    setLastRunDate
} = require('../database/order_stats_job_state_db');
const { resolveDisplayNameByRow } = require('../product/display_name');
const { listAccountCostRecordsByUserAndAccount } = require('../database/account_cost_record_db');
const { canonicalGameId } = require('../common/game_profile');

const STATS_JOB_KEY_ALL_USERS = 'order_stats_daily_all_users';
const DEFAULT_TARGET_HOUR = 2;
const DEFAULT_TARGET_MINUTE = 0;
const DEFAULT_WINDOW_SEC = 300;
const DEFAULT_RECALC_DAYS = 14;
const MAX_NORMAL_RECALC_DAYS = 14;
const MAX_BACKFILL_RECALC_DAYS = 180;
const DEFAULT_GAME_NAME = 'WZRY';
const ALL_GAME_NAME = '全部';

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

function eachDateTextInclusive(startDateText, endDateText) {
    const [sy, sm, sd] = String(startDateText || '').split('-').map((x) => Number(x || 0));
    const [ey, em, ed] = String(endDateText || '').split('-').map((x) => Number(x || 0));
    const s = new Date(sy, (sm || 1) - 1, sd || 1);
    const e = new Date(ey, (em || 1) - 1, ed || 1);
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || s.getTime() > e.getTime()) return [];
    const out = [];
    for (let d = new Date(s); d.getTime() <= e.getTime(); d = addDays(d, 1)) {
        out.push(toDateText(d));
    }
    return out;
}

function startOfDay(d) {
    const out = new Date(d);
    out.setHours(0, 0, 0, 0);
    return out;
}

function getNaturalDayStartByDateText(dateText) {
    const [y, m, d] = String(dateText || '').split('-').map((x) => Number(x || 0));
    const out = new Date(y, (m || 1) - 1, d || 1);
    out.setHours(0, 0, 0, 0);
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
            game_name: String(row.game_name || '').trim(),
            account_remark: roleName,
            role_name: roleName,
            channel_prd_info: channelPrdInfo
        }, gameAccount);
        const purchasePrice = toMoney2(row.purchase_price);
        const purchaseDate = String(row.purchase_date || '').slice(0, 10);
        const totalCostAmount = toMoney2(row.total_cost_amount || 0);
        const ok = purchasePrice > 0 && /^\d{4}-\d{2}-\d{2}$/.test(purchaseDate);
        if (ok) {
            configured.push({
                game_account: gameAccount,
                game_name: String(row.game_name || '').trim(),
                role_name: roleName,
                display_name: displayName,
                purchase_price: purchasePrice,
                purchase_date: purchaseDate,
                total_cost_amount: totalCostAmount
            });
        } else {
            missing.push({
                game_account: gameAccount,
                game_name: String(row.game_name || '').trim(),
                role_name: roleName,
                display_name: displayName,
                purchase_price: purchasePrice,
                purchase_date: purchaseDate,
                total_cost_amount: totalCostAmount
            });
        }
    }
    return { configured, missing };
}

function mergeAccountRowsByGameAccount(rows = []) {
    // “全部”看板按同 QQ 资产合并，故这里有意只按 game_account 归并。
    const out = new Map();
    for (const row of Array.isArray(rows) ? rows : []) {
        const acc = String(row.game_account || '').trim();
        if (!acc) continue;
        const purchasePrice = toMoney2(row.purchase_price || 0);
        const purchaseDate = String(row.purchase_date || '').slice(0, 10);
        const totalCostAmount = toMoney2(row.total_cost_amount || 0);
        const current = out.get(acc);
        if (!current) {
            out.set(acc, {
                ...row,
                game_account: acc,
                purchase_price: purchasePrice,
                purchase_date: purchaseDate,
                total_cost_amount: totalCostAmount
            });
            continue;
        }
        const next = {
            ...current,
            game_account: acc,
            purchase_price: Math.max(toMoney2(current.purchase_price || 0), purchasePrice),
            total_cost_amount: Math.max(toMoney2(current.total_cost_amount || 0), totalCostAmount),
            purchase_date: (() => {
                const oldDate = String(current.purchase_date || '').slice(0, 10);
                if (!/^\d{4}-\d{2}-\d{2}$/.test(oldDate)) return purchaseDate;
                if (!/^\d{4}-\d{2}-\d{2}$/.test(purchaseDate)) return oldDate;
                return oldDate <= purchaseDate ? oldDate : purchaseDate;
            })()
        };
        if (!String(next.display_name || '').trim() && String(row.display_name || '').trim()) next.display_name = row.display_name;
        if (!String(next.role_name || '').trim() && String(row.role_name || '').trim()) next.role_name = row.role_name;
        if (!String(next.game_name || '').trim() && String(row.game_name || '').trim()) next.game_name = row.game_name;
        out.set(acc, next);
    }
    return Array.from(out.values());
}

async function loadAccountConfigByUser(userId, gameName = DEFAULT_GAME_NAME) {
    await initUserGameAccountDb();
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    const g = String(gameName || DEFAULT_GAME_NAME).trim() || DEFAULT_GAME_NAME;
    const db = openDatabase();
    try {
        const rows = g === ALL_GAME_NAME
            ? await all(db, `
                SELECT game_account, game_name, account_remark, channel_prd_info, purchase_price, purchase_date, total_cost_amount
                FROM user_game_account
                WHERE user_id = ?
                  AND is_deleted = 0
                ORDER BY id DESC
            `, [uid])
            : await all(db, `
                SELECT game_account, game_name, account_remark, channel_prd_info, purchase_price, purchase_date, total_cost_amount
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
    const today = startOfDay(now);
    const yesterday = addDays(today, -1);
    const endBase = p === 'today' ? today : yesterday;
    if (p === 'yesterday') {
        return { startDate: toDateText(yesterday), endDate: toDateText(yesterday), period: p };
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

function normalizeStatDateText(dateText = '') {
    const raw = String(dateText || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return '';
    const [y, m, d] = raw.split('-').map((x) => Number(x || 0));
    const dt = new Date(y, (m || 1) - 1, d || 1);
    if (!(dt instanceof Date) || Number.isNaN(dt.getTime())) return '';
    if (toDateText(dt) !== raw) return '';
    return raw;
}

function normalizeStatsRefreshRange(options = {}) {
    const mode = String(options.mode || 'normal').trim().toLowerCase() === 'backfill' ? 'backfill' : 'normal';
    const now = options.now instanceof Date ? options.now : new Date();
    const baseDate = startOfDay(now);
    const rawStartDate = normalizeStatDateText(options.start_date);
    if (mode !== 'backfill' && rawStartDate) {
        throw new Error('常规刷新不支持 start_date');
    }

    let resolvedDays = Number(options.days);
    if (rawStartDate) {
        resolvedDays = dateDiffDaysInclusive(rawStartDate, toDateText(baseDate));
    }
    if (!Number.isFinite(resolvedDays)) resolvedDays = DEFAULT_RECALC_DAYS;

    const maxDays = mode === 'backfill' ? MAX_BACKFILL_RECALC_DAYS : MAX_NORMAL_RECALC_DAYS;
    const days = Math.max(1, Math.min(maxDays, Math.floor(resolvedDays)));
    const startDate = toDateText(addDays(baseDate, -(days - 1)));
    return {
        mode,
        days,
        start_date: startDate,
        end_date: toDateText(baseDate),
        capped: Math.floor(resolvedDays) !== days
    };
}

function compareDateText(a, b) {
    return String(a || '').localeCompare(String(b || ''));
}

function getWeekStartDateText(dateText) {
    const base = getNaturalDayStartByDateText(dateText);
    const weekday = base.getDay() || 7;
    return toDateText(addDays(base, 1 - weekday));
}

function getWeekEndDateText(dateText) {
    const weekStart = getNaturalDayStartByDateText(getWeekStartDateText(dateText));
    return toDateText(addDays(weekStart, 6));
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
        const rowGameName = String(r.game_name || '').trim();
        const cfg = configMap.get(`${rowGameName}::${gameAccount}`) || configMap.get(gameAccount) || {};
        return {
            channel: String(r.channel || '').trim(),
            game_account: gameAccount,
            game_name: rowGameName,
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

    const dayStart = getNaturalDayStartByDateText(day);
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
                COALESCE(game_name, '') AS game_name,
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
              AND game_account IN (${placeholders})
              ${g === ALL_GAME_NAME ? '' : 'AND COALESCE(game_name, \'\') = ?'}
              AND end_time >= ?
              AND end_time < ?
            GROUP BY game_name, game_account
        `, g === ALL_GAME_NAME ? [uid, ...accs, startText, endText] : [uid, ...accs, g, startText, endText]);
    } finally {
        db.close();
    }
}

async function listConfiguredGamesByUser(userId) {
    await initUserGameAccountDb();
    const uid = Number(userId || 0);
    if (!uid) return [];
    const db = openDatabase();
    try {
        const rows = await all(db, `
            SELECT DISTINCT COALESCE(game_name, '') AS game_name
            FROM user_game_account
            WHERE user_id = ?
              AND is_deleted = 0
              AND COALESCE(game_name, '') <> ''
            ORDER BY game_name ASC
        `, [uid]);
        return rows.map((row) => String((row && row.game_name) || '').trim()).filter(Boolean);
    } finally {
        db.close();
    }
}

async function listDailyIncomeRowsForAccountByGame(userId, gameName, endDate) {
    await initOrderStatsDailyDb();
    const uid = Number(userId || 0);
    const g = String(gameName || DEFAULT_GAME_NAME).trim() || DEFAULT_GAME_NAME;
    const end = String(endDate || '').slice(0, 10);
    if (!uid) throw new Error('user_id 不合法');
    if (!end) throw new Error('end_date 不能为空');
    const db = openStatsDatabase();
    try {
        return await all(db, `
            SELECT stat_date, game_account, ROUND(SUM(amount_rec_sum), 2) AS amount_rec_sum
            FROM order_stats_daily
            WHERE user_id = ?
              AND game_name = ?
              AND stat_date <= ?
              AND is_deleted = 0
            GROUP BY stat_date, game_account
            ORDER BY stat_date ASC, game_account ASC
        `, [uid, g, end]);
    } finally {
        db.close();
    }
}

async function refreshWeeklySnapshotsByUserAndGame(userId, gameName, options = {}) {
    await initOrderStatsWeeklySnapshotDb();
    const uid = Number(userId || 0);
    const g = String(gameName || DEFAULT_GAME_NAME).trim() || DEFAULT_GAME_NAME;
    if (!uid) throw new Error('user_id 不合法');
    if (g === ALL_GAME_NAME) throw new Error('周快照刷新不支持 全部 游戏聚合');
    const refreshRange = normalizeStatsRefreshRange(options);
    const rebuildWeekEnd = getWeekEndDateText(refreshRange.start_date);
    const sourceRows = await listDailyIncomeRowsForAccountByGame(uid, g, refreshRange.end_date);
    const cumulativeByAccount = new Map();
    const snapshotRowMap = new Map();
    for (const row of sourceRows) {
        const statDate = String(row.stat_date || '').slice(0, 10);
        const account = String(row.game_account || '').trim();
        if (!statDate || !account) continue;
        const nextTotal = toMoney2(Number(cumulativeByAccount.get(account) || 0) + Number(row.amount_rec_sum || 0));
        cumulativeByAccount.set(account, nextTotal);
        const weekEnd = getWeekEndDateText(statDate);
        if (compareDateText(weekEnd, rebuildWeekEnd) < 0) continue;
        snapshotRowMap.set(`${weekEnd}::${account}`, {
            game_account: account,
            week_start_date: getWeekStartDateText(statDate),
            week_end_date: weekEnd,
            snapshot_date: weekEnd,
            total_rec_amount: nextTotal
        });
    }
    const rows = Array.from(snapshotRowMap.values())
        .sort((a, b) => compareDateText(a.snapshot_date, b.snapshot_date) || String(a.game_account || '').localeCompare(String(b.game_account || '')));
    await replaceWeeklySnapshotsFromDate(uid, g, rebuildWeekEnd, rows, String(options.desc || 'weekly snapshot refresh by stats/order_stats').trim());
    return {
        user_id: uid,
        game_name: g,
        rebuild_from_week_end: rebuildWeekEnd,
        snapshot_count: rows.length
    };
}

async function buildHistoricalTotalMapByUser(userId, gameName, targetDate, configuredRows = []) {
    const uid = Number(userId || 0);
    const target = String(targetDate || '').slice(0, 10);
    const g = String(gameName || DEFAULT_GAME_NAME).trim() || DEFAULT_GAME_NAME;
    if (!uid || !target) return new Map();
    if (g === ALL_GAME_NAME) {
        const byGame = new Map();
        for (const row of Array.isArray(configuredRows) ? configuredRows : []) {
            const rowGame = String(row.game_name || '').trim();
            if (!rowGame) continue;
            const arr = byGame.get(rowGame) || [];
            arr.push(row);
            byGame.set(rowGame, arr);
        }
        const merged = new Map();
        for (const [oneGame, rows] of byGame.entries()) {
            const oneMap = await buildHistoricalTotalMapByUser(uid, oneGame, target, rows);
            for (const [account, amount] of oneMap.entries()) {
                merged.set(account, toMoney2(Number(merged.get(account) || 0) + Number(amount || 0)));
            }
        }
        return merged;
    }

    const accountSet = new Set((configuredRows || []).map((row) => String(row.game_account || '').trim()).filter(Boolean));
    if (accountSet.size === 0) return new Map();

    const snapshotRows = await listWeeklySnapshotsByUser(uid, g, target);
    const latestSnapshotByAccount = new Map();
    for (const row of snapshotRows) {
        const account = String(row.game_account || '').trim();
        if (!accountSet.has(account)) continue;
        if (!latestSnapshotByAccount.has(account)) latestSnapshotByAccount.set(account, row);
    }
    const dailyRows = await listDailyIncomeRowsForAccountByGame(uid, g, target);
    const totalMap = new Map();
    for (const account of accountSet) {
        const base = latestSnapshotByAccount.get(account);
        totalMap.set(account, toMoney2(base ? base.total_rec_amount : 0));
    }
    for (const row of dailyRows) {
        const account = String(row.game_account || '').trim();
        if (!accountSet.has(account)) continue;
        const statDate = String(row.stat_date || '').slice(0, 10);
        const base = latestSnapshotByAccount.get(account);
        const snapshotDate = String(base && base.snapshot_date || '').slice(0, 10);
        if (snapshotDate && compareDateText(statDate, snapshotDate) <= 0) continue;
        totalMap.set(account, toMoney2(Number(totalMap.get(account) || 0) + Number(row.amount_rec_sum || 0)));
    }
    return totalMap;
}

async function refreshOrderStatsDailyByUser(userId, options = {}) {
    await initOrderStatsDailyDb();
    await initOrderStatsCostDailyDb();
    await initOrderStatsWeeklySnapshotDb();
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    const refreshRange = normalizeStatsRefreshRange(options);
    const days = refreshRange.days;
    const gameName = String(options.game_name || DEFAULT_GAME_NAME).trim() || DEFAULT_GAME_NAME;
    if (gameName === ALL_GAME_NAME) {
        const games = await listConfiguredGamesByUser(uid);
        const results = [];
        for (const oneGame of games) {
            results.push(await refreshOrderStatsDailyByUser(uid, {
                ...options,
                game_name: oneGame
            }));
        }
        return {
            user_id: uid,
            game_name: ALL_GAME_NAME,
            days,
            all_games: true,
            games,
            results
        };
    }
    const now = options.now instanceof Date ? options.now : new Date();
    const baseDate = startOfDay(now);
    const desc = String(options.desc || 'daily refresh by stats/order_stats').trim();

    const config = await loadAccountConfigByUser(uid, gameName);
    const configured = Array.isArray(config.configured) ? config.configured : [];
    const configMap = new Map(configured.map((x) => [`${String(x.game_name || '').trim()}::${x.game_account}`, x]));

    const touched = [];
    for (let i = 0; i < days; i += 1) {
        const day = addDays(baseDate, -i);
        const statDate = toDateText(day);
        const rawRows = await queryDailyRowsFromOrder(uid, statDate, gameName, configured);
        const normalized = normalizeDailyRowsFromOrders(rawRows, configMap);
        await replaceOrderStatsRowsForDay(uid, statDate, gameName, normalized, desc);
        touched.push({ stat_date: statDate, rows: normalized.length });
    }
    const todayStatDate = toDateText(baseDate);
    const todayConfigured = configured.filter((x) => String(x.purchase_date || '').slice(0, 10) <= todayStatDate);
    const todayCostBase = toMoney2(todayConfigured.reduce((sum, x) => sum + toMoney2(x.purchase_price || 0), 0));
    await upsertCostSnapshotForDay(uid, todayStatDate, gameName, todayCostBase, todayConfigured.length, desc);
    const weeklySnapshot = await refreshWeeklySnapshotsByUserAndGame(uid, gameName, {
        ...options,
        game_name: gameName,
        desc
    });

    return {
        user_id: uid,
        game_name: gameName,
        days,
        touched,
        weekly_snapshot: weeklySnapshot,
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

async function listOrderStatsRowsByScope(userId, startDate, endDate, gameName) {
    const uid = Number(userId || 0);
    const s = String(startDate || '').slice(0, 10);
    const e = String(endDate || '').slice(0, 10);
    const g = String(gameName || DEFAULT_GAME_NAME).trim() || DEFAULT_GAME_NAME;
    if (g !== ALL_GAME_NAME) return listOrderStatsRows(uid, s, e, g);
    const db = openStatsDatabase();
    try {
        return await all(db, `
            SELECT *
            FROM order_stats_daily
            WHERE user_id = ?
              AND stat_date >= ?
              AND stat_date <= ?
              AND is_deleted = 0
            ORDER BY stat_date DESC, amount_rec_sum DESC, id DESC
        `, [uid, s, e]);
    } finally {
        db.close();
    }
}

async function listCostSnapshotsByScope(userId, startDate, endDate, gameName) {
    await initOrderStatsCostDailyDb();
    const uid = Number(userId || 0);
    const s = String(startDate || '').slice(0, 10);
    const e = String(endDate || '').slice(0, 10);
    const g = String(gameName || DEFAULT_GAME_NAME).trim() || DEFAULT_GAME_NAME;
    if (g !== ALL_GAME_NAME) return listCostSnapshotsByUser(uid, s, e, g);
    const db = openStatsDatabase();
    try {
        return await all(db, `
            SELECT stat_date, ROUND(SUM(cost_base), 2) AS cost_base, SUM(account_count) AS account_count
            FROM order_stats_cost_daily
            WHERE user_id = ?
              AND stat_date >= ?
              AND stat_date <= ?
              AND is_deleted = 0
            GROUP BY stat_date
            ORDER BY stat_date ASC
        `, [uid, s, e]);
    } finally {
        db.close();
    }
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
    await initOrderStatsWeeklySnapshotDb();
    const gameName = String(options.game_name || DEFAULT_GAME_NAME).trim() || DEFAULT_GAME_NAME;
    const now = options.now instanceof Date ? options.now : new Date();
    const pickedDate = normalizeStatDateText(options.stat_date);
    const periodInfo = pickedDate
        ? { startDate: pickedDate, endDate: pickedDate, period: 'day' }
        : buildPeriodRange(options.period, now);
    const rows = await listOrderStatsRowsByScope(uid, periodInfo.startDate, periodInfo.endDate, gameName);
    const config = await loadAccountConfigByUser(uid, gameName);
    const mergedConfigured = gameName === ALL_GAME_NAME ? mergeAccountRowsByGameAccount(config.configured || []) : (config.configured || []);
    const mergedMissing = gameName === ALL_GAME_NAME ? mergeAccountRowsByGameAccount(config.missing || []) : (config.missing || []);
    const latestDisplayNameMap = new Map(
        [...mergedConfigured, ...mergedMissing]
            .map((x) => {
                const acc = String(x.game_account || '').trim();
                const rowGameName = String(x.game_name || '').trim();
                const key = gameName === ALL_GAME_NAME ? `${rowGameName}::${acc}` : acc;
                const normalizedKey = gameName === ALL_GAME_NAME ? acc : key;
                return [normalizedKey, String(x.display_name || x.role_name || '').trim()];
            })
            .filter(([k]) => Boolean(k))
    );
    const historicalTotalMap = await buildHistoricalTotalMapByUser(uid, gameName, periodInfo.endDate, config.configured || []);

    const summary = reduceRows(rows);
    const periodDays = dateDiffDaysInclusive(periodInfo.startDate, periodInfo.endDate);
    const periodDateList = eachDateTextInclusive(periodInfo.startDate, periodInfo.endDate);
    const costRows = await listCostSnapshotsByScope(uid, periodInfo.startDate, periodInfo.endDate, gameName);
    const costMap = new Map((costRows || []).map((x) => [String(x.stat_date || '').slice(0, 10), toMoney2(x.cost_base || 0)]));
    const fallbackCostByDay = (dayText) => {
        const day = String(dayText || '').slice(0, 10);
        const active = mergedConfigured.filter((x) => String(x.purchase_date || '').slice(0, 10) <= day);
        return toMoney2(active.reduce((sum, x) => sum + toMoney2(x.purchase_price || 0), 0));
    };
    const costSeries = periodDateList.map((d) => {
        if (gameName === ALL_GAME_NAME) return fallbackCostByDay(d);
        if (costMap.has(d)) return toMoney2(costMap.get(d));
        return fallbackCostByDay(d);
    });
    const byChannelMap = new Map();
    const byAccountMap = new Map();
    for (const row of rows) {
        const ch = String(row.channel || '').trim();
        const acc = String(row.game_account || '').trim();
        const rowGameName = String(row.game_name || '').trim();
        // 单游戏看板天然已带游戏过滤；“全部”看板这里刻意按账号聚合资产收益。
        const accountKey = acc;
        if (ch) {
            const prev = byChannelMap.get(ch) || [];
            prev.push(row);
            byChannelMap.set(ch, prev);
        }
        if (accountKey) {
            const prev = byAccountMap.get(accountKey) || [];
            prev.push(row);
            byAccountMap.set(accountKey, prev);
        }
    }
    const by_channel = Array.from(byChannelMap.entries()).map(([channel, arr]) => ({
        channel,
        ...reduceRows(arr)
    })).sort((a, b) => b.amount_rec_sum - a.amount_rec_sum);

    const configuredByAccount = new Map(
        mergedConfigured
            .map((x) => {
                const acc = String(x.game_account || '').trim();
                const key = acc;
                return [key, x];
            })
            .filter(([k]) => Boolean(k))
    );
    const by_account = Array.from(configuredByAccount.entries()).map(([accountKey, cfgOne]) => {
        const arr = byAccountMap.get(accountKey) || [];
        const s = reduceRows(arr);
        const roleName = String((arr[0] && arr[0].role_name) || cfgOne.role_name || '').trim();
        const rawAccount = String(cfgOne.game_account || accountKey).trim();
        const displayName = String(latestDisplayNameMap.get(accountKey) || roleName || rawAccount).trim();
        const hitDays = arr.reduce((sum, r) => sum + (Number(r.order_cnt_effective || 0) >= 3 ? 1 : 0), 0);
        const orderBase = Math.max(1, Number(s.order_cnt_effective || 0));
        const accountPurchaseBase = toMoney2(cfgOne.purchase_price || 0);
        const accountPurchaseDate = String(cfgOne.purchase_date || '').slice(0, 10);
        const accountTotalCostAmount = toMoney2(cfgOne.total_cost_amount || 0);
        const accountAnnualizedDays = annualizedDaysByPurchaseDate(periodInfo.startDate, periodInfo.endDate, accountPurchaseDate);
        const accountPeriodReturnRate = accountPurchaseBase > 0 ? (Number(s.amount_rec_sum || 0) / accountPurchaseBase) : 0;
        const accountAnnualizedRate = accountPurchaseBase > 0
            ? (accountPeriodReturnRate * (365 / Math.max(1, accountAnnualizedDays)))
            : 0;
        const totalRecAmountAllTime = toMoney2(historicalTotalMap.get(accountKey) || 0);
        return {
            game_account: rawAccount,
            game_name: String(cfgOne.game_name || (arr[0] && arr[0].game_name) || gameName).trim() || gameName,
            role_name: roleName || rawAccount,
            display_name: displayName,
            total_cost_amount: accountTotalCostAmount,
            purchase_cost_amount: accountPurchaseBase,
            purchase_base: accountPurchaseBase,
            purchase_date: accountPurchaseDate,
            total_rec_amount_all_time: totalRecAmountAllTime,
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
    const purchaseBase = mergedConfigured.reduce((sum, x) => sum + toMoney2(x.purchase_price), 0);
    const costBaseMode = periodInfo.period === 'today' ? 'today_snapshot' : 'period_avg';
    const costBaseValue = costBaseMode === 'today_snapshot'
        ? toMoney2(costSeries[costSeries.length - 1] || 0)
        : toMoney2(costSeries.reduce((sum, x) => sum + Number(x || 0), 0) / Math.max(1, periodDays));
    const periodReturnRate = costBaseValue > 0 ? (summary.amount_rec_sum / costBaseValue) : 0;
    const earliestPurchaseDate = mergedConfigured
        .map((x) => String(x.purchase_date || '').slice(0, 10))
        .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
        .sort()[0] || '';
    const overallAnnualizedDays = annualizedDaysByPurchaseDate(periodInfo.startDate, periodInfo.endDate, earliestPurchaseDate);
    const annualizedRate = costBaseValue > 0 ? (periodReturnRate * (365 / Math.max(1, overallAnnualizedDays))) : 0;

    const orderBase = Math.max(1, summary.order_cnt_total);
    const summaryHitDaysByAccount = by_account.reduce((sum, x) => sum + Number(x.target3_hit_days || 0), 0);
    const configuredCount = Number(mergedConfigured.length || 0);
    const target3RateOverall = configuredCount > 0
        ? Number((summaryHitDaysByAccount / (configuredCount * periodDays)).toFixed(4))
        : 0;
    const totalRecAmountAllTime = toMoney2(by_account.reduce((sum, x) => sum + Number(x.total_rec_amount_all_time || 0), 0));

    return {
        period: periodInfo.period,
        selected_date: pickedDate,
        range: {
            start_date: periodInfo.startDate,
            end_date: periodInfo.endDate
        },
        game_name: gameName,
        summary: {
            ...summary,
            total_rec_amount_all_time: totalRecAmountAllTime,
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
            cost_base_mode: costBaseMode,
            cost_base_value: toMoney2(costBaseValue),
            cost_base_days: periodDays,
            period_days: periodDays,
            period_rec_amount: toMoney2(summary.amount_rec_sum),
            period_return_rate: Number(periodReturnRate.toFixed(6)),
            annualized_return_rate: Number(annualizedRate.toFixed(6))
        },
        by_channel,
        by_account,
        missing_purchase_accounts: mergedMissing,
        configured_account_count: configuredCount
    };
}

function parseMonthText(monthText, now = new Date()) {
    const raw = String(monthText || '').trim();
    if (/^\d{4}-\d{2}$/.test(raw)) return raw;
    const base = startOfDay(now);
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
    const rows = await listOrderStatsRowsByScope(uid, range.startDate, range.endDate, gameName);
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

async function getAccountCostDetailByUser(userId, options = {}) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    const gameAccount = String(options.game_account || '').trim();
    const gameName = String(options.game_name || DEFAULT_GAME_NAME).trim() || DEFAULT_GAME_NAME;
    if (!gameAccount) throw new Error('game_account 不能为空');

    const config = await loadAccountConfigByUser(uid, gameName);
    const mergedConfigured = gameName === ALL_GAME_NAME ? mergeAccountRowsByGameAccount(config.configured || []) : (config.configured || []);
    const cfgOne = (mergedConfigured || []).find((x) => String(x.game_account || '').trim() === gameAccount);
    if (!cfgOne) throw new Error(`找不到账号: ${gameAccount}`);

    const scopedGameId = gameName === ALL_GAME_NAME ? '' : canonicalGameId('', String(cfgOne.game_name || gameName).trim() || gameName);
    const records = await listAccountCostRecordsByUserAndAccount(
        uid,
        scopedGameId,
        gameAccount,
        { limit: 100, all_games: gameName === ALL_GAME_NAME }
    );
    return {
        game_account: String(cfgOne.game_account || gameAccount).trim(),
        game_name: String(cfgOne.game_name || gameName).trim() || gameName,
        display_name: String(cfgOne.display_name || cfgOne.role_name || cfgOne.game_account || gameAccount).trim(),
        total_cost_amount: toMoney2(cfgOne.total_cost_amount || 0),
        purchase_cost_amount: toMoney2(cfgOne.purchase_price || 0),
        list: (records || []).map((x) => ({
            id: Number(x.id || 0),
            cost_amount: toMoney2(x.cost_amount || 0),
            cost_date: String(x.cost_date || '').slice(0, 10),
            cost_type: String(x.cost_type || 'other').trim() || 'other',
            cost_desc: String(x.cost_desc || '').trim()
        }))
    };
}

module.exports = {
    STATS_JOB_KEY_ALL_USERS,
    DEFAULT_RECALC_DAYS,
    MAX_NORMAL_RECALC_DAYS,
    MAX_BACKFILL_RECALC_DAYS,
    normalizeStatsRefreshRange,
    shouldTriggerDailyStatsNow,
    startOrderStatsWorkerIfNeeded,
    refreshOrderStatsDailyByUser,
    refreshOrderStatsDailyForAllUsers,
    getOrderStatsDashboardByUser,
    getAccountCostDetailByUser,
    buildPeriodRange,
    getIncomeCalendarByUser
};
