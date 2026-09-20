#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const tests = [
    'runtime_task_prune_smoke_test.js',
    'log_retention_smoke_test.js',
    'history_retention_smoke_test.js',
    'user_blacklist_api_smoke_test.js',
    'order_detail_retention_smoke_test.js',
    'database_compaction_smoke_test.js',
    'uhaozu_order_detail_smoke_test.js',
    'action_engine_five_e_shelf_smoke_test.js',
    'game_identity_smoke_test.js',
    'blacklist_guard_bridge_smoke_test.js',
    'face_verify_blacklist_smoke_test.js',
    'order_account_order_off_reconcile_smoke_test.js',
    'order_cooldown_config_smoke_test.js',
    'order_cooldown_release_smoke_test.js',
    'platform_channel_toggle_smoke_test.js',
    'schema_migration_smoke_test.js',
    'system_retention_smoke_test.js'
];

for (const file of tests) {
    const result = spawnSync(process.execPath, [path.join(__dirname, file)], {
        cwd: path.resolve(__dirname, '..'),
        env: process.env,
        stdio: 'inherit'
    });
    if (Number(result.status || 0) !== 0) process.exit(Number(result.status || 1));
}
