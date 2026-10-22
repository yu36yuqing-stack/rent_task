#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sourcePath = path.join(__dirname, '../h5/public/js/app_core.js');
const source = fs.readFileSync(sourcePath, 'utf8');
const start = source.indexOf('    async function request(');
const end = source.indexOf('    async function login(', start);
assert(start >= 0 && end > start, 'extract the actual shared request function, not a copied implementation');
// Preserve original source coordinates so c8 can attribute the exercised error lines.
const requestSource = source.slice(0, start).replace(/[^\n]/g, ' ') + source.slice(start, end);

function response(status, data = {}) {
    return { status, ok: status >= 200 && status < 300, json: async () => data };
}

function harness() {
    const calls = [];
    const counts = { begin: 0, end: 0, refresh: 0, clear: 0, render: 0 };
    const queue = [];
    const context = {
        API_BASE: '/h5local', state: { token: 'access-old' },
        URLSearchParams, ArrayBuffer,
        FormData: class FormData {},
        beginGlobalRequestLoading: () => { counts.begin += 1; },
        endGlobalRequestLoading: async () => { counts.end += 1; },
        clearAuthState: () => { counts.clear += 1; context.state.token = ''; },
        render: () => { counts.render += 1; },
        tryRefreshAccessToken: async () => { counts.refresh += 1; context.state.token = 'access-new'; },
        fetch: async (url, options) => {
            calls.push({ url, options });
            assert(queue.length > 0, `unexpected fetch ${url}`);
            const next = queue.shift();
            if (next instanceof Error) throw next;
            return next;
        }
    };
    vm.createContext(context);
    vm.runInContext(requestSource, context, { filename: sourcePath });
    return { context, queue, calls, counts };
}

async function captureError(operation) {
    try {
        await operation();
        assert.fail('expected request rejection');
    } catch (error) {
        if (error.code === 'ERR_ASSERTION') throw error;
        return error;
    }
}

async function testSuccessAndBodyContracts() {
    const h = harness();
    const body = { count_mode: 'business_day', enabled: true };
    const controller = new AbortController();
    const data = { ok: true, feature: { count_mode: 'business_day', version: 4 } };
    h.queue.push(response(200, data));
    const out = await h.context.request('/api/pricing/ladder/feature', { method: 'POST', headers: { 'X-Trace': 'trace-1' }, signal: controller.signal, body });
    assert.strictEqual(out, data);
    assert.strictEqual(h.calls[0].url, '/h5local/api/pricing/ladder/feature');
    assert.strictEqual(h.calls[0].options.body, JSON.stringify(body));
    assert.strictEqual(h.calls[0].options.headers.Authorization, 'Bearer access-old');
    assert.strictEqual(h.calls[0].options.headers['X-Trace'], 'trace-1');
    assert.strictEqual(h.calls[0].options.signal, controller.signal, 'request preserves the timeout abort signal');
    assert.deepStrictEqual(body, { count_mode: 'business_day', enabled: true });
    assert.deepStrictEqual(h.counts, { begin: 1, end: 1, refresh: 0, clear: 0, render: 0 });

    h.context.state.token = '';
    for (const special of [new h.context.FormData(), new URLSearchParams({ a: 1 }), new Uint8Array([1, 2]), new ArrayBuffer(4), 'already serialized']) {
        h.queue.push(response(200, { ok: true }));
        await h.context.request('/api/fixture', { method: 'POST', body: special });
        assert.strictEqual(h.calls.at(-1).options.body, special);
        assert.strictEqual(h.calls.at(-1).options.headers.Authorization, undefined);
    }
    const textBody = { unchanged: true };
    h.queue.push(response(200));
    await h.context.request('/api/fixture', { headers: { 'Content-Type': 'text/plain' }, body: textBody });
    assert.strictEqual(h.calls.at(-1).options.body, textBody);
}

async function testHttpErrorsCarryOnlyRealStatus() {
    for (const status of [400, 409, 500]) {
        const h = harness();
        h.queue.push(response(status, { ok: false, message: `服务端拒绝-${status}` }));
        const error = await captureError(() => h.context.request('/api/pricing/ladder/feature'));
        assert.strictEqual(error.message, `服务端拒绝-${status}`);
        assert.strictEqual(error.status, status);
        assert.deepStrictEqual(h.counts, { begin: 1, end: 1, refresh: 0, clear: 0, render: 0 });
    }
    const h = harness();
    h.queue.push(response(200, { ok: false, message: '业务校验未通过' }));
    const error = await captureError(() => h.context.request('/api/fixture'));
    assert.strictEqual(error.status, 200, 'business failure must not be relabeled as HTTP 400');
    assert.strictEqual(error.message, '业务校验未通过');
    const malformed = { ...response(400), json: async () => { throw new Error('invalid json'); } };
    h.queue.push(malformed);
    const fallback = await captureError(() => h.context.request('/api/fixture'));
    assert.strictEqual(fallback.message, '请求失败(400)');
    assert.strictEqual(fallback.status, 400);
    h.queue.push({ ...response(200), json: async () => { throw new Error('invalid json'); } });
    assert.deepStrictEqual(JSON.parse(JSON.stringify(await h.context.request('/api/fixture'))), {});
}

async function testNetworkFailureDoesNotInventHttpStatus() {
    const h = harness();
    const network = new Error('fetch failed');
    h.queue.push(network);
    const error = await captureError(() => h.context.request('/api/pricing/ladder/feature'));
    assert.strictEqual(error, network);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(error, 'status'), false);
    assert.deepStrictEqual(h.counts, { begin: 1, end: 1, refresh: 0, clear: 0, render: 0 });
}

async function testRefreshSuccessRetriesExactlyOnceWithNewToken() {
    const h = harness();
    const body = { count_mode: 'business_day', expected_version: 3 };
    const controller = new AbortController();
    const data = { ok: true, feature: { version: 4 } };
    h.queue.push(response(401), response(200, data));
    assert.strictEqual(await h.context.request('/api/pricing/ladder/feature', { method: 'POST', body, signal: controller.signal }), data);
    assert.strictEqual(h.calls.length, 2);
    assert.strictEqual(h.calls[0].options.headers.Authorization, 'Bearer access-old');
    assert.strictEqual(h.calls[1].options.headers.Authorization, 'Bearer access-new');
    assert.strictEqual(h.calls[0].options.body, JSON.stringify(body));
    assert.strictEqual(h.calls[1].options.body, JSON.stringify(body));
    assert.strictEqual(h.calls[0].options.signal, controller.signal);
    assert.strictEqual(h.calls[1].options.signal, controller.signal, '401 retry must preserve the abort signal too');
    assert.deepStrictEqual(h.counts, { begin: 1, end: 1, refresh: 1, clear: 0, render: 0 });

    const retryFailure = harness();
    retryFailure.queue.push(response(401), response(409, { message: '重试时版本冲突' }));
    const error = await captureError(() => retryFailure.context.request('/api/pricing/ladder/feature'));
    assert.strictEqual(error.status, 409);
    assert.strictEqual(error.message, '重试时版本冲突');
    assert.strictEqual(retryFailure.counts.refresh, 1);
    assert.strictEqual(retryFailure.counts.end, 1);

    for (const bodyFactory of [h => new h.context.FormData(), () => new URLSearchParams({ a: 1 }),
        () => new Uint8Array([1]), () => new ArrayBuffer(4), () => 'serialized']) {
        const special = harness();
        const specialBody = bodyFactory(special);
        special.queue.push(response(401), response(200, { ok: true }));
        await special.context.request('/api/fixture', { method: 'POST', body: specialBody });
        assert.strictEqual(special.calls[1].options.body, specialBody, 'refresh retries preserve special request bodies');
    }
    const text = harness();
    const unconverted = { fixture: true };
    text.queue.push(response(401), response(200));
    await text.context.request('/api/fixture', { headers: { 'Content-Type': 'text/plain' }, body: unconverted });
    assert.strictEqual(text.calls[1].options.body, unconverted);
}

async function testRefreshFailurePreservesAuthenticationBehavior() {
    const h = harness();
    const failure = new Error('登录已过期，请重新登录');
    h.context.tryRefreshAccessToken = async () => { h.counts.refresh += 1; throw failure; };
    h.queue.push(response(401));
    const error = await captureError(() => h.context.request('/api/fixture'));
    assert.strictEqual(error, failure);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(error, 'status'), false);
    assert.strictEqual(h.context.state.token, '');
    assert.strictEqual(h.calls.length, 1);
    assert.deepStrictEqual(h.counts, { begin: 1, end: 1, refresh: 1, clear: 1, render: 1 });
}

async function testNoRefreshLoopsOrRefreshOnAuthenticationRoutes() {
    for (const route of ['/api/login', '/api/refresh']) {
        const h = harness();
        h.queue.push(response(401, { message: '凭证错误' }));
        const error = await captureError(() => h.context.request(route));
        assert.strictEqual(error.status, 401);
        assert.strictEqual(error.message, '凭证错误');
        assert.strictEqual(h.counts.refresh, 0);
    }
    const noRetry = harness();
    noRetry.queue.push(response(401));
    assert.strictEqual((await captureError(() => noRetry.context.request('/api/fixture', {}, true))).status, 401);
    assert.strictEqual(noRetry.counts.refresh, 0);
    const twice = harness();
    twice.queue.push(response(401), response(401));
    assert.strictEqual((await captureError(() => twice.context.request('/api/fixture'))).status, 401);
    assert.strictEqual(twice.calls.length, 2);
    assert.strictEqual(twice.counts.refresh, 1);
}

async function testBackgroundRequestsSkipSpinnerWithoutChangingErrorsOrRefresh() {
    const rejected = harness();
    const controller = new AbortController();
    rejected.queue.push(response(400, { message: '后台参数校验失败' }));
    const error = await captureError(() => rejected.context.request('/api/pricing/ladder', { background: true, signal: controller.signal }));
    assert.strictEqual(error.status, 400);
    assert.strictEqual(error.message, '后台参数校验失败');
    assert.deepStrictEqual(rejected.counts, { begin: 0, end: 0, refresh: 0, clear: 0, render: 0 });
    assert.strictEqual(Object.prototype.hasOwnProperty.call(rejected.calls[0].options, 'background'), false);
    assert.strictEqual(rejected.calls[0].options.signal, controller.signal);

    const refreshed = harness();
    const data = { ok: true, feature: { version: 4 } };
    refreshed.queue.push(response(401), response(200, data));
    const options = { background: true, signal: controller.signal };
    assert.strictEqual(await refreshed.context.request('/api/pricing/ladder', options), data);
    assert.deepStrictEqual(refreshed.counts, { begin: 0, end: 0, refresh: 1, clear: 0, render: 0 });
    for (const call of refreshed.calls) {
        assert.strictEqual(Object.prototype.hasOwnProperty.call(call.options, 'background'), false);
        assert.strictEqual(call.options.signal, controller.signal);
    }
    assert.strictEqual(options.background, true, 'request does not mutate caller options');
    assert.strictEqual(refreshed.calls[1].options.headers.Authorization, 'Bearer access-new');

    const network = harness();
    const failure = new Error('offline');
    network.queue.push(failure);
    assert.strictEqual(await captureError(() => network.context.request('/api/pricing/ladder', { background: true })), failure);
    assert.deepStrictEqual(network.counts, { begin: 0, end: 0, refresh: 0, clear: 0, render: 0 });
    const foreground = harness();
    foreground.queue.push(response(200));
    await foreground.context.request('/api/pricing/ladder', { background: false });
    assert.strictEqual(foreground.counts.begin, 1);
    assert.strictEqual(foreground.counts.end, 1);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(foreground.calls[0].options, 'background'), false);
}

async function main() {
    await testSuccessAndBodyContracts();
    await testHttpErrorsCarryOnlyRealStatus();
    await testNetworkFailureDoesNotInventHttpStatus();
    await testRefreshSuccessRetriesExactlyOnceWithNewToken();
    await testRefreshFailurePreservesAuthenticationBehavior();
    await testNoRefreshLoopsOrRefreshOnAuthenticationRoutes();
    await testBackgroundRequestsSkipSpinnerWithoutChangingErrorsOrRefresh();
    console.log('[OK] pricing_request_error_metadata_smoke_test passed: HTTP metadata, network distinction and unchanged 401 refresh');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
