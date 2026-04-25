const { openOrderDatabase, openStatsDatabase } = require('../sqlite_client');

async function tableExists(db, all, tableName) {
    const rows = await all(db, `
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = ?
        LIMIT 1
    `, [tableName]);
    return rows.length > 0;
}

async function tableColumns(db, all, tableName) {
    if (!(await tableExists(db, all, tableName))) return new Set();
    const quotedTable = `"${String(tableName).replace(/"/g, '""')}"`;
    const rows = await all(db, `PRAGMA table_info(${quotedTable})`);
    return new Set(rows.map((row) => String(row.name || '').trim()).filter(Boolean));
}

async function normalizeTableGameName(db, run, all, tableName) {
    const cols = await tableColumns(db, all, tableName);
    if (!cols.has('game_id') || !cols.has('game_name')) return;
    const quotedTable = `"${String(tableName).replace(/"/g, '""')}"`;
    const setParts = [`game_name = 'CSGO'`];
    if (cols.has('modify_date')) setParts.push(`modify_date = CURRENT_TIMESTAMP`);
    if (cols.has('desc')) {
        setParts.push(`
            desc = CASE
                WHEN TRIM(COALESCE(desc, '')) = '' THEN 'backfill CSGO game profile'
                WHEN INSTR(desc, 'backfill CSGO game profile') > 0 THEN desc
                ELSE desc || ';backfill CSGO game profile'
            END
        `);
    }
    await run(db, `
        UPDATE ${quotedTable}
        SET ${setParts.join(', ')}
        WHERE game_id = '4'
          AND game_name <> 'CSGO'
    `);
}

module.exports = {
    version: '20260425_013',
    name: 'csgo_game_profile',
    desc: 'recognize game_id=4 as CSGO and backfill existing rows',
    use_transaction: false,
    async up({ db, run, all }) {
        await normalizeTableGameName(db, run, all, 'user_game_account');
        await normalizeTableGameName(db, run, all, 'user_blacklist');
        await normalizeTableGameName(db, run, all, 'user_blacklist_source');
        await normalizeTableGameName(db, run, all, 'user_blacklist_history');
        await normalizeTableGameName(db, run, all, 'prod_guard_task');
        await normalizeTableGameName(db, run, all, 'prod_risk_event');
        await normalizeTableGameName(db, run, all, 'user_platform_restrict');

        const orderDb = openOrderDatabase();
        try {
            await normalizeTableGameName(orderDb, run, all, 'order');
            await normalizeTableGameName(orderDb, run, all, 'order_detail');
            await normalizeTableGameName(orderDb, run, all, 'order_complaint');
        } finally {
            orderDb.close();
        }

        const statsDb = openStatsDatabase();
        try {
            await normalizeTableGameName(statsDb, run, all, 'account_cost_record');
            await normalizeTableGameName(statsDb, run, all, 'order_stats_daily');
            await normalizeTableGameName(statsDb, run, all, 'order_stats_cost_daily');
            await normalizeTableGameName(statsDb, run, all, 'order_stats_weekly_snapshot');
        } finally {
            statsDb.close();
        }
    }
};
