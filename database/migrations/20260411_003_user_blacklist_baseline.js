const { _internal } = require('../user_blacklist_db');

module.exports = {
    version: '20260411_003',
    name: 'user_blacklist_baseline',
    desc: 'normalize blacklist tables and backfill blacklist game identity',
    async up({ db }) {
        await _internal.ensureUserBlacklistTables(db);
        await _internal.ensureUserBlacklistColumns(db);
        await _internal.reorderUserBlacklistColumnsIfNeeded(db);
        await _internal.ensureColumn(db, 'user_blacklist_history', 'game_id', "game_id TEXT NOT NULL DEFAULT '1'");
        await _internal.ensureColumn(db, 'user_blacklist_history', 'game_name', "game_name TEXT NOT NULL DEFAULT 'WZRY'");
        await _internal.ensureColumn(db, 'user_blacklist_source', 'game_id', "game_id TEXT NOT NULL DEFAULT '1'");
        await _internal.ensureColumn(db, 'user_blacklist_source', 'game_name', "game_name TEXT NOT NULL DEFAULT 'WZRY'");
        await _internal.ensureUserBlacklistIndexes(db);
        try {
            await _internal.backfillUserBlacklistRemarkFromUserGameAccount(db);
            await _internal.backfillBlacklistGameIdentityByAccount(db);
        } catch (_) {}
    }
};
