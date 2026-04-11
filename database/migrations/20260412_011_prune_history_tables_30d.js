const { pruneProductOnoffHistory } = require('../product_onoff_history_db');

module.exports = {
    version: '20260412_011',
    name: 'prune_history_tables_30d',
    desc: 'keep only recent 30 days for product_onoff_history; user_blacklist_history had no eligible stale rows on rollout day',
    use_transaction: false,
    async up() {
        await pruneProductOnoffHistory({ retain_days: 30 });
    }
};
