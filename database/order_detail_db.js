const { openDatabase } = require('./sqlite_client');

function nowText() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
}

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row || null);
        });
    });
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

function toMoney2(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Number(n.toFixed(2));
}

function normalizeDetail(input = {}) {
    const userId = Number(input.user_id || 0);
    const channel = String(input.channel || '').trim().toLowerCase();
    const orderNo = String(input.order_no || '').trim();
    const orderDetailNo = String(input.order_detail_no || input.order_no || '').trim();
    if (!userId) throw new Error('user_id 不合法');
    if (!channel) throw new Error('channel 不能为空');
    if (!orderNo) throw new Error('order_no 不能为空');
    if (!orderDetailNo) throw new Error('order_detail_no 不能为空');
    return {
        user_id: userId,
        channel,
        order_no: orderNo,
        order_detail_no: orderDetailNo,
        detail_status: String(input.detail_status || '').trim(),
        actual_rent_amount: toMoney2(input.actual_rent_amount),
        service_fee_amount: toMoney2(input.service_fee_amount),
        net_rent_amount: toMoney2(input.net_rent_amount),
        complete_time: String(input.complete_time || '').trim(),
        complaint_result_text: String(input.complaint_result_text || '').trim(),
        detail_html: String(input.detail_html || '').trim(),
        detail_snapshot: JSON.stringify(input.detail_snapshot && typeof input.detail_snapshot === 'object' ? input.detail_snapshot : {}),
        detail_query_time: String(input.detail_query_time || nowText()).trim(),
        desc: String(input.desc || '').trim()
    };
}

async function initOrderDetailDb() {
    const db = openDatabase();
    try {
        await run(db, `
            CREATE TABLE IF NOT EXISTS order_detail (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                channel TEXT NOT NULL DEFAULT '',
                order_no TEXT NOT NULL DEFAULT '',
                order_detail_no TEXT NOT NULL DEFAULT '',
                detail_status TEXT NOT NULL DEFAULT '',
                actual_rent_amount REAL NOT NULL DEFAULT 0,
                service_fee_amount REAL NOT NULL DEFAULT 0,
                net_rent_amount REAL NOT NULL DEFAULT 0,
                complete_time TEXT NOT NULL DEFAULT '',
                complaint_result_text TEXT NOT NULL DEFAULT '',
                detail_html TEXT NOT NULL DEFAULT '',
                detail_snapshot TEXT NOT NULL DEFAULT '{}',
                detail_query_time TEXT NOT NULL DEFAULT '',
                create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        await run(db, `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_order_detail_alive
            ON order_detail(user_id, channel, order_no, is_deleted)
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_order_detail_query
            ON order_detail(channel, detail_query_time, is_deleted)
        `);
    } finally {
        db.close();
    }
}

async function upsertOrderDetail(input = {}) {
    await initOrderDetailDb();
    const row = normalizeDetail(input);
    const db = openDatabase();
    try {
        const existed = await get(db, `
            SELECT id
            FROM order_detail
            WHERE user_id = ? AND channel = ? AND order_no = ? AND is_deleted = 0
            LIMIT 1
        `, [row.user_id, row.channel, row.order_no]);
        if (!existed) {
            await run(db, `
                INSERT INTO order_detail
                (user_id, channel, order_no, order_detail_no, detail_status, actual_rent_amount, service_fee_amount, net_rent_amount, complete_time, complaint_result_text, detail_html, detail_snapshot, detail_query_time, create_date, modify_date, is_deleted, desc)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
            `, [
                row.user_id,
                row.channel,
                row.order_no,
                row.order_detail_no,
                row.detail_status,
                row.actual_rent_amount,
                row.service_fee_amount,
                row.net_rent_amount,
                row.complete_time,
                row.complaint_result_text,
                row.detail_html,
                row.detail_snapshot,
                row.detail_query_time,
                nowText(),
                nowText(),
                row.desc
            ]);
        } else {
            await run(db, `
                UPDATE order_detail
                SET order_detail_no = ?, detail_status = ?, actual_rent_amount = ?, service_fee_amount = ?, net_rent_amount = ?,
                    complete_time = ?, complaint_result_text = ?, detail_html = ?, detail_snapshot = ?, detail_query_time = ?, modify_date = ?, desc = ?
                WHERE id = ?
            `, [
                row.order_detail_no,
                row.detail_status,
                row.actual_rent_amount,
                row.service_fee_amount,
                row.net_rent_amount,
                row.complete_time,
                row.complaint_result_text,
                row.detail_html,
                row.detail_snapshot,
                row.detail_query_time,
                nowText(),
                row.desc,
                Number(existed.id)
            ]);
        }
    } finally {
        db.close();
    }
}

async function getOrderDetailByOrder(userId, channel, orderNo) {
    await initOrderDetailDb();
    const uid = Number(userId || 0);
    const db = openDatabase();
    try {
        const row = await get(db, `
            SELECT *
            FROM order_detail
            WHERE user_id = ? AND channel = ? AND order_no = ? AND is_deleted = 0
            LIMIT 1
        `, [uid, String(channel || '').trim().toLowerCase(), String(orderNo || '').trim()]);
        if (row && typeof row.detail_snapshot === 'string') {
            try {
                row.detail_snapshot = JSON.parse(row.detail_snapshot || '{}') || {};
            } catch {
                row.detail_snapshot = {};
            }
        }
        return row;
    } finally {
        db.close();
    }
}

async function listPendingUhaozuOrderDetailsByUser(userId, orderNos = []) {
    await initOrderDetailDb();
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    const uniq = Array.from(new Set((Array.isArray(orderNos) ? orderNos : []).map((x) => String(x || '').trim()).filter(Boolean)));
    const db = openDatabase();
    try {
        const params = [uid];
        let whereOrder = '';
        if (uniq.length > 0) {
            whereOrder = `AND o.order_no IN (${uniq.map(() => '?').join(',')})`;
            params.push(...uniq);
        }
        return await all(db, `
            SELECT
                o.user_id, o.channel, o.order_no, o.order_status, o.rec_amount,
                d.id AS detail_id,
                d.net_rent_amount,
                d.detail_query_time
            FROM "order" o
            LEFT JOIN order_detail d
              ON d.user_id = o.user_id
             AND d.channel = o.channel
             AND d.order_no = o.order_no
             AND d.is_deleted = 0
            WHERE o.user_id = ?
              AND o.channel = 'uhaozu'
              AND o.is_deleted = 0
              AND o.order_status IN ('已完成', '部分完成')
              ${whereOrder}
              AND (
                    d.id IS NULL
                 OR COALESCE(d.net_rent_amount, 0) <= 0
              )
            ORDER BY o.create_date DESC, o.id DESC
        `, params);
    } finally {
        db.close();
    }
}

module.exports = {
    initOrderDetailDb,
    upsertOrderDetail,
    getOrderDetailByOrder,
    listPendingUhaozuOrderDetailsByUser
};
