module.exports = {
    version: '20260412_010',
    name: 'drop_legacy_backup_tables',
    desc: 'drop legacy backup tables from main db after split migrations stabilized',
    async up({ db, run }) {
        const backupTables = [
            'order_main_legacy_backup',
            'order_detail_main_legacy_backup',
            'order_complaint_main_legacy_backup',
            'order_stats_daily_main_legacy_backup',
            'order_stats_cost_daily_main_legacy_backup'
        ];

        for (const tableName of backupTables) {
            await run(db, `DROP TABLE IF EXISTS "${tableName}"`);
        }
    }
};
