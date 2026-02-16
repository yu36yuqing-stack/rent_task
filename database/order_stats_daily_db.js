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

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

async function tableColumns(db, tableName) {
    const rows = await all(db, `PRAGMA table_info(${tableName})`);
    return new Set(rows.map((row) => String(row.name || '')));
}

async function initOrderStatsDailyDb() {
    const db = openDatabase();
    try {
        await run(db, `
            CREATE TABLE IF NOT EXISTS order_stats_daily (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                stat_date TEXT NOT NULL DEFAULT '',
                user_id INTEGER NOT NULL,
                game_name TEXT NOT NULL DEFAULT 'WZRY',
                channel TEXT NOT NULL DEFAULT '',
                game_account TEXT NOT NULL DEFAULT '',
                role_name TEXT NOT NULL DEFAULT '',
                purchase_price REAL NOT NULL DEFAULT 0,
                purchase_date TEXT NOT NULL DEFAULT '',
                order_cnt_total INTEGER NOT NULL DEFAULT 0,
                order_cnt_effective INTEGER NOT NULL DEFAULT 0,
                order_cnt_progress INTEGER NOT NULL DEFAULT 0,
                order_cnt_done INTEGER NOT NULL DEFAULT 0,
                order_cnt_refund INTEGER NOT NULL DEFAULT 0,
                order_cnt_cancel INTEGER NOT NULL DEFAULT 0,
                order_cnt_zero_rec INTEGER NOT NULL DEFAULT 0,
                rent_hour_sum REAL NOT NULL DEFAULT 0,
                amount_order_sum REAL NOT NULL DEFAULT 0,
                amount_rec_sum REAL NOT NULL DEFAULT 0,
                amount_refund_sum REAL NOT NULL DEFAULT 0,
                create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        await run(db, `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_order_stats_daily_alive
            ON order_stats_daily(user_id, stat_date, game_name, channel, game_account, is_deleted)
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_order_stats_daily_user_date_alive
            ON order_stats_daily(user_id, stat_date, is_deleted)
        `);
        const cols = await tableColumns(db, 'order_stats_daily');
        if (!cols.has('rent_hour_sum')) {
            await run(db, `ALTER TABLE order_stats_daily ADD COLUMN rent_hour_sum REAL NOT NULL DEFAULT 0`);
        }
    } finally {
        db.close();
    }
}

function toNumber(value, fallback = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function toMoney2(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Number(n.toFixed(2));
}

async function replaceOrderStatsRowsForDay(userId, statDate, gameName, rows = [], desc = '') {
    await initOrderStatsDailyDb();
    const uid = Number(userId || 0);
    const day = String(statDate || '').slice(0, 10);
    const g = String(gameName || 'WZRY').trim() || 'WZRY';
    if (!uid) throw new Error('user_id 不合法');
    if (!day) throw new Error('stat_date 不能为空');

    const db = openDatabase();
    const now = nowText();
    try {
        await run(db, 'BEGIN IMMEDIATE TRANSACTION');
        // 统计表是按天快照，重算时直接整天重建，避免历史软删除与唯一索引冲突。
        await run(db, `
            DELETE FROM order_stats_daily
            WHERE user_id = ? AND stat_date = ? AND game_name = ?
        `, [uid, day, g]);

        for (const r of rows) {
            await run(db, `
                INSERT INTO order_stats_daily
                (stat_date, user_id, game_name, channel, game_account, role_name,
                 purchase_price, purchase_date,
                 order_cnt_total, order_cnt_effective, order_cnt_progress, order_cnt_done,
                 order_cnt_refund, order_cnt_cancel, order_cnt_zero_rec,
                 rent_hour_sum, amount_order_sum, amount_rec_sum, amount_refund_sum,
                 create_date, modify_date, is_deleted, desc)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
            `, [
                day,
                uid,
                g,
                String(r.channel || '').trim(),
                String(r.game_account || '').trim(),
                String(r.role_name || '').trim(),
                toMoney2(r.purchase_price),
                String(r.purchase_date || '').slice(0, 10),
                Math.max(0, Math.floor(toNumber(r.order_cnt_total, 0))),
                Math.max(0, Math.floor(toNumber(r.order_cnt_effective, 0))),
                Math.max(0, Math.floor(toNumber(r.order_cnt_progress, 0))),
                Math.max(0, Math.floor(toNumber(r.order_cnt_done, 0))),
                Math.max(0, Math.floor(toNumber(r.order_cnt_refund, 0))),
                Math.max(0, Math.floor(toNumber(r.order_cnt_cancel, 0))),
                Math.max(0, Math.floor(toNumber(r.order_cnt_zero_rec, 0))),
                toMoney2(r.rent_hour_sum),
                toMoney2(r.amount_order_sum),
                toMoney2(r.amount_rec_sum),
                toMoney2(r.amount_refund_sum),
                now,
                now,
                String(desc || '').trim()
            ]);
        }
        await run(db, 'COMMIT');
    } catch (e) {
        try { await run(db, 'ROLLBACK'); } catch (_) {}
        throw e;
    } finally {
        db.close();
    }
}

async function listOrderStatsRows(userId, startDate, endDate, gameName = 'WZRY') {
    await initOrderStatsDailyDb();
    const uid = Number(userId || 0);
    const s = String(startDate || '').slice(0, 10);
    const e = String(endDate || '').slice(0, 10);
    const g = String(gameName || 'WZRY').trim() || 'WZRY';
    if (!uid) throw new Error('user_id 不合法');
    if (!s || !e) throw new Error('start_date / end_date 不能为空');

    const db = openDatabase();
    try {
        return await all(db, `
            SELECT *
            FROM order_stats_daily
            WHERE user_id = ?
              AND game_name = ?
              AND stat_date >= ?
              AND stat_date <= ?
              AND is_deleted = 0
            ORDER BY stat_date DESC, amount_rec_sum DESC, id DESC
        `, [uid, g, s, e]);
    } finally {
        db.close();
    }
}

module.exports = {
    initOrderStatsDailyDb,
    replaceOrderStatsRowsForDay,
    listOrderStatsRows
};
