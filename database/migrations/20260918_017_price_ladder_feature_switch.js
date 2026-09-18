const { openPriceDatabase } = require('../sqlite_client');
const { initPriceLadderFeatureConfigDb } = require('../price_ladder_feature_config_db');

function run(db, sql) {
    return new Promise((resolve, reject) => {
        db.run(sql, (err) => err ? reject(err) : resolve());
    });
}

module.exports = {
    version: '20260918_017',
    name: 'price_ladder_feature_switch',
    desc: 'add price ladder feature switch and allow repeated account configuration removal',
    use_transaction: false,
    async up() {
        await initPriceLadderFeatureConfigDb();
        const db = openPriceDatabase();
        try {
            await run(db, 'BEGIN IMMEDIATE');
            const indexes = [
                {
                    name: 'uq_account_price_ladder_rule_alive',
                    sql: `CREATE UNIQUE INDEX uq_account_price_ladder_rule_alive
                          ON account_price_ladder_rule(user_id, game_id, game_account)
                          WHERE is_deleted = 0`
                },
                {
                    name: 'uq_account_price_ladder_runtime_alive',
                    sql: `CREATE UNIQUE INDEX uq_account_price_ladder_runtime_alive
                          ON account_price_ladder_runtime(user_id, game_id, game_account, channel)
                          WHERE is_deleted = 0`
                },
                {
                    name: 'uq_account_channel_price_baseline_alive',
                    sql: `CREATE UNIQUE INDEX uq_account_channel_price_baseline_alive
                          ON account_channel_price_baseline(user_id, game_id, game_account, channel)
                          WHERE is_deleted = 0`
                }
            ];
            for (const item of indexes) {
                await run(db, `DROP INDEX IF EXISTS ${item.name}`);
                await run(db, item.sql);
            }
            await run(db, 'COMMIT');
        } catch (err) {
            await run(db, 'ROLLBACK').catch(() => {});
            throw err;
        } finally {
            db.close();
        }
    }
};
