const { openStatsDatabase } = require('./sqlite_client');

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

function toMoney2(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Number(n.toFixed(2));
}

async function initOrderStatsWeeklySnapshotDb() {
    const db = openStatsDatabase();
    try {
        await run(db, `
            CREATE TABLE IF NOT EXISTS order_stats_weekly_snapshot (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                game_name TEXT NOT NULL DEFAULT 'WZRY',
                game_account TEXT NOT NULL DEFAULT '',
                week_start_date TEXT NOT NULL DEFAULT '',
                week_end_date TEXT NOT NULL DEFAULT '',
                snapshot_date TEXT NOT NULL DEFAULT '',
                total_rec_amount REAL NOT NULL DEFAULT 0,
                create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        const cols = await tableColumns(db, 'order_stats_weekly_snapshot');
        if (!cols.has('week_start_date')) {
            await run(db, `ALTER TABLE order_stats_weekly_snapshot ADD COLUMN week_start_date TEXT NOT NULL DEFAULT ''`);
        }
        if (!cols.has('week_end_date')) {
            await run(db, `ALTER TABLE order_stats_weekly_snapshot ADD COLUMN week_end_date TEXT NOT NULL DEFAULT ''`);
        }
        if (!cols.has('snapshot_date')) {
            await run(db, `ALTER TABLE order_stats_weekly_snapshot ADD COLUMN snapshot_date TEXT NOT NULL DEFAULT ''`);
            await run(db, `UPDATE order_stats_weekly_snapshot SET snapshot_date = COALESCE(week_end_date, '') WHERE COALESCE(snapshot_date, '') = ''`);
        }
        await run(db, `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_order_stats_weekly_snapshot_alive
            ON order_stats_weekly_snapshot(user_id, game_name, game_account, snapshot_date, is_deleted)
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_order_stats_weekly_snapshot_user_game_account_date
            ON order_stats_weekly_snapshot(user_id, game_name, game_account, snapshot_date, is_deleted)
        `);
    } finally {
        db.close();
    }
}

async function replaceWeeklySnapshotsFromDate(userId, gameName, snapshotDateFrom, rows = [], desc = '') {
    await initOrderStatsWeeklySnapshotDb();
    const uid = Number(userId || 0);
    const g = String(gameName || 'WZRY').trim() || 'WZRY';
    const startDate = String(snapshotDateFrom || '').slice(0, 10);
    if (!uid) throw new Error('user_id 不合法');
    if (!startDate) throw new Error('snapshot_date 起点不能为空');
    const db = openStatsDatabase();
    const now = nowText();
    try {
        await run(db, 'BEGIN IMMEDIATE TRANSACTION');
        await run(db, `
            DELETE FROM order_stats_weekly_snapshot
            WHERE user_id = ? AND game_name = ? AND snapshot_date >= ?
        `, [uid, g, startDate]);
        for (const row of rows) {
            await run(db, `
                INSERT INTO order_stats_weekly_snapshot
                (user_id, game_name, game_account, week_start_date, week_end_date, snapshot_date, total_rec_amount, create_date, modify_date, is_deleted, desc)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
            `, [
                uid,
                g,
                String(row.game_account || '').trim(),
                String(row.week_start_date || '').slice(0, 10),
                String(row.week_end_date || '').slice(0, 10),
                String(row.snapshot_date || '').slice(0, 10),
                toMoney2(row.total_rec_amount || 0),
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

async function listWeeklySnapshotsByUser(userId, gameName, endDate = '') {
    await initOrderStatsWeeklySnapshotDb();
    const uid = Number(userId || 0);
    const g = String(gameName || 'WZRY').trim() || 'WZRY';
    const end = String(endDate || '').slice(0, 10);
    if (!uid) throw new Error('user_id 不合法');
    const db = openStatsDatabase();
    try {
        return await all(db, `
            SELECT *
            FROM order_stats_weekly_snapshot
            WHERE user_id = ?
              AND game_name = ?
              AND is_deleted = 0
              ${end ? 'AND snapshot_date <= ?' : ''}
            ORDER BY snapshot_date DESC, id DESC
        `, end ? [uid, g, end] : [uid, g]);
    } finally {
        db.close();
    }
}

module.exports = {
    initOrderStatsWeeklySnapshotDb,
    replaceWeeklySnapshotsFromDate,
    listWeeklySnapshotsByUser
};
