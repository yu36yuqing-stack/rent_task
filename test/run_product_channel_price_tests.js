'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
for (const test of ['product_channel_price_service_test.js', 'product_channel_price_frontend_test.js', 'product_channel_price_h5_test.js']) {
    const result = spawnSync(process.execPath, [path.join(__dirname, test)], { cwd: path.resolve(__dirname, '..'), env: process.env, encoding: 'utf8' });
    process.stdout.write(result.stdout || '');
    process.stderr.write(result.stderr || '');
    if (result.status !== 0) process.exit(result.status || 1);
}
console.log('[PASS] product channel price: all three suites passed');
