#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const root = path.resolve(__dirname, '..');
const tests = [
    'uuzuhao_background_pause_smoke_test.js',
    'order_auth_revoke_smoke_test.js',
    'uuzuhao_auth_revoke_smoke_test.js',
    'prod_guard_uuzuhao_auth_worker_skip_smoke_test.js',
    'prod_guard_account_switch_smoke_test.js',
    'h5_uuzuhao_auth_abnormal_probe_smoke_test.js',
    'h5_auth_revoke_card_smoke_test.js',
    'prod_channel_status_smoke_test.js',
    'blacklist_guard_bridge_smoke_test.js',
    'runtime_task_smoke_test.js',
    'action_engine_platform_parallel_smoke_test.js',
    'uuzuhao_auth_abnormal_mapping_smoke_test.js'
];
let failed = 0;
for (const file of tests) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-auth-suite-'));
    const env = { ...process.env };
    for (const name of ['MAIN', 'RUNTIME', 'ORDER', 'STATS', 'PRICE']) env[`${name}_DB_FILE_PATH`] = path.join(dir, `${name}.db`);
    const result = spawnSync(process.execPath, [path.join(__dirname, file)], { cwd: root, env, stdio: 'inherit', timeout: 45000 });
    if (result.status !== 0) {
        console.error(`[FAIL] ${file}: ${result.error || result.signal || result.status}`);
        failed += 1;
    }
}
console.log(`Auth pause suite: ${tests.length - failed}/${tests.length} passed`);
if (failed) process.exitCode = 1;
