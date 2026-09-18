const { initAccountPriceLadderRuleDb } = require('../account_price_ladder_rule_db');
const { initAccountChannelPriceBaselineDb } = require('../account_channel_price_baseline_db');
const { initPricePublishLogDb } = require('../price_publish_log_db');

module.exports = {
    version: '20260918_015',
    name: 'price_ladder_channel_baseline',
    desc: 'create account ladder, channel price baseline and price publish log tables in price db',
    use_transaction: false,
    async up() {
        await initAccountPriceLadderRuleDb();
        await initAccountChannelPriceBaselineDb();
        await initPricePublishLogDb();
    }
};
