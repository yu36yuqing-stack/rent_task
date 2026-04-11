const { openOrderDatabase } = require('../../database/sqlite_client');
const {
    initOrderDb,
    listTodayPaidOrderCountByAccounts,
    listRolling24hPaidOrderCountByAccounts,
    listRentingOrderWindowByAccounts: listRentingWindowByAccounts
} = require('../../database/order_db');

const ORDER_COUNT_MODE_NATURAL_DAY = 'natural_day';
const RECENT_ORDER_END_SUPPRESS_SEC = Math.max(60, Number(process.env.ONLINE_ALERT_RECENT_END_SUPPRESS_SEC || 1200));

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

function toDateTimeText(input = new Date()) {
    const d = input instanceof Date ? input : new Date(input);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function normalizeOrderPlatform(platform) {
    const p = String(platform || '').trim().toLowerCase();
    if (p === 'uuzuhao') return 'uuzuhao';
    if (p === 'uhaozu') return 'uhaozu';
    if (p === 'zuhaowang' || p === 'zuhaowang-yuanbao') return 'zuhaowang';
    return '';
}

function normalizeAccountTuples(accounts = []) {
    return Array.from(new Map((Array.isArray(accounts) ? accounts : [])
        .map((x) => {
            if (!x || typeof x !== 'object') return null;
            const gameAccount = String(x.account || x.game_account || '').trim();
            const gameId = String(x.game_id || '1').trim() || '1';
            const gameName = String(x.game_name || 'WZRY').trim() || 'WZRY';
            if (!gameAccount) return null;
            return [`${gameId}::${gameAccount}`, { game_account: gameAccount, game_id: gameId, game_name: gameName }];
        })
        .filter(Boolean)).values());
}

async function initOrderQueryService() {
    await initOrderDb();
}

async function listPaidCountByAccounts(userId, accounts = [], options = {}) {
    const mode = String(options.mode || ORDER_COUNT_MODE_NATURAL_DAY).trim().toLowerCase();
    if (mode === 'rolling_24h') {
        return listRolling24hPaidOrderCountByAccounts(userId, accounts);
    }
    return listTodayPaidOrderCountByAccounts(userId, accounts, options.dateText || options.date_text || '');
}

async function listOrdersForUser(userId, options = {}) {
    const { listOrdersForUser: listForUser } = require('../order');
    return listForUser(userId, options);
}

async function listActiveRentingOrdersByUser(userId) {
    const uid = Number(userId || 0);
    if (!uid) return [];
    await initOrderDb();
    const db = openOrderDatabase();
    try {
        const rows = await dbAll(db, `
            SELECT game_account, game_id, game_name, start_time, end_time, order_no, channel
            FROM "order"
            WHERE user_id = ?
              AND is_deleted = 0
              AND COALESCE(order_status, '') IN ('租赁中', '出租中')
              AND TRIM(COALESCE(game_account, '')) <> ''
        `, [uid]);
        return rows.map((row) => ({
            game_account: String(row.game_account || '').trim(),
            game_id: String(row.game_id || '1').trim() || '1',
            game_name: String(row.game_name || 'WZRY').trim() || 'WZRY',
            start_time: String(row.start_time || '').trim(),
            end_time: String(row.end_time || '').trim(),
            order_no: String(row.order_no || '').trim(),
            channel: String(row.channel || '').trim()
        })).filter((row) => row.game_account);
    } finally {
        db.close();
    }
}

async function getOrderStatusByOrderNo(userId, orderNo, channel = '') {
    const uid = Number(userId || 0);
    const no = String(orderNo || '').trim();
    const ch = normalizeOrderPlatform(channel);
    if (!uid || !no) return '';
    await initOrderDb();
    const db = openOrderDatabase();
    try {
        const row = ch
            ? await dbGet(db, `
                SELECT order_status
                FROM "order"
                WHERE user_id = ?
                  AND is_deleted = 0
                  AND order_no = ?
                  AND channel = ?
                ORDER BY id DESC
                LIMIT 1
            `, [uid, no, ch])
            : await dbGet(db, `
                SELECT order_status
                FROM "order"
                WHERE user_id = ?
                  AND is_deleted = 0
                  AND order_no = ?
                ORDER BY id DESC
                LIMIT 1
            `, [uid, no]);
        return String((row && row.order_status) || '').trim();
    } finally {
        db.close();
    }
}

async function getOrderEndTimeByOrderNo(userId, orderNo, channel = '') {
    const uid = Number(userId || 0);
    const no = String(orderNo || '').trim();
    const ch = normalizeOrderPlatform(channel);
    if (!uid || !no) return '';
    await initOrderDb();
    const db = openOrderDatabase();
    try {
        const row = ch
            ? await dbGet(db, `
                SELECT end_time
                FROM "order"
                WHERE user_id = ?
                  AND is_deleted = 0
                  AND order_no = ?
                  AND channel = ?
                ORDER BY id DESC
                LIMIT 1
            `, [uid, no, ch])
            : await dbGet(db, `
                SELECT end_time
                FROM "order"
                WHERE user_id = ?
                  AND is_deleted = 0
                  AND order_no = ?
                ORDER BY id DESC
                LIMIT 1
            `, [uid, no]);
        return String((row && row.end_time) || '').trim();
    } finally {
        db.close();
    }
}

async function listLatestEndedOrderSnapshotByAccounts(userId, accounts = []) {
    const uid = Number(userId || 0);
    const uniq = normalizeAccountTuples(accounts);
    if (!uid || uniq.length === 0) return {};
    await initOrderDb();
    const db = openOrderDatabase();
    try {
        const tupleSql = uniq.map(() => `(game_id = ? AND game_account = ?)`).join(' OR ');
        const tupleSqlOuter = uniq.map(() => `(o.game_id = ? AND o.game_account = ?)`).join(' OR ');
        const rows = await dbAll(db, `
            SELECT o.game_id, o.game_name, o.game_account, o.order_no, o.end_time, o.id
            FROM "order" o
            JOIN (
                SELECT game_id, game_account, MAX(datetime(end_time)) AS max_end_at
                FROM "order"
                WHERE user_id = ?
                  AND is_deleted = 0
                  AND TRIM(COALESCE(end_time, '')) <> ''
                  AND (${tupleSql})
                GROUP BY game_id, game_account
            ) x
              ON x.game_id = o.game_id
             AND x.game_account = o.game_account
             AND datetime(o.end_time) = x.max_end_at
            WHERE o.user_id = ?
              AND o.is_deleted = 0
              AND (${tupleSqlOuter})
            ORDER BY o.id DESC
        `, [uid, ...uniq.flatMap((x) => [x.game_id, x.game_account]), uid, ...uniq.flatMap((x) => [x.game_id, x.game_account])]);
        const out = {};
        for (const row of rows) {
            const gameAccount = String((row && row.game_account) || '').trim();
            const gameId = String((row && row.game_id) || '1').trim() || '1';
            const key = `${gameId}::${gameAccount}`;
            if (!gameAccount || out[key]) continue;
            out[key] = {
                order_no: String((row && row.order_no) || '').trim(),
                end_time: String((row && row.end_time) || '').trim()
            };
        }
        return out;
    } finally {
        db.close();
    }
}

async function listActiveOrderSnapshotByAccounts(userId, accounts = []) {
    const uid = Number(userId || 0);
    const uniq = normalizeAccountTuples(accounts);
    if (!uid || uniq.length === 0) return {};
    await initOrderDb();
    const db = openOrderDatabase();
    try {
        const nowText = toDateTimeText(new Date());
        const tupleSql = uniq.map(() => `(game_id = ? AND game_account = ?)`).join(' OR ');
        const rows = await dbAll(db, `
            SELECT game_id, game_name, game_account, order_no, order_status, start_time, end_time, id
            FROM "order"
            WHERE user_id = ?
              AND is_deleted = 0
              AND (${tupleSql})
              AND (
                COALESCE(order_status, '') IN ('租赁中', '出租中')
                OR (
                  TRIM(COALESCE(start_time, '')) <> ''
                  AND TRIM(COALESCE(end_time, '')) <> ''
                  AND start_time <= ?
                  AND end_time > ?
                  AND COALESCE(order_status, '') NOT IN ('已退款', '已撤单', '已完成', '部分完成', '已结束', '已取消')
                )
              )
            ORDER BY datetime(end_time) DESC, id DESC
        `, [uid, ...uniq.flatMap((x) => [x.game_id, x.game_account]), nowText, nowText]);
        const out = {};
        for (const row of rows) {
            const gameAccount = String((row && row.game_account) || '').trim();
            const gameId = String((row && row.game_id) || '1').trim() || '1';
            const key = `${gameId}::${gameAccount}`;
            if (!gameAccount || out[key]) continue;
            out[key] = {
                order_no: String((row && row.order_no) || '').trim(),
                order_status: String((row && row.order_status) || '').trim(),
                start_time: String((row && row.start_time) || '').trim(),
                end_time: String((row && row.end_time) || '').trim()
            };
        }
        return out;
    } finally {
        db.close();
    }
}

async function listLinkedOrderAccountsByUser(userId) {
    const uid = Number(userId || 0);
    if (!uid) return [];
    await initOrderDb();
    const db = openOrderDatabase();
    try {
        return dbAll(db, `
            SELECT DISTINCT user_id, game_account, game_id, game_name, MAX(COALESCE(role_name, '')) AS role_name
            FROM "order"
            WHERE user_id = ?
              AND is_deleted = 0
              AND TRIM(COALESCE(game_account, '')) <> ''
              AND TRIM(COALESCE(game_id, '')) <> ''
            GROUP BY user_id, game_account, game_id, game_name
        `, [uid]);
    } finally {
        db.close();
    }
}

async function listRecentlyEndedAccountsByUser(userId, accounts = [], suppressSec = RECENT_ORDER_END_SUPPRESS_SEC) {
    const uid = Number(userId || 0);
    const uniq = normalizeAccountTuples(accounts);
    if (!uid || uniq.length === 0) return new Set();
    await initOrderDb();
    const db = openOrderDatabase();
    try {
        const now = new Date();
        const lower = new Date(now.getTime() - Math.max(60, Number(suppressSec || RECENT_ORDER_END_SUPPRESS_SEC)) * 1000);
        const nowText = toDateTimeText(now);
        const lowerText = toDateTimeText(lower);
        const tupleSql = uniq.map(() => `(game_id = ? AND game_account = ?)`).join(' OR ');
        const rows = await dbAll(db, `
            SELECT DISTINCT game_id, game_account
            FROM "order"
            WHERE user_id = ?
              AND is_deleted = 0
              AND TRIM(COALESCE(game_account, '')) <> ''
              AND (${tupleSql})
              AND end_time >= ?
              AND end_time <= ?
        `, [uid, ...uniq.flatMap((x) => [x.game_id, x.game_account]), lowerText, nowText]);
        return new Set(rows
            .map((row) => `${String((row && row.game_id) || '1').trim() || '1'}::${String((row && row.game_account) || '').trim()}`)
            .filter(Boolean));
    } finally {
        db.close();
    }
}

async function queryDailyRowsFromOrders(userId, statDate, gameName, configuredAccounts = []) {
    const uid = Number(userId || 0);
    const g = String(gameName || 'WZRY').trim() || 'WZRY';
    const day = String(statDate || '').slice(0, 10);
    const accs = Array.from(new Set((configuredAccounts || []).map((a) => String(a.game_account || '').trim()).filter(Boolean)));
    if (!uid || !day || accs.length === 0) return [];

    const dayStart = new Date(`${day}T00:00:00`);
    const dayEnd = new Date(dayStart.getTime());
    dayEnd.setDate(dayEnd.getDate() + 1);
    const startText = toDateTimeText(dayStart);
    const endText = toDateTimeText(dayEnd);
    const placeholders = accs.map(() => '?').join(',');
    await initOrderDb();
    const db = openOrderDatabase();
    try {
        return await dbAll(db, `
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
              ${g === '全部' ? '' : 'AND COALESCE(game_name, \'\') = ?'}
              AND end_time >= ?
              AND end_time < ?
            GROUP BY game_name, game_account
        `, g === '全部' ? [uid, ...accs, startText, endText] : [uid, ...accs, g, startText, endText]);
    } finally {
        db.close();
    }
}

module.exports = {
    ORDER_COUNT_MODE_NATURAL_DAY,
    initOrderQueryService,
    listPaidCountByAccounts,
    listRentingWindowByAccounts,
    listRentingOrderWindowByAccounts: listRentingWindowByAccounts,
    listOrdersForUser,
    listActiveRentingOrdersByUser,
    listLatestEndedOrderSnapshotByAccounts,
    listActiveOrderSnapshotByAccounts,
    listLinkedOrderAccountsByUser,
    listRecentlyEndedAccountsByUser,
    getOrderStatusByOrderNo,
    getOrderEndTimeByOrderNo,
    queryDailyRowsFromOrders
};
