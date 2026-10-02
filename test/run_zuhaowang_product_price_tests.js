'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const tests = ['zuhaowang_price_snapshot_test.js', 'zuhaowang_product_price_sync_test.js',
    'product_platform_parallel_timing_smoke_test.js', 'product_uhaozu_prd_info_smoke_test.js',
    'five_e_product_sync_smoke_test.js', 'product_order_service_regression_smoke_test.js',
    'zuhaowang_price_publish_service_smoke_test.js'];
for (const test of tests) {
    const result = spawnSync(process.execPath, [path.join(__dirname, test)], { cwd: path.resolve(__dirname, '..'), env: process.env, encoding: 'utf8' });
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`[PASS] zuhaowang product price: ${tests.length} suites passed`);
