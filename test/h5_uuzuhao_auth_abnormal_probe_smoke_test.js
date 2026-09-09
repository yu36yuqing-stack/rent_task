#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-h5-uuzuhao-auth-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');
process.env.ORDER_DB_FILE_PATH = path.join(tempDir, 'rent_robot_order.db');
process.env.STATS_DB_FILE_PATH = path.join(tempDir, 'rent_robot_stats.db');
process.env.PRICE_DB_FILE_PATH = path.join(tempDir, 'rent_robot_price.db');
process.env.SHEEP_FIX_ENABLE = '0';
process.env.H5_PORT = String(21080 + Math.floor(Math.random() * 1000));
process.env.USER_PIPELINE_LOCK_WAIT_MS = '0';
process.env.STATS_REFRESH_LOCK_POLL_MS = '200';
process.env.BL_V2_INSPECTOR_ENABLE = '0';

const { createUserByAdmin } = require('../database/user_db');
const { createAccessToken } = require('../user/auth_token');
const { upsertUserGameAccount } = require('../database/user_game_account_db');
const { upsertUserPlatformAuth } = require('../database/user_platform_auth_db');
const reconciler = require('../blacklist/blacklist_reconciler');
let blacklistMode = 3;
reconciler.getBlacklistV2Mode = () => blacklistMode;
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
        account: 'h5_uuzuhao_auth',
        password: '123456',
        name: 'H5 Uuzuhao Auth',
        user_type: '外部',
        status: 'enabled',
        desc: 'h5 uuzuhao auth abnormal smoke'
    });
    await upsertUserGameAccount({
        user_id: user.id,
        game_id: '1',
        game_name: 'WZRY',
        game_account: 'auth_account',
        account_remark: '授权异常账号',
        channel_status: { uuzuhao: '下架' },
        channel_prd_info: {
            uuzuhao: {
                reason: '授权失效',
                off_type: 'AUTHORIZE_ERROR',
                tab_key: 'OFF',
                product_status: 2100
            }
        },
        desc: 'seed auth abnormal account'
    });
    const headers = {
        Authorization: `Bearer ${createAccessToken(user)}`,
        'Content-Type': 'application/json'
    };

    await upsertUserPlatformAuth({ user_id: user.id, platform: 'uuzuhao', auth_type: 'token', auth_status: 'valid',
        auth_payload: { app_key: 'fixture', app_secret: 'fixture', api_base: 'https://fixture.invalid' } });
    const realFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, options) => {
        if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, options);
        assert.ok(String(url).startsWith('https://fixture.invalid/'));
        calls.push({ url, body: JSON.parse(options.body) });
        return { ok: true, status: 200, text: async () => JSON.stringify({ code: 500, msg: 'offType=ACCOUNT_ERROR' }) };
    };

    const server = await bootstrap();
    try {
        const baseUrl = `http://127.0.0.1:${process.env.H5_PORT}`;
        await waitForPing(baseUrl, headers);

        for (const endpoint of ['/api/products/online', '/api/products/forbidden/query', '/api/products/forbidden/play']) {
            const body = endpoint.endsWith('/play')
                ? { game_account: 'auth_account', game_name: 'WZRY', enabled: true }
                : { game_account: 'auth_account', game_name: 'WZRY' };
            const res = await fetch(`${baseUrl}${endpoint}`, {
                method: 'POST',
                headers,
                body: JSON.stringify(body)
            });
            const out = await res.json();
            assert.strictEqual(res.status, 502, `${endpoint} 应展示真实上游错误`);
            assert.strictEqual(out.ok, false, `${endpoint} ok 应为 false`);
            assert.ok(String(out.message || '').includes('ACCOUNT_ERROR'), `${endpoint} 应包含真实上游错误`);
        }
        assert.strictEqual(calls.length, 3, '手工请求不得被本地授权异常标记阻断');
        blacklistMode = 1;
        for (const endpoint of ['/api/blacklist/remove', '/api/products/maintenance/toggle', '/api/products/steam-guard-code']) {
            const res = await fetch(`${baseUrl}${endpoint}`, { method: 'POST', headers,
                body: JSON.stringify({ game_account: 'auth_account', game_id: endpoint.endsWith('steam-guard-code') ? '4' : '1', enabled: false }) });
            const out = await res.json();
            assert.ok([200, 409, 502].includes(res.status), JSON.stringify(out));
        }
        assert.strictEqual(calls.length, 6, '手工黑名单、结束维护、令牌码同样应到达接口');

        console.log(`[PASS] h5_uuzuhao_auth_abnormal_probe_smoke_test temp_dir=${tempDir}`);
    } finally {
        try { await new Promise((resolve) => server.close(resolve)); } catch {}
        try { stopProdRiskTaskWorker(); } catch {}
        global.fetch = realFetch;
    }
}

main().catch((err) => {
    console.error(`[FAIL] h5_uuzuhao_auth_abnormal_probe_smoke_test: ${err.message}`);
    process.exit(1);
});
