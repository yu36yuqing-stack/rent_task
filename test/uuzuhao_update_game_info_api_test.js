#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { updateProductGameInfo } = require('../uuzuhao/uuzuhao_api');

const auth = {
    app_key: 'update-game-info-fixture-key',
    app_secret: 'update-game-info-fixture-secret',
    api_base: 'https://fixture.invalid',
    timeout_ms: 100
};
const productId = '202601141000819243';
const endpoint = '/api/youpin/rent-connector/product/v1/updateProductGameInfo';

function reply(body, status = 200) {
    return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => JSON.stringify(body)
    };
}

function expectedSign(body) {
    const unsigned = { appKey: body.appKey, productId: body.productId, timestamp: body.timestamp };
    const source = Object.keys(unsigned).sort().map(key => `${key}=${unsigned[key]}`).join('&');
    return crypto.createHash('md5').update(source + auth.app_secret).digest('hex').toUpperCase();
}

async function main() {
    const originalFetch = global.fetch;
    const originalNow = Date.now;
    const originalConsole = Object.fromEntries(['log', 'warn', 'error', 'info', 'debug'].map(key => [key, console[key]]));
    const calls = [];
    const logs = [];
    let response = reply({ code: 0, data: {} });
    let cases = 0;
    // Every API request terminates at this fixture; no real fetch is reachable.
    global.fetch = async (url, options) => {
        calls.push({ url, options });
        assert.strictEqual(url, auth.api_base + endpoint);
        return typeof response === 'function' ? response(url, options) : response;
    };
    for (const key of Object.keys(originalConsole)) console[key] = (...args) => logs.push({ key, args });
    try {
        for (const invalid of [undefined, null, '', ' \n\t ', 0, 123, Number(productId), 1n, true, false, {}, [], [productId], new String(productId)]) {
            calls.length = 0;
            await assert.rejects(() => updateProductGameInfo(invalid, { auth }), /productId.*字符串/);
            assert.strictEqual(calls.length, 0, 'invalid IDs must fail before network or signing');
            cases += 1;
        }

        for (const options of [undefined, {}, { auth: {} }, { auth: { app_key: auth.app_key } }]) {
            calls.length = 0;
            await assert.rejects(() => updateProductGameInfo(productId, options), /app_key|app_secret/);
            assert.strictEqual(calls.length, 0, 'missing credentials must fail before network');
            cases += 1;
        }

        Date.now = () => 1794200000123;
        const fixture = {
            code: 0,
            msg: '成功',
            timestamp: 1794200000456,
            data: {
                productItemInfoList: productId,
                productItemNum: 1,
                gameAccountInfoList: [{ itemName: 'fixture-sensitive-field', itemValue: 'fixture-sensitive-value' }],
                unknownField: { version: 2, enabled: false }
            },
            traceFixture: 'fixture-trace'
        };
        response = reply(fixture);
        calls.length = 0;
        const result = await updateProductGameInfo(`  ${productId}\n`, { auth, game_id: 99, ignored: 'do-not-send' });
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].options.method, 'POST');
        assert.deepStrictEqual(calls[0].options.headers, { 'Content-Type': 'application/json; charset=UTF-8' });
        assert(calls[0].options.signal instanceof AbortSignal, 'request must have an abort signal');
        const body = JSON.parse(calls[0].options.body);
        assert.deepStrictEqual(Object.keys(body).sort(), ['appKey', 'productId', 'sign', 'timestamp']);
        assert.strictEqual(body.productId, productId, '18-digit ID must retain exact string precision');
        assert.strictEqual(body.appKey, auth.app_key);
        assert.strictEqual(body.timestamp, 1794200000, 'request timestamp must be seconds, not milliseconds');
        assert.strictEqual(body.sign, expectedSign(body), 'independent MD5 calculation must match');
        assert(!calls[0].options.body.includes(auth.app_secret), 'secret must not be sent as a business field');
        assert.deepStrictEqual(result, { product_id: productId, data: fixture.data, raw: fixture });
        assert.strictEqual(typeof result.data.productItemInfoList, 'string', 'documented string must not become an array');
        assert.deepStrictEqual(result.data.unknownField, fixture.data.unknownField, 'unknown fields must survive');
        cases += 1;
        Date.now = originalNow;

        for (const data of [null, false, 0, '', 'opaque-data', [], [{ itemName: 'name', itemValue: 'value' }], {}]) {
            response = reply({ code: 0, data });
            calls.length = 0;
            const out = await updateProductGameInfo(productId, { auth });
            assert.strictEqual(calls.length, 1);
            assert.deepStrictEqual(out.data, data, 'data must retain its original JSON type and content');
            assert.deepStrictEqual(out.raw, { code: 0, data });
            cases += 1;
        }
        response = reply({ code: 0 });
        const missingData = await updateProductGameInfo(productId, { auth });
        assert.strictEqual(missingData.data, undefined);
        assert.deepStrictEqual(missingData.raw, { code: 0 });
        cases += 1;

        for (const failure of [
            { code: 12101001, msg: 'fixture 商品不存在', data: null },
            { code: 4001, msg: 'fixture 授权失败', details: { retryable: false } },
            { code: '0', msg: 'unexpected string success code' }
        ]) {
            response = reply(failure);
            calls.length = 0;
            await assert.rejects(() => updateProductGameInfo(productId, { auth }), error => {
                assert.strictEqual(error.code, String(failure.code));
                assert.deepStrictEqual(error.uuzuhao_response, failure);
                assert(error.message.includes(failure.msg));
                return true;
            });
            assert.strictEqual(calls.length, 1, 'business failure must not retry an update');
            cases += 1;
        }

        for (const [status, failure] of [
            [401, { code: 7001, msg: 'fixture unauthorized' }],
            [404, { code: 84004, msg: 'Not Found' }],
            [503, { code: 0 }]
        ]) {
            response = reply(failure, status);
            calls.length = 0;
            await assert.rejects(() => updateProductGameInfo(productId, { auth }), error => {
                assert(error.message.includes(`HTTP ${status}`));
                assert.strictEqual(error.code, String(failure.code || status));
                assert.deepStrictEqual(error.uuzuhao_response, failure);
                return true;
            });
            assert.strictEqual(calls.length, 1, 'HTTP failure must not retry');
            cases += 1;
        }

        for (const status of [200, 502]) {
            response = { ok: status === 200, status, text: async () => '<html>fixture-not-json</html>' };
            calls.length = 0;
            await assert.rejects(() => updateProductGameInfo(productId, { auth }), /API 返回非JSON/);
            assert.strictEqual(calls.length, 1, 'invalid responses must not retry');
            cases += 1;
        }

        const networkError = new TypeError('fixture network failure');
        response = async () => { throw networkError; };
        calls.length = 0;
        await assert.rejects(() => updateProductGameInfo(productId, { auth }), error => error === networkError);
        assert.strictEqual(calls.length, 1, 'network errors must not retry');
        cases += 1;

        const bodyError = new Error('fixture response body read failed');
        response = { ok: true, status: 200, text: async () => { throw bodyError; } };
        calls.length = 0;
        await assert.rejects(() => updateProductGameInfo(productId, { auth }), error => error === bodyError);
        assert.strictEqual(calls.length, 1);
        cases += 1;

        let observedAbort = false;
        response = (_url, options) => new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => {
                observedAbort = true;
                reject(new DOMException('fixture timeout; remote outcome unknown', 'AbortError'));
            }, { once: true });
        });
        calls.length = 0;
        await assert.rejects(() => updateProductGameInfo(productId, { auth: { ...auth, timeout_ms: 5 } }), error => error.name === 'AbortError');
        assert.strictEqual(observedAbort, true, 'timeout must abort the request');
        assert.strictEqual(calls.length, 1, 'timeout must not retry an update with an unknown remote outcome');
        cases += 1;

        assert.deepStrictEqual(logs, [], 'API must not log response values or credentials on success/failure');
    } finally {
        global.fetch = originalFetch;
        Date.now = originalNow;
        Object.assign(console, originalConsole);
    }
    console.log(`[PASS] uuzuhao_update_game_info_api_test: ${cases} cases, all HTTP stubbed`);
}

main().catch(error => {
    console.error(`[FAIL] ${error.stack || error.message}`);
    process.exitCode = 1;
});
