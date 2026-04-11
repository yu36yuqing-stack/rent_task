const { _internal } = require('../user_game_account_db');

module.exports = {
    version: '20260411_002',
    name: 'user_game_account_baseline',
    desc: 'normalize user_game_account schema and dedupe canonical game identities',
    async up({ db }) {
        await _internal.ensureUserGameAccountTableBase(db);
        const cols = await _internal.tableColumns(db, 'user_game_account');
        if (!cols.has('account_remark')) {
            await _internal.run(db, `ALTER TABLE user_game_account ADD COLUMN account_remark TEXT NOT NULL DEFAULT ''`);
        }
        if (!cols.has('game_id')) {
            await _internal.run(db, `ALTER TABLE user_game_account ADD COLUMN game_id TEXT NOT NULL DEFAULT '1'`);
            await _internal.run(db, `
                UPDATE user_game_account
                SET game_id = CASE
                    WHEN COALESCE(game_name, 'WZRY') IN ('和平精英') THEN '2'
                    WHEN COALESCE(game_name, 'WZRY') IN ('CFM', '枪战王者', '穿越火线', '穿越火线手游') THEN '3'
                    ELSE '1'
                END
                WHERE TRIM(COALESCE(game_id, '')) = ''
            `);
        }
        if (!cols.has('channel_prd_info')) {
            await _internal.run(db, `ALTER TABLE user_game_account ADD COLUMN channel_prd_info TEXT NOT NULL DEFAULT '{}'`);
        }
        if (!cols.has('switch')) {
            await _internal.run(db, `ALTER TABLE user_game_account ADD COLUMN "switch" TEXT NOT NULL DEFAULT '{}'`);
        }
        if (!cols.has('purchase_price')) {
            await _internal.run(db, `ALTER TABLE user_game_account ADD COLUMN purchase_price REAL NOT NULL DEFAULT 0`);
        }
        if (!cols.has('purchase_date')) {
            await _internal.run(db, `ALTER TABLE user_game_account ADD COLUMN purchase_date TEXT NOT NULL DEFAULT ''`);
        }
        if (!cols.has('total_cost_amount')) {
            await _internal.run(db, `ALTER TABLE user_game_account ADD COLUMN total_cost_amount REAL NOT NULL DEFAULT 0`);
        }
        if (!cols.has('manual_deleted')) {
            await _internal.run(db, `ALTER TABLE user_game_account ADD COLUMN manual_deleted INTEGER NOT NULL DEFAULT 0`);
        }
        if (!cols.has('manual_deleted_at')) {
            await _internal.run(db, `ALTER TABLE user_game_account ADD COLUMN manual_deleted_at TEXT NOT NULL DEFAULT ''`);
        }
        if (!cols.has('online_probe_snapshot')) {
            await _internal.run(db, `ALTER TABLE user_game_account ADD COLUMN online_probe_snapshot TEXT NOT NULL DEFAULT '{}'`);
        }
        if (!cols.has('forbidden_probe_snapshot')) {
            await _internal.run(db, `ALTER TABLE user_game_account ADD COLUMN forbidden_probe_snapshot TEXT NOT NULL DEFAULT '{}'`);
        }
        await _internal.reorderUserGameAccountColumnsIfNeeded(db);
        await _internal.ensureUserGameAccountIndexes(db);
        await _internal.compactCanonicalGameNames(db);
    }
};
