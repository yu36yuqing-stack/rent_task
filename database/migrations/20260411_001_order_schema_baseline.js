const { _internal } = require('../order_db');

module.exports = {
    version: '20260411_001',
    name: 'order_schema_baseline',
    desc: 'normalize order schema and seed order indexes once',
    async up({ db }) {
        await _internal.ensureOrderTableBase(db);
        await _internal.migrateFromLegacyUserOrderTable(db);
        await _internal.rebuildOrderTableToTargetSchemaIfNeeded(db);
        await _internal.ensureOrderIndexes(db);
        await _internal.normalizeOrderTableData(db);
    }
};
