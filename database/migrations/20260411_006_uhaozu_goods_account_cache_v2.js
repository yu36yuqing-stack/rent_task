const { _internal } = require('../uhaozu_goods_account_cache_db');

module.exports = {
    version: '20260411_006',
    name: 'uhaozu_goods_account_cache_v2',
    desc: 'migrate uhaozu goods account cache to v2 schema once',
    use_transaction: false,
    async up({ db }) {
        await _internal.createTableAndIndexes(db);
        await _internal.migrateToV2IfNeeded(db);
    }
};
