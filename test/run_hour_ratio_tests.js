'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const logs = path.join(root, 'coverage/hour-ratio/test-logs');
fs.mkdirSync(logs, { recursive: true });
const tests = [
    'hour_ratio_calculation_test.js',
    'hour_ratio_service_h5_test.js',
    'hour_ratio_reconcile_mode_test.js',
    'hour_ratio_snapshot_test.js',
    'zuhaowang_product_mode_db_test.js',
    'hour_ratio_frontend_test.js',
    'run_price_ladder_v3_tests.js',
    'daily_price_logging_test.js',
    'daily_price_policy_test.js',
    'daily_price_policy_integration_test.js',
    'daily_price_policy_publish_test.js',
    'daily_price_policy_h5_test.js',
    'zuhaowang_confirmed_snapshot_test.js',
    'zuhaowang_snapshot_query_recovery_test.js',
    'zuhaowang_snapshot_repair_integration_test.js',
    'zuhaowang_history_snapshot_db_test.js',
    'run_zuhaowang_product_price_tests.js',
    'run_product_channel_price_tests.js'
];
for (const test of tests) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-hour-ratio-suite-'));
    const env = { ...process.env, SHEEP_FIX_ENABLE: '0', BL_V2_INSPECTOR_ENABLE: '0', ORDER_COUNT_TRACE: 'false' };
    for (const key of ['MAIN', 'RUNTIME', 'ORDER', 'STATS', 'PRICE']) env[`${key}_DB_FILE_PATH`] = path.join(dir, `${key}.db`);
    const result = spawnSync(process.execPath, [path.join(__dirname, test)], {
        cwd: root, env, encoding: 'utf8', maxBuffer: 60 * 1024 * 1024, timeout: 120000
    });
    fs.writeFileSync(path.join(logs, `${test}.log`), `${result.stdout || ''}${result.stderr || ''}`);
    if (result.status !== 0) {
        process.stdout.write(result.stdout || '');
        process.stderr.write(result.stderr || '');
        console.error(`[FAIL] ${test}`, result.error || result.signal || result.status);
        process.exit(result.status || 1);
    }
    console.log(`[PASS] ${test}`);
}
console.log(`[PASS] hourly multiplier: ${tests.length} test entries passed (including existing nested regression suites)`);
