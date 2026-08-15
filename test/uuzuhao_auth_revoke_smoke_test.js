#!/usr/bin/env node
'use strict';

const crypto = require('crypto');
const { revokeAccountAuth } = require('../uuzuhao/uuzuhao_api');

function assertEqual(actual, expected, message) {
    if (actual !== expected) {
        throw new Error(`${message}: expected=${JSON.stringify(expected)}, actual=${JSON.stringify(actual)}`);
    }
}

async function assertRejects(run, expectedMessage, message) {
    let error = null;
    try {
        await run();
    } catch (err) {
        error = err;
    }
    if (!error || !String(error.message || '').includes(expectedMessage)) {
        throw new Error(`${message}: expected error containing ${JSON.stringify(expectedMessage)}`);
    }
}

function expectedSign(payload, secret) {
    const source = Object.keys(payload)
        .sort()
        .map(key => {
            const value = typeof payload[key] === 'object' ? JSON.stringify(payload[key]) : String(payload[key]);
            return `${key}=${value}`;
        })
        .join('&');
    return crypto.createHash('md5').update(`${source}${secret}`, 'utf8').digest('hex').toUpperCase();
}

async function main() {
    await assertRejects(
        () => revokeAccountAuth('', { game_id: 1, auth: {} }),
        'accountNo 不能为空',
        '空账号应在发请求前失败'
    );
    await assertRejects(
        () => revokeAccountAuth('123456', { auth: {} }),
        'game_id 必填且必须是正整数',
        '缺少 game_id 应在发请求前失败'
    );
    const originalFetch = global.fetch;
    const originalNow = Date.now;
    const captured = [];
    Date.now = () => 1786600000123;
    global.fetch = async (url, options = {}) => {
        captured.push({ url: String(url), options });
        return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ code: 0, msg: 'success', data: null })
        };
    };

    const auth = {
        app_key: 'test-app-key',
        app_secret: 'test-app-secret',
        api_base: 'https://uuzuhao.example.test'
    };

    try {
        const result = await revokeAccountAuth('  123456789  ', { game_id: 1, auth });
        assertEqual(captured.length, 1, '成功调用应只发送一次请求');
        assertEqual(
            captured[0].url,
            'https://uuzuhao.example.test/api/youpin/rent-connector/product/v1/interconnect/auth/revoke',
            '应调用解除授权接口'
        );
        assertEqual(captured[0].options.method, 'POST', '应使用 POST');
        assertEqual(
            captured[0].options.headers['Content-Type'],
            'application/json; charset=UTF-8',
            '应发送 JSON'
        );

        const body = JSON.parse(captured[0].options.body);
        assertEqual(body.accountNo, '123456789', '应清理 accountNo 两侧空格');
        assertEqual(body.gameId, 1, '应透传 gameId');
        assertEqual(body.appKey, auth.app_key, '应写入 appKey');
        assertEqual(body.timestamp, 1786600000, '应发送秒级时间戳');
        assertEqual(
            body.sign,
            expectedSign({
                accountNo: '123456789',
                appKey: auth.app_key,
                gameId: 1,
                timestamp: 1786600000
            }, auth.app_secret),
            '签名应覆盖解除授权业务参数'
        );
        assertEqual(result.account_no, '123456789', '结果应返回规范化账号');
        assertEqual(result.game_id, 1, '结果应返回 game_id');
        assertEqual(result.revoked, true, 'code=0 应标记解除成功');

        global.fetch = async () => ({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ code: 20001, msg: '解除授权失败' })
        });
        await assertRejects(
            () => revokeAccountAuth('123456789', { game_id: 1, auth }),
            'code=20001, msg=解除授权失败',
            '平台业务失败应原样向上抛出'
        );

    } finally {
        global.fetch = originalFetch;
        Date.now = originalNow;
    }

    console.log('[PASS] uuzuhao_auth_revoke_smoke_test');
}

main().catch(err => {
    console.error(`[FAIL] ${err.stack || err.message}`);
    process.exit(1);
});
