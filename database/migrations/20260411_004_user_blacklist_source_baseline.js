const { _internal } = require('../user_blacklist_source_db');

module.exports = {
    version: '20260411_004',
    name: 'user_blacklist_source_baseline',
    desc: 'normalize blacklist source schema and backfill source game identity',
    async up({ db }) {
        await _internal.ensureUserBlacklistSourceTableBase(db);
        const cols = new Set(await _internal.tableColumns(db, 'user_blacklist_source'));
        if (!cols.has('game_id')) {
            await _internal.run(db, `ALTER TABLE user_blacklist_source ADD COLUMN game_id TEXT NOT NULL DEFAULT '1'`);
        }
        if (!cols.has('game_name')) {
            await _internal.run(db, `ALTER TABLE user_blacklist_source ADD COLUMN game_name TEXT NOT NULL DEFAULT 'WZRY'`);
        }
        await _internal.rebuildUserBlacklistSourceTable(db);
        await _internal.ensureUserBlacklistSourceIndexes(db);
        await _internal.backfillSourceGameIdentityByAccount(db);
    }
};
