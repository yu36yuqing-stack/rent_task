'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const tests = [
    'product_income_service_test.js',
    'product_income_summary_frontend_test.js',
    'product_rent_income_h5_test.js',
    'order_stats_historical_total_scope_smoke_test.js',
    'order_stats_refresh_policy_smoke_test.js',
    'product_channel_price_service_test.js',
    'product_channel_price_frontend_test.js',
    'product_channel_price_h5_test.js',
    'h5_csgo_more_ops_smoke_test.js',
    'h5_auth_revoke_card_smoke_test.js',
    'h5_account_order_off_config_smoke_test.js',
    'h5_price_ladder_smoke_test.js'
];
for (const test of tests) {
    const result = spawnSync(process.execPath, [path.join(__dirname, test)], {
        cwd: path.resolve(__dirname, '..'), env: process.env, encoding: 'utf8'
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`[PASS] product income: all ${tests.length} test scripts passed`);
