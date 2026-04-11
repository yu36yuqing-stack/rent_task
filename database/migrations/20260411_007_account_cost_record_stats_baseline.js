const { openStatsDatabase } = require('../sqlite_client');
const { canonicalGameId, canonicalGameNameById } = require('../../common/game_profile');
const { initAccountCostRecordDb, _internal } = require('../account_cost_record_db');

module.exports = {
    version: '20260411_007',
    name: 'account_cost_record_stats_baseline',
    desc: 'migrate account cost record into stats db and backfill purchase costs once',
    async up({ db }) {
        await initAccountCostRecordDb();
        const statsDb = openStatsDatabase();
        try {
            const mainTable = await _internal.get(db, `
                SELECT name
                FROM sqlite_master
                WHERE type = 'table' AND name = 'account_cost_record'
                LIMIT 1
            `);
            if (mainTable) {
                const rows = await _internal.all(db, `
                    SELECT *
                    FROM account_cost_record
                    ORDER BY id ASC
                `);
                for (const row of rows) {
                    const exists = await _internal.get(statsDb, `
                        SELECT id
                        FROM account_cost_record
                        WHERE user_id = ? AND game_id = ? AND game_account = ? AND cost_type = ? AND cost_date = ? AND cost_amount = ? AND is_deleted = ?
                        LIMIT 1
                    `, [
                        Number(row.user_id || 0),
                        canonicalGameId(row.game_id, row.game_name || 'WZRY'),
                        String(row.game_account || '').trim(),
                        String(row.cost_type || 'other').trim() || 'other',
                        String(row.cost_date || '').slice(0, 10),
                        Number(Number(row.cost_amount || 0).toFixed(2)),
                        Number(row.is_deleted || 0)
                    ]);
                    if (exists) continue;
                    await _internal.run(statsDb, `
                        INSERT INTO account_cost_record
                        (user_id, game_id, game_name, game_account, cost_amount, cost_date, cost_type, cost_desc, create_date, modify_date, is_deleted, desc)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    `, [
                        Number(row.user_id || 0),
                        canonicalGameId(row.game_id, row.game_name || 'WZRY'),
                        canonicalGameNameById(row.game_id, row.game_name || 'WZRY'),
                        String(row.game_account || '').trim(),
                        Number(Number(row.cost_amount || 0).toFixed(2)),
                        String(row.cost_date || '').slice(0, 10),
                        String(row.cost_type || 'other').trim() || 'other',
                        String(row.cost_desc || ''),
                        String(row.create_date || _internal.nowText()),
                        String(row.modify_date || _internal.nowText()),
                        Number(row.is_deleted || 0),
                        String(row.desc || '')
                    ]);
                }
                await _internal.run(db, `DROP TABLE IF EXISTS account_cost_record`);
            }

            const rows = await _internal.all(db, `
                SELECT uga.user_id, uga.game_id, uga.game_name, uga.game_account, uga.purchase_price, uga.purchase_date
                FROM user_game_account uga
                WHERE uga.is_deleted = 0
                  AND uga.purchase_price > 0
                  AND uga.purchase_date GLOB '????-??-??'
            `);
            const now = _internal.nowText();
            for (const row of rows) {
                const existed = await _internal.get(statsDb, `
                    SELECT id
                    FROM account_cost_record
                    WHERE user_id = ? AND game_id = ? AND game_account = ? AND cost_type = 'purchase' AND is_deleted = 0
                    LIMIT 1
                `, [
                    Number(row.user_id || 0),
                    canonicalGameId(row.game_id, row.game_name || 'WZRY'),
                    String(row.game_account || '').trim()
                ]);
                if (existed) continue;
                await _internal.run(statsDb, `
                    INSERT INTO account_cost_record
                    (user_id, game_id, game_name, game_account, cost_amount, cost_date, cost_type, cost_desc, create_date, modify_date, is_deleted, desc)
                    VALUES (?, ?, ?, ?, ?, ?, 'purchase', '', ?, ?, 0, 'backfill purchase from user_game_account')
                `, [
                    Number(row.user_id || 0),
                    canonicalGameId(row.game_id, row.game_name || 'WZRY'),
                    canonicalGameNameById(row.game_id, row.game_name || 'WZRY'),
                    String(row.game_account || '').trim(),
                    Number(Number(row.purchase_price || 0).toFixed(2)),
                    String(row.purchase_date || '').slice(0, 10),
                    now,
                    now
                ]);
            }

            const mainRows = await _internal.all(db, `
                SELECT id, user_id, game_id, game_name, game_account
                FROM user_game_account
                WHERE is_deleted = 0
            `);
            for (const row of mainRows) {
                const totalRow = await _internal.get(statsDb, `
                    SELECT ROUND(COALESCE(SUM(cost_amount), 0), 2) AS total
                    FROM account_cost_record
                    WHERE user_id = ? AND game_id = ? AND game_account = ? AND is_deleted = 0
                `, [
                    Number(row.user_id || 0),
                    canonicalGameId(row.game_id, row.game_name || 'WZRY'),
                    String(row.game_account || '').trim()
                ]);
                await _internal.run(db, `
                    UPDATE user_game_account
                    SET total_cost_amount = ?
                    WHERE id = ?
                `, [Number((totalRow && totalRow.total) || 0), Number(row.id)]);
            }
        } finally {
            statsDb.close();
        }
    }
};
