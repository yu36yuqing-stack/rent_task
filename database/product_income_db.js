'use strict';

const { openDatabase, openStatsDatabase } = require('./sqlite_client');

function all(db, sql, params) {
    return new Promise((resolve, reject) => db.all(sql, params, (error, rows) => {
        if (error) reject(error);
        else resolve(rows || []);
    }));
}

async function listOwnedProductIncomeAccounts(userId, gameId, gameName, accounts) {
    if (!accounts.length) return [];
    const db = openDatabase();
    try {
        return await all(db, `
            SELECT game_account, purchase_price, purchase_date
            FROM user_game_account
            WHERE user_id = ? AND CAST(game_id AS TEXT) = ? AND game_name = ?
              AND is_deleted = 0 AND COALESCE(asset_status, 'active') <> 'sold'
              AND game_account IN (${accounts.map(() => '?').join(',')})
            ORDER BY id DESC
        `, [userId, gameId, gameName, ...accounts]);
    } finally {
        db.close();
    }
}

async function listProductIncomeRows(userId, gameName, accounts, targetDate) {
    if (!accounts.length) return { snapshotRows: [], dailyRows: [] };
    const placeholders = accounts.map(() => '?').join(',');
    const db = openStatsDatabase();
    try {
        // One SELECT gives both sources a consistent read, including while the
        // statistics worker atomically rebuilds snapshots. No schema/init writes.
        const rows = await all(db, `
            SELECT 'snapshot' AS kind, id, game_account, snapshot_date AS stat_date,
                   total_rec_amount AS amount, 0 AS invalid_count
            FROM order_stats_weekly_snapshot
            WHERE user_id = ? AND game_name = ? AND is_deleted = 0
              AND snapshot_date <= ? AND game_account IN (${placeholders})
            UNION ALL
            SELECT 'daily' AS kind, 0 AS id, game_account, stat_date,
                   ROUND(SUM(amount_rec_sum), 2) AS amount,
                   SUM(CASE WHEN typeof(amount_rec_sum) NOT IN ('integer', 'real')
                            THEN 1 ELSE 0 END) AS invalid_count
            FROM order_stats_daily
            WHERE user_id = ? AND game_name = ? AND is_deleted = 0
              AND stat_date <= ? AND game_account IN (${placeholders})
            GROUP BY stat_date, game_account
            ORDER BY stat_date ASC, id DESC
        `, [userId, gameName, targetDate, ...accounts, userId, gameName, targetDate, ...accounts]);
        return {
            snapshotRows: rows.filter((row) => row.kind === 'snapshot').map((row) => ({
                ...row, snapshot_date: row.stat_date, total_rec_amount: row.amount
            })),
            dailyRows: rows.filter((row) => row.kind === 'daily').map((row) => ({ ...row, amount_rec_sum: row.amount }))
        };
    } finally {
        db.close();
    }
}

module.exports = { listOwnedProductIncomeAccounts, listProductIncomeRows };
