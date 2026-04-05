const { openPriceDatabase } = require('./sqlite_client');

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

function normalizeJsonText(value = null) {
    if (value === undefined) return null;
    if (value === null) return null;
    return JSON.stringify(value);
}

function parseJsonText(value, fallback = null) {
    const text = String(value || '').trim();
    if (!text) return fallback;
    try {
        return JSON.parse(text);
    } catch {
        return fallback;
    }
}

function rowToBatch(row = {}) {
    return {
        id: Number(row.id || 0),
        batch_id: String(row.batch_id || '').trim(),
        user_id: Number(row.user_id || 0),
        channel: String(row.channel || '').trim(),
        game_name: String(row.game_name || '').trim(),
        trigger_source: String(row.trigger_source || '').trim(),
        request_snapshot: parseJsonText(row.request_snapshot, {}),
        total_count: Number(row.total_count || 0),
        success_count: Number(row.success_count || 0),
        fail_count: Number(row.fail_count || 0),
        status: String(row.status || '').trim(),
        start_time: String(row.start_time || '').trim(),
        end_time: String(row.end_time || '').trim(),
        create_date: String(row.create_date || '').trim(),
        modify_date: String(row.modify_date || '').trim(),
        is_deleted: Number(row.is_deleted || 0),
        desc: String(row.desc || '').trim()
    };
}

function rowToItem(row = {}) {
    return {
        id: Number(row.id || 0),
        batch_id: String(row.batch_id || '').trim(),
        user_id: Number(row.user_id || 0),
        channel: String(row.channel || '').trim(),
        game_name: String(row.game_name || '').trim(),
        game_account: String(row.game_account || '').trim(),
        goods_id: String(row.goods_id || '').trim(),
        publish_status: String(row.publish_status || '').trim(),
        fail_message: String(row.fail_message || '').trim(),
        before_data: parseJsonText(row.before_data, null),
        request_data: parseJsonText(row.request_data, null),
        response_data: parseJsonText(row.response_data, null),
        after_data: parseJsonText(row.after_data, null),
        price_before_hour: Number(row.price_before_hour || 0),
        price_before_night: Number(row.price_before_night || 0),
        price_before_day: Number(row.price_before_day || 0),
        price_before_week: Number(row.price_before_week || 0),
        price_target_hour: Number(row.price_target_hour || 0),
        price_target_night: Number(row.price_target_night || 0),
        price_target_day: Number(row.price_target_day || 0),
        price_target_week: Number(row.price_target_week || 0),
        price_after_hour: Number(row.price_after_hour || 0),
        price_after_night: Number(row.price_after_night || 0),
        price_after_day: Number(row.price_after_day || 0),
        price_after_week: Number(row.price_after_week || 0),
        start_time: String(row.start_time || '').trim(),
        end_time: String(row.end_time || '').trim(),
        create_date: String(row.create_date || '').trim(),
        modify_date: String(row.modify_date || '').trim(),
        is_deleted: Number(row.is_deleted || 0),
        desc: String(row.desc || '').trim()
    };
}

async function initPricePublishLogDb() {
    const db = openPriceDatabase();
    try {
        await run(db, `
            CREATE TABLE IF NOT EXISTS price_publish_batch_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                batch_id TEXT NOT NULL,
                user_id INTEGER NOT NULL,
                channel TEXT NOT NULL,
                game_name TEXT NOT NULL DEFAULT '',
                trigger_source TEXT NOT NULL DEFAULT '',
                request_snapshot TEXT NOT NULL DEFAULT '{}',
                total_count INTEGER NOT NULL DEFAULT 0,
                success_count INTEGER NOT NULL DEFAULT 0,
                fail_count INTEGER NOT NULL DEFAULT 0,
                status TEXT NOT NULL DEFAULT 'running',
                start_time TEXT NOT NULL DEFAULT '',
                end_time TEXT NOT NULL DEFAULT '',
                create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        await run(db, `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_price_publish_batch_log_batch_alive
            ON price_publish_batch_log(batch_id, is_deleted)
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_price_publish_batch_log_user_channel_time
            ON price_publish_batch_log(user_id, channel, modify_date, is_deleted)
        `);
        await run(db, `
            CREATE TABLE IF NOT EXISTS price_publish_item_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                batch_id TEXT NOT NULL,
                user_id INTEGER NOT NULL,
                channel TEXT NOT NULL,
                game_name TEXT NOT NULL DEFAULT '',
                game_account TEXT NOT NULL DEFAULT '',
                goods_id TEXT NOT NULL DEFAULT '',
                publish_status TEXT NOT NULL DEFAULT '',
                fail_message TEXT NOT NULL DEFAULT '',
                before_data TEXT DEFAULT NULL,
                request_data TEXT DEFAULT NULL,
                response_data TEXT DEFAULT NULL,
                after_data TEXT DEFAULT NULL,
                price_before_hour REAL NOT NULL DEFAULT 0,
                price_before_night REAL NOT NULL DEFAULT 0,
                price_before_day REAL NOT NULL DEFAULT 0,
                price_before_week REAL NOT NULL DEFAULT 0,
                price_target_hour REAL NOT NULL DEFAULT 0,
                price_target_night REAL NOT NULL DEFAULT 0,
                price_target_day REAL NOT NULL DEFAULT 0,
                price_target_week REAL NOT NULL DEFAULT 0,
                price_after_hour REAL NOT NULL DEFAULT 0,
                price_after_night REAL NOT NULL DEFAULT 0,
                price_after_day REAL NOT NULL DEFAULT 0,
                price_after_week REAL NOT NULL DEFAULT 0,
                start_time TEXT NOT NULL DEFAULT '',
                end_time TEXT NOT NULL DEFAULT '',
                create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_price_publish_item_log_batch_alive
            ON price_publish_item_log(batch_id, is_deleted, id)
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_price_publish_item_log_user_channel_time
            ON price_publish_item_log(user_id, channel, modify_date, is_deleted)
        `);
    } finally {
        db.close();
    }
}

async function createPricePublishBatchLog(input = {}) {
    await initPricePublishLogDb();
    const db = openPriceDatabase();
    try {
        const now = nowText();
        await run(db, `
            INSERT INTO price_publish_batch_log
            (batch_id, user_id, channel, game_name, trigger_source, request_snapshot, total_count, success_count, fail_count, status, start_time, end_time, create_date, modify_date, is_deleted, desc)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
        `, [
            String(input.batch_id || '').trim(),
            Number(input.user_id || 0),
            String(input.channel || '').trim(),
            String(input.game_name || '').trim(),
            String(input.trigger_source || '').trim(),
            normalizeJsonText(input.request_snapshot || {}) || '{}',
            Number(input.total_count || 0),
            Number(input.success_count || 0),
            Number(input.fail_count || 0),
            String(input.status || 'running').trim() || 'running',
            String(input.start_time || now).trim(),
            String(input.end_time || '').trim(),
            now,
            now,
            String(input.desc || '').trim()
        ]);
        const row = await get(db, `
            SELECT *
            FROM price_publish_batch_log
            WHERE batch_id = ? AND is_deleted = 0
            LIMIT 1
        `, [String(input.batch_id || '').trim()]);
        return rowToBatch(row || {});
    } finally {
        db.close();
    }
}

async function updatePricePublishBatchLog(batchId, input = {}) {
    await initPricePublishLogDb();
    const db = openPriceDatabase();
    try {
        const now = nowText();
        await run(db, `
            UPDATE price_publish_batch_log
            SET total_count = COALESCE(?, total_count),
                success_count = COALESCE(?, success_count),
                fail_count = COALESCE(?, fail_count),
                status = COALESCE(?, status),
                end_time = COALESCE(?, end_time),
                request_snapshot = COALESCE(?, request_snapshot),
                modify_date = ?,
                desc = COALESCE(?, desc)
            WHERE batch_id = ? AND is_deleted = 0
        `, [
            input.total_count === undefined ? null : Number(input.total_count || 0),
            input.success_count === undefined ? null : Number(input.success_count || 0),
            input.fail_count === undefined ? null : Number(input.fail_count || 0),
            input.status === undefined ? null : String(input.status || '').trim(),
            input.end_time === undefined ? null : String(input.end_time || '').trim(),
            input.request_snapshot === undefined ? null : (normalizeJsonText(input.request_snapshot) || '{}'),
            now,
            input.desc === undefined ? null : String(input.desc || '').trim(),
            String(batchId || '').trim()
        ]);
        const row = await get(db, `
            SELECT *
            FROM price_publish_batch_log
            WHERE batch_id = ? AND is_deleted = 0
            LIMIT 1
        `, [String(batchId || '').trim()]);
        return row ? rowToBatch(row) : null;
    } finally {
        db.close();
    }
}

async function createPricePublishItemLog(input = {}) {
    await initPricePublishLogDb();
    const db = openPriceDatabase();
    try {
        const now = nowText();
        await run(db, `
            INSERT INTO price_publish_item_log
            (batch_id, user_id, channel, game_name, game_account, goods_id, publish_status, fail_message, before_data, request_data, response_data, after_data,
             price_before_hour, price_before_night, price_before_day, price_before_week,
             price_target_hour, price_target_night, price_target_day, price_target_week,
             price_after_hour, price_after_night, price_after_day, price_after_week,
             start_time, end_time, create_date, modify_date, is_deleted, desc)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    ?, ?, ?, ?,
                    ?, ?, ?, ?,
                    ?, ?, ?, ?,
                    ?, ?, ?, ?, 0, ?)
        `, [
            String(input.batch_id || '').trim(),
            Number(input.user_id || 0),
            String(input.channel || '').trim(),
            String(input.game_name || '').trim(),
            String(input.game_account || '').trim(),
            String(input.goods_id || '').trim(),
            String(input.publish_status || '').trim(),
            String(input.fail_message || '').trim(),
            normalizeJsonText(input.before_data),
            normalizeJsonText(input.request_data),
            normalizeJsonText(input.response_data),
            normalizeJsonText(input.after_data),
            Number(input.price_before_hour || 0),
            Number(input.price_before_night || 0),
            Number(input.price_before_day || 0),
            Number(input.price_before_week || 0),
            Number(input.price_target_hour || 0),
            Number(input.price_target_night || 0),
            Number(input.price_target_day || 0),
            Number(input.price_target_week || 0),
            Number(input.price_after_hour || 0),
            Number(input.price_after_night || 0),
            Number(input.price_after_day || 0),
            Number(input.price_after_week || 0),
            String(input.start_time || now).trim(),
            String(input.end_time || now).trim(),
            now,
            now,
            String(input.desc || '').trim()
        ]);
    } finally {
        db.close();
    }
}

async function listPricePublishBatchLogsByUser(userId, query = {}) {
    await initPricePublishLogDb();
    const db = openPriceDatabase();
    try {
        const uid = Number(userId || 0);
        const channel = String(query.channel || '').trim();
        const gameName = String(query.game_name || '').trim();
        const page = Math.max(1, Number(query.page || 1));
        const pageSize = Math.max(1, Math.min(100, Number(query.page_size || 20)));
        const where = ['user_id = ?', 'is_deleted = 0'];
        const params = [uid];
        if (channel) {
            where.push('channel = ?');
            params.push(channel);
        }
        if (gameName) {
            where.push('game_name = ?');
            params.push(gameName);
        }
        const whereSql = where.join(' AND ');
        const totalRow = await get(db, `
            SELECT COUNT(*) AS total
            FROM price_publish_batch_log
            WHERE ${whereSql}
        `, params);
        const rows = await all(db, `
            SELECT *
            FROM price_publish_batch_log
            WHERE ${whereSql}
            ORDER BY id DESC
            LIMIT ? OFFSET ?
        `, [...params, pageSize, (page - 1) * pageSize]);
        return {
            total: Number(totalRow && totalRow.total || 0),
            page,
            page_size: pageSize,
            list: rows.map(rowToBatch)
        };
    } finally {
        db.close();
    }
}

async function getPricePublishBatchLogByBatchId(userId, batchId) {
    await initPricePublishLogDb();
    const db = openPriceDatabase();
    try {
        const row = await get(db, `
            SELECT *
            FROM price_publish_batch_log
            WHERE user_id = ? AND batch_id = ? AND is_deleted = 0
            LIMIT 1
        `, [Number(userId || 0), String(batchId || '').trim()]);
        return row ? rowToBatch(row) : null;
    } finally {
        db.close();
    }
}

async function listPricePublishItemLogsByBatchId(batchId) {
    await initPricePublishLogDb();
    const db = openPriceDatabase();
    try {
        const rows = await all(db, `
            SELECT *
            FROM price_publish_item_log
            WHERE batch_id = ? AND is_deleted = 0
            ORDER BY id ASC
        `, [String(batchId || '').trim()]);
        return rows.map(rowToItem);
    } finally {
        db.close();
    }
}

module.exports = {
    initPricePublishLogDb,
    createPricePublishBatchLog,
    updatePricePublishBatchLog,
    createPricePublishItemLog,
    listPricePublishBatchLogsByUser,
    getPricePublishBatchLogByBatchId,
    listPricePublishItemLogsByBatchId
};
