module.exports = {
    version: '20260412_009',
    name: 'cleanup_legacy_main_order_stats_tables',
    desc: 'move stale order stats tables out of main db active names',
    async up({ db, get, run }) {
        async function tableExists(name) {
            const row = await get(db, `
                SELECT name
                FROM sqlite_master
                WHERE type = 'table' AND name = ?
                LIMIT 1
            `, [String(name || '').trim()]);
            return Boolean(row && row.name);
        }

        const renames = [
            ['order_stats_daily', 'order_stats_daily_main_legacy_backup'],
            ['order_stats_cost_daily', 'order_stats_cost_daily_main_legacy_backup']
        ];

        for (const [source, backup] of renames) {
            const hasSource = await tableExists(source);
            if (!hasSource) continue;
            const hasBackup = await tableExists(backup);
            if (hasBackup) {
                await run(db, `DROP TABLE "${source}"`);
                continue;
            }
            await run(db, `ALTER TABLE "${source}" RENAME TO "${backup}"`);
        }
    }
};
