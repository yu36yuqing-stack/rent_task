'use strict';

const { initUserChannelPackageRatioDb } = require('../user_channel_package_ratio_db');

module.exports = {
    version: '20260921_018',
    name: 'user_channel_package_ratio',
    desc: 'create per-user per-channel package ratio settings in price db',
    use_transaction: false,
    async up() {
        await initUserChannelPackageRatioDb();
    }
};
