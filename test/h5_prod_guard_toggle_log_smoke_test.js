#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-h5-prod-guard-log-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');
process.env.ORDER_DB_FILE_PATH = path.join(tempDir, 'rent_robot_order.db');
process.env.STATS_DB_FILE_PATH = path.join(tempDir, 'rent_robot_stats.db');
process.env.PRICE_DB_FILE_PATH = path.join(tempDir, 'rent_robot_price.db');
process.env.SHEEP_FIX_ENABLE = '0';
process.env.H5_PORT = String(22080 + Math.floor(Math.random() * 1000));
process.env.USER_PIPELINE_LOCK_WAIT_MS = '0';
process.env.STATS_REFRESH_LOCK_POLL_MS = '200';
process.env.BL_V2_INSPECTOR_ENABLE = '0';

const { createUserByAdmin } = require('../database/user_db');
const { createAccessToken } = require('../user/auth_token');
const { upsertUserGameAccount, getAliveUserGameAccountByUserAndAccount } = require('../database/user_game_account_db');
delete require.cache[require.resolve('../h5/local_h5_server')];
const { bootstrap } = require('../h5/local_h5_server');
const { stopProdRiskTaskWorker } = require('../product/prod_status_guard');

async function sleep(ms) {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPing(baseUrl, headers = {}, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const res = await fetch(`${baseUrl}/api/ping`, { headers });
            if (res.ok) return;
        } catch {}
        await sleep(200);
    }
    throw new Error('waitForPing timeout');
}

async function main() {
    const user = await createUserByAdmin({
        account: 'h5_prod_guard_log',
        password: '123456',
        name: 'H5 ProdGuard Log',
        user_type: '外部',
        status: 'enabled',
        desc: 'h5 prod guard toggle log smoke'
    });
    await upsertUserGameAccount({
        user_id: user.id,
        game_id: '1',
        game_name: 'WZRY',
        game_account: 'guard_log_acc',
        account_remark: '日志账号',
        switch: {
            prod_guard: {
                label: '在线风控',
                enabled: true
            }
        },
        desc: 'seed prod guard account'
    });

    const headers = {
        Authorization: `Bearer ${createAccessToken(user)}`,
        'Content-Type': 'application/json'
    };

    const logs = [];
    const rawLog = console.log;
    console.log = (...args) => {
        const line = args.map((v) => String(v)).join(' ');
        logs.push(line);
        rawLog.apply(console, args);
    };

    const server = await bootstrap();
    try {
        const baseUrl = `http://127.0.0.1:${process.env.H5_PORT}`;
        await waitForPing(baseUrl, headers);

        const res = await fetch(`${baseUrl}/api/products/account-switch/toggle`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                game_account: 'guard_log_acc',
                game_id: '1',
                game_name: 'WZRY',
                switch_key: 'prod_guard',
                enabled: false
            })
        });
        const out = await res.json();
        assert.strictEqual(res.status, 200, 'toggle 应返回 200');
        assert.strictEqual(out.ok, true, 'toggle ok 应为 true');
        assert.strictEqual(Boolean(out.data && out.data.prod_guard_enabled), false, 'prod_guard_enabled 应关闭');

        const row = await getAliveUserGameAccountByUserAndAccount(user.id, 'guard_log_acc');
        assert.ok(row, '账号应存在');
        assert.strictEqual(Boolean((((row || {}).switch || {}).prod_guard || {}).enabled), false, '账号开关应已关闭');

        const hit = logs.find((line) => line.includes('[H5][ProdGuardSwitch]') && line.includes('game_account=guard_log_acc'));
        assert.ok(hit, '应输出 prod guard switch 日志');
        assert.ok(hit.includes('before=true'), '日志应包含 before=true');
        assert.ok(hit.includes('after=false'), '日志应包含 after=false');
        assert.ok(hit.includes('changed=true'), '日志应包含 changed=true');

        console.log(`[PASS] h5_prod_guard_toggle_log_smoke_test temp_dir=${tempDir}`);
    } finally {
        console.log = rawLog;
        try { await new Promise((resolve) => server.close(resolve)); } catch {}
        try { stopProdRiskTaskWorker(); } catch {}
    }
}

main().catch((err) => {
    console.error(`[FAIL] h5_prod_guard_toggle_log_smoke_test: ${err.message}`);
    process.exit(1);
});
