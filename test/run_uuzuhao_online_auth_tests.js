'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const tests = [
    'uuzuhao_online_auth_state_test.js',
    'uuzuhao_online_auth_probe_test.js',
    'uuzuhao_online_auth_frontend_test.js',
    'uuzuhao_online_auth_guard_test.js',
    'uuzuhao_online_auth_h5_test.js',
    'run_uuzuhao_background_pause_tests.js',
    'product_channel_price_frontend_test.js',
    'game_identity_smoke_test.js',
    { file: 'uuzuhao_online_auth_probe_test.js', code: '12101001' },
    { file: 'uuzuhao_online_auth_guard_test.js', code: '12101001' },
    { file: 'uuzuhao_online_auth_h5_test.js', code: '12101001' }
];
let failed = 0;
for (const entry of tests) {
    const { file, code } = typeof entry === 'string' ? { file: entry, code: '201010027' } : entry;
    const result = spawnSync(process.execPath, [path.join(__dirname, file)], { cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, ONLINE_AUTH_FAILURE_CODE: code }, stdio: 'inherit', timeout: 60000 });
    if (result.status !== 0) {
        console.error(`[FAIL] ${file} (${code}): ${result.error || result.signal || result.status}`);
        failed++;
    }
}
console.log(`Online authorization suites: ${tests.length - failed}/${tests.length} passed`);
if (failed) process.exitCode = 1;
