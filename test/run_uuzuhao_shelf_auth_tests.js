'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
for (const file of ['run_uuzuhao_online_auth_tests.js', 'run_zuhaowang_product_price_tests.js', 'action_engine_auth_regression_test.js']) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-shelf-suite-'));
    const env = { ...process.env };
    for (const name of ['MAIN', 'RUNTIME', 'ORDER', 'STATS', 'PRICE']) env[`${name}_DB_FILE_PATH`] = path.join(dir, `${name}.db`);
    const result = spawnSync(process.execPath, [path.join(__dirname, file)], { env, stdio: 'inherit', timeout: 180000 });
    if (result.status !== 0) process.exit(result.status || 1);
}
console.log('[PASS] shelf auth regression: all three suite groups passed');
