'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-price-db-'));
process.env.PRICE_DB_FILE_PATH = path.join(tmpDir, 'rent_robot_price.db');

const {
    initUserPriceRuleDb,
    getUserPriceRule
} = require('../database/user_price_rule_db');
const {
    saveUhaozuPricingConfigByUser,
    getUhaozuPricingConfigByUser,
    saveUhaozuPricingAccountCostByUser
} = require('../price/price_rule_service');

(async () => {
    await initUserPriceRuleDb();

    const saved = await saveUhaozuPricingConfigByUser(8, {
        game_name: '和平精英',
        payback_days: 240,
        avg_daily_rent_hours: 4,
        platform_fee_rate: 0.21,
        withdrawal_fee_rate: 0.03,
        price_step: 0.5
    });

    assert.strictEqual(saved.game_name, '和平精英');
    assert.strictEqual(saved.config.payback_days, 240);
    assert.strictEqual(saved.config.avg_daily_rent_hours, 4);

    const loaded = await getUhaozuPricingConfigByUser(8, { game_name: '和平精英' });
    assert.strictEqual(loaded.config.payback_days, 240);
    assert.strictEqual(loaded.config.platform_fee_rate, 0.21);

    const costSaved = await saveUhaozuPricingAccountCostByUser(8, {
        game_name: '和平精英',
        game_account: '10001',
        total_cost_amount: 1888.66
    });
    assert.strictEqual(costSaved.config.pricing_account_costs['10001'], 1888.66);

    const direct = await getUserPriceRule(8, {
        channel: 'uhaozu',
        game_id: '2',
        mode: 'payback_period'
    });
    assert(direct);
    assert.strictEqual(direct.rule_detail.withdrawal_fee_rate, 0.03);
    assert.strictEqual(direct.rule_detail.pricing_account_costs['10001'], 1888.66);

    console.log('[OK] price_rule_db_smoke_test passed');
})().catch((err) => {
    console.error('[FAIL] price_rule_db_smoke_test failed:', err);
    process.exit(1);
});
