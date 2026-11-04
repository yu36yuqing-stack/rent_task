'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const files = [
    'system_config_db_test.js',
    'system_config_cli_test.js',
    'uhaozu_auto_reshelf_policy_test.js',
    'uhaozu_auto_reshelf_face_test.js',
    'uhaozu_auto_reshelf_action_test.js',
    'uhaozu_auto_reshelf_pipeline_regression_test.js',
    'schema_migration_smoke_test.js',
    'face_verify_blacklist_smoke_test.js',
    'action_engine_uhaozu_modify_reshelf_smoke_test.js',
    'action_engine_auth_regression_test.js',
    'uuzuhao_shelf_auth_integration_test.js',
    'action_engine_platform_parallel_smoke_test.js',
    'action_engine_five_e_shelf_smoke_test.js',
    'uhaozu_modify_api_smoke_test.js',
    'prod_channel_status_smoke_test.js',
    'run_dingding_report_dedup_tests.js'
];

for (const file of files) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-uhaozu-reshelf-suite-'));
    const env = { ...process.env };
    for (const name of ['MAIN', 'RUNTIME', 'ORDER', 'STATS', 'PRICE']) env[`${name}_DB_FILE_PATH`] = path.join(dir, `${name}.db`);
    const result = spawnSync(process.execPath, [path.join(__dirname, file)], { env, stdio: 'inherit', timeout: 180000 });
    if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`[PASS] Uhaozu configuration and auto-reshelf suite: ${files.length} test entries passed`);
