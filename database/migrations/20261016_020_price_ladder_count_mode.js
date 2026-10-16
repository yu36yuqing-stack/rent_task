'use strict';

const { initPriceLadderFeatureConfigDb } = require('../price_ladder_feature_config_db');

module.exports = {
    version: '20261016_020',
    name: 'price_ladder_count_mode',
    desc: 'add backward-compatible user price ladder order count window mode and reconciliation reason',
    use_transaction: false,
    async up() {
        await initPriceLadderFeatureConfigDb();
    }
};
