'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const root = path.resolve(__dirname, '..');
const entries = [
    'dingding_rule_status_icon_test.js',
    'dingding_cooldown_icon_test.js',
    'run_dingding_report_dedup_tests.js'
];
for (const entry of entries) {
    const result = spawnSync(process.execPath, [path.join(__dirname, entry)], {
        cwd: root,
        env: { ...process.env, SHEEP_FIX_ENABLE: 'false' },
        stdio: 'inherit',
        timeout: 120000
    });
    if (result.status !== 0) {
        console.error(`[FAIL] ${entry}: ${result.error || result.signal || result.status}`);
        process.exitCode = 1;
        break;
    }
}
if (!process.exitCode) console.log(`[PASS] DingTalk status icon suite: ${entries.length}/${entries.length} entries passed`);
