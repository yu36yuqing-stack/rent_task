#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-h5-auth-channel-toggle-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');
process.env.ORDER_DB_FILE_PATH = path.join(tempDir, 'rent_robot_order.db');
process.env.STATS_DB_FILE_PATH = path.join(tempDir, 'rent_robot_stats.db');
process.env.PRICE_DB_FILE_PATH = path.join(tempDir, 'rent_robot_price.db');
process.env.SHEEP_FIX_ENABLE = '0';
process.env.USER_PIPELINE_LOCK_WAIT_MS = '0';
process.env.STATS_REFRESH_LOCK_POLL_MS = '200';
process.env.BL_V2_INSPECTOR_ENABLE = '0';
process.env.H5_PORT = String(22080 + Math.floor(Math.random() * 1000));

const { createUserByAdmin } = require('../database/user_db');
const { createAccessToken } = require('../user/auth_token');
const { upsertUserPlatformAuth } = require('../database/user_platform_auth_db');
const { bootstrap } = require('../h5/local_h5_server');
const { stopProdRiskTaskWorker } = require('../product/prod_status_guard');

function assertTrue(cond, msg) {
    if (!cond) throw new Error(msg);
}

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
        account: 'h5_auth_toggle_user',
        password: '123456',
        name: 'H5 Auth Toggle User',
        user_type: '外部',
        status: 'enabled',
        desc: 'h5 auth channel toggle smoke'
    });
    await upsertUserPlatformAuth({
        user_id: user.id,
        platform: 'uhaozu',
        auth_type: 'cookie',
        auth_payload: { cookie: 'foo=bar' },
        auth_status: 'valid',
        desc: 'seed uhaozu auth for h5'
    });

    const token = createAccessToken(user);
    const headers = {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
    };
    const server = await bootstrap();
    try {
        const baseUrl = `http://127.0.0.1:${process.env.H5_PORT}`;
        await waitForPing(baseUrl, headers);

        const beforeRes = await fetch(`${baseUrl}/api/auth/platforms?with_payload=1`, { headers });
        const beforeJson = await beforeRes.json();
        assertTrue(beforeRes.ok && beforeJson.ok, '获取授权列表失败');
        const before = (beforeJson.data || []).find((row) => String((row && row.platform) || '') === 'uhaozu');
        assertTrue(before && before.channel_enabled === true, '初始渠道应为启用');

        const toggleRes = await fetch(`${baseUrl}/api/auth/platforms/toggle-channel`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ platform: 'uhaozu', channel_enabled: false })
        });
        const toggleJson = await toggleRes.json();
        assertTrue(toggleRes.ok && toggleJson.ok, '切换渠道接口失败');
        assertTrue(toggleJson.data && toggleJson.data.row && toggleJson.data.row.channel_enabled === false, '切换后应返回停用状态');

        const afterRes = await fetch(`${baseUrl}/api/auth/platforms?with_payload=1`, { headers });
        const afterJson = await afterRes.json();
        assertTrue(afterRes.ok && afterJson.ok, '再次获取授权列表失败');
        const after = (afterJson.data || []).find((row) => String((row && row.platform) || '') === 'uhaozu');
        assertTrue(after && after.channel_enabled === false, '列表视图应反映停用状态');
        assertTrue(String(after.toggle_text || '') === '开启渠道', '停用后按钮文案应为开启渠道');

        console.log(`[PASS] h5_auth_channel_toggle_smoke_test temp_dir=${tempDir}`);
    } finally {
        try { await new Promise((resolve) => server.close(resolve)); } catch {}
        try { stopProdRiskTaskWorker(); } catch {}
    }
}

main().catch((err) => {
    console.error(`[FAIL] h5_auth_channel_toggle_smoke_test: ${err.message}`);
    process.exit(1);
});
