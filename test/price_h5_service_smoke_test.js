'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-price-h5-'));
process.env.MAIN_DB_FILE_PATH = path.join(tmpDir, 'rent_robot.db');
process.env.PRICE_DB_FILE_PATH = path.join(tmpDir, 'rent_robot_price.db');

const { initUserDb, createUserByAdmin } = require('../database/user_db');
const {
    initUserGameAccountDb,
    upsertUserGameAccount,
    updateUserGameAccountTotalCostByUserAndAccount
} = require('../database/user_game_account_db');
const {
    saveUhaozuPricingConfigByUser,
    saveUhaozuPricingAccountCostByUser
} = require('../price/price_rule_service');
const { getUhaozuPricingDashboardByUser } = require('../price/price_h5_service');

(async () => {
    await initUserDb();
    await createUserByAdmin({
        account: 'price_h5_smoke',
        password: '123456',
        user_type: '内部',
        status: 'enabled',
        desc: 'price h5 smoke'
    });
    await initUserGameAccountDb();

    await upsertUserGameAccount({
        user_id: 1,
        game_account: '10001',
        game_id: '2',
        game_name: '和平精英',
        account_remark: 'smoke',
        channel_prd_info: {}
    });
    await updateUserGameAccountTotalCostByUserAndAccount(1, '10001', 3000, 'price h5 smoke', '2', '和平精英');

    await saveUhaozuPricingConfigByUser(1, {
        game_name: '和平精英',
        payback_days: 240,
        avg_daily_rent_hours: 3.5,
        platform_fee_rate: 0.2,
        withdrawal_fee_rate: 0.02,
        price_step: 0.3
    });

    const loaded = await getUhaozuPricingDashboardByUser(1, {
        game_name: '和平精英',
        payback_days: null,
        avg_daily_rent_hours: null,
        platform_fee_rate: null,
        withdrawal_fee_rate: null,
        price_step: null
    });

    assert.strictEqual(loaded.config.payback_days, 240);
    assert.strictEqual(loaded.config.price_step, 0.3);
    assert.strictEqual(loaded.config.game_name, '和平精英');

    await saveUhaozuPricingAccountCostByUser(1, {
        game_name: '和平精英',
        game_account: '10001',
        total_cost_amount: 1888.66
    });

    const overridden = await getUhaozuPricingDashboardByUser(1, {
        game_name: '和平精英'
    });
    assert.strictEqual(overridden.list[0].total_cost_amount, 1888.66);
    assert.strictEqual(overridden.list[0].base_total_cost_amount, 3000);
    assert.strictEqual(overridden.list[0].pricing_cost_overridden, true);

    console.log('[OK] price_h5_service_smoke_test passed');
})().catch((err) => {
    console.error('[FAIL] price_h5_service_smoke_test failed:', err);
    process.exit(1);
});
