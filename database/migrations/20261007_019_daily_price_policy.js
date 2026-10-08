'use strict';

const { initUserChannelPackageRatioDb } = require('../user_channel_package_ratio_db');

module.exports = {
    version: '20261007_019',
    name: 'daily_price_policy',
    desc: 'add backward-compatible per-channel daily tier policy in price db',
    use_transaction: false,
    async up() {
        await initUserChannelPackageRatioDb();
    }
};
