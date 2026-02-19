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

function toNumberSafe(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

function toDateTimeTextFromMs(v) {
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0) return '';
    const d = new Date(n > 1e12 ? n : n * 1000);
    if (Number.isNaN(d.getTime())) return '';
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function initOrderComplaintDb() {
    const db = openDatabase();
    try {
        await run(db, `
            CREATE TABLE IF NOT EXISTS order_complaint (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                channel TEXT NOT NULL DEFAULT '',
                order_no TEXT NOT NULL DEFAULT '',
                complaint_status INTEGER NOT NULL DEFAULT 0,
                complaint_id TEXT NOT NULL DEFAULT '',
                complaint_type INTEGER NOT NULL DEFAULT 0,
                complaint_type_desc TEXT NOT NULL DEFAULT '',
                complaint_context TEXT NOT NULL DEFAULT '',
                complaint_start_time TEXT NOT NULL DEFAULT '',
                complaint_start_time_raw INTEGER NOT NULL DEFAULT 0,
                first_log_time TEXT NOT NULL DEFAULT '',
                first_log_time_raw INTEGER NOT NULL DEFAULT 0,
                rent_duration TEXT NOT NULL DEFAULT '',
                check_result_desc TEXT NOT NULL DEFAULT '',
                complaint_attachment TEXT NOT NULL DEFAULT '',
                raw_payload TEXT NOT NULL DEFAULT '{}',
                create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        await run(db, `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_order_complaint_alive
            ON order_complaint(user_id, channel, order_no, is_deleted)
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_order_complaint_user_alive
            ON order_complaint(user_id, is_deleted)
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_order_complaint_order_alive
            ON order_complaint(channel, order_no, is_deleted)
        `);
    } finally {
        db.close();
    }
}

async function upsertOrderComplaint(input = {}, options = {}) {
    await initOrderComplaintDb();
    const uid = Number(input.user_id || 0);
    const channel = String(input.channel || '').trim().toLowerCase();
    const orderNo = String(input.order_no || '').trim();
    if (!uid) throw new Error('user_id 不合法');
    if (!channel) throw new Error('channel 不能为空');
    if (!orderNo) throw new Error('order_no 不能为空');

    const complaintStartRaw = toNumberSafe(input.complaint_start_time_raw ?? input.complaint_start_time, 0);
    const firstLogRaw = toNumberSafe(input.first_log_time_raw ?? input.first_log_time, 0);
    const now = nowText();
    const payloadText = (() => {
        const raw = input.raw_payload && typeof input.raw_payload === 'object'
            ? input.raw_payload
            : (input.raw_payload ? { raw_payload: input.raw_payload } : {});
        try { return JSON.stringify(raw); } catch { return '{}'; }
    })();

    const row = {
        user_id: uid,
        channel,
        order_no: orderNo,
        complaint_status: toNumberSafe(input.complaint_status, 0),
        complaint_id: String(input.complaint_id || '').trim(),
        complaint_type: toNumberSafe(input.complaint_type, 0),
        complaint_type_desc: String(input.complaint_type_desc || '').trim(),
        complaint_context: String(input.complaint_context || '').trim(),
        complaint_start_time: String(input.complaint_start_time_text || toDateTimeTextFromMs(complaintStartRaw)).trim(),
        complaint_start_time_raw: complaintStartRaw,
        first_log_time: String(input.first_log_time_text || toDateTimeTextFromMs(firstLogRaw)).trim(),
        first_log_time_raw: firstLogRaw,
        rent_duration: String(input.rent_duration || '').trim(),
        check_result_desc: String(input.check_result_desc || '').trim(),
        complaint_attachment: String(input.complaint_attachment || '').trim(),
        raw_payload: payloadText,
        desc: String(options.desc || input.desc || '').trim()
    };

    const db = openDatabase();
    try {
        const exists = await get(db, `
            SELECT id
            FROM order_complaint
            WHERE user_id = ? AND channel = ? AND order_no = ? AND is_deleted = 0
            LIMIT 1
        `, [uid, channel, orderNo]);
        if (!exists) {
            await run(db, `
                INSERT INTO order_complaint
                (user_id, channel, order_no, complaint_status, complaint_id, complaint_type, complaint_type_desc,
                 complaint_context, complaint_start_time, complaint_start_time_raw, first_log_time, first_log_time_raw,
                 rent_duration, check_result_desc, complaint_attachment, raw_payload, create_date, modify_date, is_deleted, desc)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
            `, [
                row.user_id,
                row.channel,
                row.order_no,
                row.complaint_status,
                row.complaint_id,
                row.complaint_type,
                row.complaint_type_desc,
                row.complaint_context,
                row.complaint_start_time,
                row.complaint_start_time_raw,
                row.first_log_time,
                row.first_log_time_raw,
                row.rent_duration,
                row.check_result_desc,
                row.complaint_attachment,
                row.raw_payload,
                now,
                now,
                row.desc
            ]);
        } else {
            await run(db, `
                UPDATE order_complaint
                SET complaint_status = ?,
                    complaint_id = ?,
                    complaint_type = ?,
                    complaint_type_desc = ?,
                    complaint_context = ?,
                    complaint_start_time = ?,
                    complaint_start_time_raw = ?,
                    first_log_time = ?,
                    first_log_time_raw = ?,
                    rent_duration = ?,
                    check_result_desc = ?,
                    complaint_attachment = ?,
                    raw_payload = ?,
                    modify_date = ?,
                    desc = ?
                WHERE id = ?
            `, [
                row.complaint_status,
                row.complaint_id,
                row.complaint_type,
                row.complaint_type_desc,
                row.complaint_context,
                row.complaint_start_time,
                row.complaint_start_time_raw,
                row.first_log_time,
                row.first_log_time_raw,
                row.rent_duration,
                row.check_result_desc,
                row.complaint_attachment,
                row.raw_payload,
                now,
                row.desc,
                Number(exists.id || 0)
            ]);
        }
        return true;
    } finally {
        db.close();
    }
}

async function getOrderComplaintByOrder(userId, channel, orderNo) {
    await initOrderComplaintDb();
    const uid = Number(userId || 0);
    const ch = String(channel || '').trim().toLowerCase();
    const no = String(orderNo || '').trim();
    if (!uid) throw new Error('user_id 不合法');
    if (!ch) throw new Error('channel 不能为空');
    if (!no) throw new Error('order_no 不能为空');

    const db = openDatabase();
    try {
        const row = await get(db, `
            SELECT
              user_id, channel, order_no, complaint_status, complaint_id, complaint_type, complaint_type_desc,
              complaint_context, complaint_start_time, complaint_start_time_raw, first_log_time, first_log_time_raw,
              rent_duration, check_result_desc, complaint_attachment, raw_payload, create_date, modify_date
            FROM order_complaint
            WHERE user_id = ? AND channel = ? AND order_no = ? AND is_deleted = 0
            LIMIT 1
        `, [uid, ch, no]);
        if (!row) return null;
        return row;
    } finally {
        db.close();
    }
}

module.exports = {
    initOrderComplaintDb,
    upsertOrderComplaint,
    getOrderComplaintByOrder
};
