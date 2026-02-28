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

async function initOrderStatsCostDailyDb() {
    const db = openDatabase();
    try {
        await run(db, `
            CREATE TABLE IF NOT EXISTS order_stats_cost_daily (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                stat_date TEXT NOT NULL DEFAULT '',
                user_id INTEGER NOT NULL,
                game_name TEXT NOT NULL DEFAULT 'WZRY',
                cost_base REAL NOT NULL DEFAULT 0,
                account_count INTEGER NOT NULL DEFAULT 0,
                create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        await run(db, `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_order_stats_cost_daily_alive
            ON order_stats_cost_daily(user_id, stat_date, game_name, is_deleted)
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_order_stats_cost_daily_user_date_alive
            ON order_stats_cost_daily(user_id, stat_date, game_name, is_deleted)
        `);
    } finally {
        db.close();
    }
}

function toMoney2(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Number(n.toFixed(2));
}

async function upsertCostSnapshotForDay(userId, statDate, gameName, costBase, accountCount, desc = '') {
    await initOrderStatsCostDailyDb();
    const uid = Number(userId || 0);
    const day = String(statDate || '').slice(0, 10);
    const g = String(gameName || 'WZRY').trim() || 'WZRY';
    if (!uid) throw new Error('user_id 不合法');
    if (!day) throw new Error('stat_date 不能为空');
    const base = toMoney2(costBase);
    const cnt = Math.max(0, Math.floor(Number(accountCount || 0)));
    const now = nowText();

    const db = openDatabase();
    try {
        await run(db, `
            INSERT INTO order_stats_cost_daily
            (stat_date, user_id, game_name, cost_base, account_count, create_date, modify_date, is_deleted, desc)
            VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
            ON CONFLICT(user_id, stat_date, game_name, is_deleted)
            DO UPDATE SET
              cost_base = excluded.cost_base,
              account_count = excluded.account_count,
              modify_date = excluded.modify_date,
              desc = excluded.desc
        `, [day, uid, g, base, cnt, now, now, String(desc || '').trim()]);
    } finally {
        db.close();
    }
}

async function listCostSnapshotsByUser(userId, startDate, endDate, gameName = 'WZRY') {
    await initOrderStatsCostDailyDb();
    const uid = Number(userId || 0);
    const s = String(startDate || '').slice(0, 10);
    const e = String(endDate || '').slice(0, 10);
    const g = String(gameName || 'WZRY').trim() || 'WZRY';
    if (!uid) throw new Error('user_id 不合法');
    if (!s || !e) throw new Error('start_date / end_date 不能为空');

    const db = openDatabase();
    try {
        return await all(db, `
            SELECT stat_date, cost_base, account_count
            FROM order_stats_cost_daily
            WHERE user_id = ?
              AND game_name = ?
              AND stat_date >= ?
              AND stat_date <= ?
              AND is_deleted = 0
            ORDER BY stat_date ASC
        `, [uid, g, s, e]);
    } finally {
        db.close();
    }
}

module.exports = {
    initOrderStatsCostDailyDb,
    upsertCostSnapshotForDay,
    listCostSnapshotsByUser
};
