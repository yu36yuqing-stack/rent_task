#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const tests = [
    'dingding_report_dedup_smoke_test.js',
    'user_pipeline_stage_smoke_test.js',
    'rent_robot_main_runtime_task_branches_smoke_test.js',
    'h5_runtime_task_failure_smoke_test.js'
];

let failed = 0;
for (const file of tests) {
    const result = spawnSync(process.execPath, [path.join(__dirname, file)], {
        cwd: root,
        env: { ...process.env },
        stdio: 'inherit',
        timeout: 60000
    });
    if (result.status !== 0) {
        console.error(`[FAIL] ${file}: ${result.error || result.signal || result.status}`);
        failed += 1;
    }
}

console.log(`DingTalk report dedup suite: ${tests.length - failed}/${tests.length} passed`);
if (failed > 0) process.exitCode = 1;
