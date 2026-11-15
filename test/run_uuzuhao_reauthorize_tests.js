'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const entries = ['uuzuhao_reauthorize_test.js', 'run_uuzuhao_update_game_info_tests.js',
    'run_uuzuhao_online_auth_tests.js', 'run_uuzuhao_background_pause_tests.js', 'order_auth_revoke_smoke_test.js'];
for (const entry of entries) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-recovery-suite-'));
    const env = { ...process.env, UUZUHAO_AUTO_REAUTHORIZE_ENABLED: '0' };
    for (const name of ['MAIN', 'RUNTIME', 'ORDER', 'STATS', 'PRICE']) env[`${name}_DB_FILE_PATH`] = path.join(dir, `${name}.db`);
    const result = spawnSync(process.execPath, [path.join(__dirname, entry)], { env, stdio: 'inherit', timeout: 240000 });
    if (result.status !== 0) process.exit(result.status || 1);
}
console.log(`[PASS] reauthorize: ${entries.length} suite entries`);
