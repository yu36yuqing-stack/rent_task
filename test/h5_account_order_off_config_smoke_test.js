#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-h5-account-order-off-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');
process.env.ORDER_DB_FILE_PATH = path.join(tempDir, 'rent_robot_order.db');
process.env.STATS_DB_FILE_PATH = path.join(tempDir, 'rent_robot_stats.db');
process.env.PRICE_DB_FILE_PATH = path.join(tempDir, 'rent_robot_price.db');
process.env.SHEEP_FIX_ENABLE = '0';
process.env.USER_PIPELINE_LOCK_WAIT_MS = '0';
process.env.STATS_REFRESH_LOCK_POLL_MS = '200';
process.env.BL_V2_INSPECTOR_ENABLE = '0';
process.env.H5_PORT = String(23080 + Math.floor(Math.random() * 1000));

const { createUserByAdmin } = require('../database/user_db');
const { createAccessToken } = require('../user/auth_token');
const { upsertUserRuleByName } = require('../database/user_rule_db');
const { upsertUserGameAccount } = require('../database/user_game_account_db');
const { bootstrap } = require('../h5/local_h5_server');
const { stopProdRiskTaskWorker } = require('../product/prod_status_guard');

function assertTrue(cond, msg) {
    if (!cond) throw new Error(msg);
}

function assertEqual(actual, expected, msg) {
    if (actual !== expected) throw new Error(`${msg} | actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
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
        account: 'h5_account_order_off_user',
        password: '123456',
        name: 'H5 Account Order Off User',
        user_type: '外部',
        status: 'enabled',
        desc: 'h5 account order off smoke'
    });
    await upsertUserRuleByName(user.id, {
        rule_name: 'X单下架阈值',
        rule_detail: {
            threshold: 4,
            mode: 'natural_day'
        }
    }, { desc: 'seed global order off rule' });
    await upsertUserGameAccount({
        user_id: user.id,
        game_account: '2147515620',
        game_id: '1',
        game_name: 'WZRY',
        account_remark: '吴小张',
        channel_status: {
            uuzuhao: '上架'
        },
        desc: 'seed product row'
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

        const saveRes = await fetch(`${baseUrl}/api/products/account-order-off-config`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                game_account: '2147515620',
                game_id: '1',
                game_name: 'WZRY',
                follow_global: false,
                threshold: 2,
                mode: 'rolling_24h'
            })
        });
        const saveJson = await saveRes.json();
        assertTrue(saveRes.ok && saveJson.ok, '保存商品级 X 单下架配置失败');
        assertEqual(Number(saveJson.data && saveJson.data.threshold || 0), 2, '保存后应返回账号级阈值');
        assertEqual(String(saveJson.data && saveJson.data.config_source || ''), 'account', '保存后应返回账号级来源');

        const listRes = await fetch(`${baseUrl}/api/products?page=1&page_size=20`, { headers });
        const listJson = await listRes.json();
        assertTrue(listRes.ok && listJson.ok, '商品列表查询失败');
        const item = (listJson.list || []).find((row) => String((row && row.game_account) || '') === '2147515620');
        assertTrue(Boolean(item), '商品列表应包含目标账号');
        assertEqual(Number(item.order_off_threshold || 0), 2, '列表应显示账号级阈值');
        assertEqual(String(item.order_off_mode || ''), 'rolling_24h', '列表应显示账号级模式');
        assertEqual(String(item.order_off_config_source || ''), 'account', '列表应显示账号级来源');

        const clearRes = await fetch(`${baseUrl}/api/products/account-order-off-config`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                game_account: '2147515620',
                game_id: '1',
                game_name: 'WZRY',
                follow_global: true
            })
        });
        const clearJson = await clearRes.json();
        assertTrue(clearRes.ok && clearJson.ok, '切换为跟随全局失败');
        assertEqual(Number(clearJson.data && clearJson.data.threshold || 0), 4, '跟随全局后应回退到全局阈值');
        assertEqual(String(clearJson.data && clearJson.data.config_source || ''), 'global', '跟随全局后应回退到全局来源');

        const badThresholdRes = await fetch(`${baseUrl}/api/products/account-order-off-config`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                game_account: '2147515620',
                game_id: '1',
                game_name: 'WZRY',
                follow_global: false,
                threshold: 0,
                mode: 'rolling_24h'
            })
        });
        const badThresholdJson = await badThresholdRes.json();
        assertEqual(badThresholdRes.status, 400, '非法 threshold 应返回 400');
        assertEqual(String(badThresholdJson.message || ''), 'threshold 必须是 1~10 的整数', '非法 threshold 错误文案应正确');

        const badModeRes = await fetch(`${baseUrl}/api/products/account-order-off-config`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                game_account: '2147515620',
                game_id: '1',
                game_name: 'WZRY',
                follow_global: false,
                threshold: 2,
                mode: 'bad_mode'
            })
        });
        const badModeJson = await badModeRes.json();
        assertEqual(badModeRes.status, 400, '非法 mode 应返回 400');
        assertEqual(String(badModeJson.message || ''), 'mode 不支持', '非法 mode 错误文案应正确');

        console.log(`[PASS] h5_account_order_off_config_smoke_test temp_dir=${tempDir}`);
    } finally {
        try { await new Promise((resolve) => server.close(resolve)); } catch {}
        try { stopProdRiskTaskWorker(); } catch {}
    }
}

main().catch((err) => {
    console.error(`[FAIL] h5_account_order_off_config_smoke_test: ${err.message}`);
    process.exit(1);
});
