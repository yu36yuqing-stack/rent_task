#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const tests = [
    'price_ladder_feature_gate_smoke_test.js',
    'price_ladder_reconcile_smoke_test.js',
    'account_price_ladder_smoke_test.js',
    'price_publish_service_smoke_test.js',
    'h5_price_ladder_smoke_test.js',
    'pricing_ladder_frontend_helpers_smoke_test.js',
    'schema_migration_smoke_test.js',
    'order_command_service_smoke_test.js',
    'order_query_service_smoke_test.js',
    'product_order_service_regression_smoke_test.js',
    'order_cooldown_release_smoke_test.js',
    'order_stats_refresh_policy_smoke_test.js'
];

for (const test of tests) {
    const fullPath = path.join(__dirname, test);
    const result = spawnSync(process.execPath, [fullPath], {
        cwd: path.join(__dirname, '..'),
        env: process.env,
        encoding: 'utf8'
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.status !== 0) process.exit(result.status || 1);
}

console.log('[OK] price ladder v3 test suite passed');
