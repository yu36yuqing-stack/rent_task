'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const tests = ['zuhaowang_confirmed_snapshot_test.js', 'zuhaowang_snapshot_repair_integration_test.js',
    'zuhaowang_history_snapshot_db_test.js', 'zuhaowang_snapshot_query_recovery_test.js', 'run_zuhaowang_product_price_tests.js',
    'run_price_ladder_v3_tests.js', 'run_product_channel_price_tests.js'];
for (const test of tests) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-zhw-repair-suite-'));
    const env = { ...process.env };
    for (const key of ['MAIN', 'RUNTIME', 'ORDER', 'STATS', 'PRICE']) env[`${key}_DB_FILE_PATH`] = path.join(dir, `${key}.db`);
    const result = spawnSync(process.execPath, [path.join(__dirname, test)], {
        cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024
    });
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    if (result.status !== 0) process.exit(result.status || 1);
}
console.log('[PASS] ZHW snapshot repair: 4 new suites + 30 related regression suites');
