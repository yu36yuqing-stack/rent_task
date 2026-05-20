#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');

const targets = [
    {
        file: 'order/order.js',
        functionName: 'syncOrdersForAllUsers',
        endMarker: 'console.log(`[OrderSync] all_users summary='
    },
    {
        file: 'stats/order_stats.js',
        functionName: 'refreshOrderStatsDailyForAllUsers',
        endMarker: 'return {'
    },
    {
        file: 'blacklist/blacklist_inspector.js',
        functionName: 'runBlacklistInspectorOnce',
        endMarker: 'let usersMismatch = 0;'
    }
];

function extractRelevantScope(source, functionName, endMarker) {
    const marker = `async function ${functionName}`;
    const start = source.indexOf(marker);
    assert.ok(start >= 0, `${functionName} not found`);
    const end = source.indexOf(endMarker, start);
    assert.ok(end > start, `${functionName} scope end not found`);
    return source.slice(start, end);
}

for (const target of targets) {
    const fullPath = path.join(repoRoot, target.file);
    const source = fs.readFileSync(fullPath, 'utf8');
    const body = extractRelevantScope(source, target.functionName, target.endMarker);
    assert.ok(
        body.includes('USER_STATUS_ENABLED') || body.includes("status"),
        `${target.file} should keep enabled-user filtering`
    );
    assert.ok(
        !body.includes('USER_TYPE_ADMIN') && !body.includes("user_type") && !body.includes('管理员'),
        `${target.file} must not exclude admin users in ${target.functionName}`
    );
}

console.log('[PASS] admin_user_batch_scope_smoke_test');
