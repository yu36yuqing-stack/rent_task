#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const frontendRoot = path.join(__dirname, '../h5/public/js');
const helperSource = fs.readFileSync(path.join(frontendRoot, 'ui/pricing_feature_state.js'), 'utf8');
const menuSource = fs.readFileSync(path.join(frontendRoot, 'menu_price.js'), 'utf8');
const featureState = require(path.join(frontendRoot, 'ui/pricing_feature_state.js'));

function feature(overrides = {}) {
    return { enabled: true, count_mode: 'rolling_24h', reconcile_required: false, version: 3, ...overrides };
}

function payload(settings = feature(), overrides = {}) {
    return {
        game_name: 'WZRY',
        feature: settings,
        count_mode: settings.count_mode,
        count_window: settings.count_mode === 'business_day' ? '每日06:00切日' : '近24小时',
        window_start: '2026-10-15T22:00:00Z',
        window_end: '2026-10-16T06:00:00Z',
        list: [{ game_account: 'demo', display_name: '示例账号', configured: true, current_tier: 1, desired_tier: 1, today_order_count: 2, prices: [2, 3, 4, 5] }],
        ...overrides
    };
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function node() {
    return {
        textContent: '', innerHTML: '', value: '', checked: false, disabled: false, hidden: false,
        dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
        querySelectorAll: () => [], setAttribute() {}, removeAttribute() {}
    };
}

function harness(initial = feature(), options = {}) {
    const names = ['pricingCountMode', 'pricingCountStatus', 'pricingWindowText', 'pricingWindowHelpSummary', 'pricingWindowHelpDescription'];
    const nodes = Object.fromEntries(names.map(name => [name, node()]));
    const toasts = [];
    const list = node();
    const toggle = node();
    const featureStatus = node();
    const context = {
        window: { confirm: () => true }, URLSearchParams, AbortController,
        setTimeout: options.timers ? options.timers.setTimeout : setTimeout,
        clearTimeout: options.timers ? options.timers.clearTimeout : clearTimeout,
        console,
        state: { user: { id: 10 }, currentMenu: 'pricing_uhaozu', pricing: {} },
        document: { getElementById: id => nodes[id] || null, activeElement: null },
        els: { pricingView: node(), pricingListContainer: list, pricingFeatureToggle: toggle, pricingFeatureStatus: featureStatus },
        showToast: value => toasts.push(String(value)),
        request: async () => { throw new Error('unexpected request'); }
    };
    vm.createContext(context);
    vm.runInContext(helperSource, context, { filename: path.join(frontendRoot, 'ui/pricing_feature_state.js') });
    vm.runInContext(menuSource, context, { filename: path.join(frontendRoot, 'menu_price.js') });
    context.applyPricingPayload(payload(initial));
    context.renderPricingView();
    return { context, nodes, toasts, list, toggle, featureStatus, get pricing() { return context.state.pricing; } };
}

function fakeTimers() {
    const tasks = new Map();
    let now = 0;
    let sequence = 0;
    return {
        setTimeout(callback, delay) {
            const handle = { id: ++sequence, unref() {} };
            tasks.set(handle, { callback, due: now + Number(delay || 0) });
            return handle;
        },
        clearTimeout(handle) { tasks.delete(handle); },
        get size() { return tasks.size; },
        async next() {
            const sorted = [...tasks.entries()].sort((a, b) => a[1].due - b[1].due || a[0].id - b[0].id);
            assert(sorted.length > 0, 'expected one pending timer');
            const [handle, task] = sorted[0];
            tasks.delete(handle);
            now = task.due;
            task.callback();
            // Flush the request, Promise.race, render, and rescheduling microtasks without wall-clock waiting.
            for (let i = 0; i < 20; i += 1) await Promise.resolve();
        }
    };
}

function assertStatus(h, expected) {
    assert.strictEqual(h.nodes.pricingCountStatus.textContent, expected);
    assert(['待生效', '已生效', '保存失败'].includes(h.nodes.pricingCountStatus.textContent));
    assert(['已开启', '已关闭'].includes(h.featureStatus.textContent));
}

function testFeatureStateContracts() {
    for (const invalid of [null, {}, { ...feature(), enabled: 1 }, { ...feature(), count_mode: '' },
        { ...feature(), reconcile_required: undefined }, { ...feature(), version: '3' },
        { ...feature(), version: -1 }, { ...feature(), version: Number.MAX_SAFE_INTEGER + 1 }]) {
        assert.strictEqual(featureState.read(invalid), null);
    }
    assert.deepStrictEqual(featureState.read({ ...feature(), unrelated: 'ignored' }), feature());
    assert.deepStrictEqual(featureState.merge(null, feature()), { accepted: true, feature: feature(), changed: false });
    assert.deepStrictEqual(featureState.merge(feature(), {}), { accepted: false, reason: 'unsupported' });
    assert.deepStrictEqual(featureState.merge(feature(), feature({ version: 2 })), { accepted: false, reason: 'stale' });
    assert.deepStrictEqual(featureState.merge(feature(), feature({ enabled: false })), { accepted: false, reason: 'conflict' });
    assert.deepStrictEqual(featureState.merge(feature(), feature({ reconcile_required: true })), { accepted: false, reason: 'stale' });
    assert.strictEqual(featureState.merge(feature(), feature({ version: 4, count_mode: 'business_day' })).changed, true);
    const intent = { enabled: true, count_mode: 'business_day', expected_version: 3 };
    assert.strictEqual(featureState.confirms(feature({ count_mode: 'business_day', version: 4 }), intent), true);
    assert.strictEqual(featureState.confirms(feature({ count_mode: 'business_day', version: 3 }), intent), false);
    assert.strictEqual(featureState.confirms(feature({ enabled: false, count_mode: 'business_day', version: 4 }), intent), false);
    assert.strictEqual(featureState.confirms(feature({ version: 4 }), intent), false);
    assert.strictEqual(featureState.confirms({}, intent), false);
    assert.strictEqual(featureState.confirms(feature(), null), false);
    assert.deepStrictEqual(featureState.status(feature(), { confirmed: true }), { key: 'effective', text: '已生效' });
    assert.deepStrictEqual(featureState.status(feature(), { failed: true }), { key: 'failed', text: '保存失败' });
    assert.strictEqual(featureState.status(feature()).text, '待生效');
    for (const options of [{ confirmed: true, saving: true }, { confirmed: true, uncertain: true }]) {
        assert.strictEqual(featureState.status(feature(), options).text, '待生效');
    }
    assert.strictEqual(featureState.status(feature({ enabled: false }), { confirmed: true }).text, '待生效');
    assert.strictEqual(featureState.status(feature({ reconcile_required: true }), { confirmed: true }).text, '待生效');
    assert.strictEqual(featureState.isRejected({ status: 400 }), true);
    assert.strictEqual(featureState.isRejected({ status: 409 }), true);
    assert.strictEqual(featureState.isRejected({ status: 500 }), false);
    assert.strictEqual(featureState.isRejected(new Error('timeout')), false);
    assert.strictEqual(featureState.isRejected(null), false);
}

async function testBoundedRequestsAbortAndIgnoreLateResponses() {
    const result = { ok: true };
    let received;
    assert.strictEqual(await featureState.withTimeout(async (url, options) => {
        received = { url, options };
        return result;
    }, '/api/fixture', { method: 'POST', body: '{}' }, 100), result);
    assert.strictEqual(received.url, '/api/fixture');
    assert.strictEqual(received.options.method, 'POST');
    assert.strictEqual(received.options.body, '{}');
    assert.strictEqual(received.options.signal.aborted, false);
    const original = new Error('network failed');
    await assert.rejects(() => featureState.withTimeout(async () => { throw original; }, '/api/fixture', {}, 100), error => error === original);
    const delayed = deferred();
    let timeoutSignal;
    const pending = featureState.withTimeout(async (_url, options) => {
        timeoutSignal = options.signal;
        return delayed.promise;
    }, '/api/fixture', {}, 1);
    let rejected = false;
    await assert.rejects(() => pending, error => {
        rejected = true;
        assert.strictEqual(Object.prototype.hasOwnProperty.call(error, 'status'), false);
        return /超时|timeout|abort/i.test(error.message);
    });
    assert.strictEqual(timeoutSignal.aborted, true);
    delayed.resolve({ ok: true, ignored: true });
    await Promise.resolve();
    assert.strictEqual(rejected, true);
    await assert.rejects(() => pending);
}

async function testThreeStatusLifecycleAndSavingLock() {
    const h = harness();
    assertStatus(h, '已生效');
    const post = deferred();
    const saved = feature({ count_mode: 'business_day', reconcile_required: true, version: 4 });
    const requests = [];
    h.context.request = async (url, options) => {
        requests.push({ url, body: options && options.method === 'POST' ? JSON.parse(options.body) : undefined });
        return options && options.method === 'POST' ? post.promise : payload(saved);
    };
    const saving = h.context.updatePricingCountMode('business_day');
    assert.strictEqual(h.nodes.pricingCountMode.value, 'business_day');
    assert.strictEqual(h.nodes.pricingCountMode.disabled, true);
    assert.strictEqual(h.toggle.disabled, true);
    assertStatus(h, '待生效');
    await h.context.updatePricingCountMode('rolling_24h');
    await h.context.updatePricingFeature(false);
    assert.strictEqual(requests.length, 1, 'saving locks both controls and suppresses duplicate writes');
    assert.deepStrictEqual(requests[0].body, { enabled: true, count_mode: 'business_day', expected_version: 3 });
    post.resolve({ feature: saved });
    await saving;
    assertStatus(h, '待生效');
    assert.strictEqual(h.nodes.pricingCountMode.disabled, false);
    assert.strictEqual(h.toggle.disabled, false);
    assert.strictEqual(h.nodes.pricingCountMode.value, 'business_day');
    assert.strictEqual(h.pricing.feature.version, 4);
    const countBefore = requests.length;
    await h.context.updatePricingCountMode('business_day');
    assert.strictEqual(requests.length, countBefore, 'saved pending mode does not resubmit');
    assert.strictEqual(h.context.applyPricingPayload(payload({ ...saved, reconcile_required: false })), true);
    h.context.renderPricingView();
    assertStatus(h, '已生效');
    h.context.applyPricingPayload(payload(feature({ enabled: false, count_mode: 'business_day', version: 5 })));
    h.context.renderPricingView();
    assertStatus(h, '待生效');
    assert.strictEqual(h.featureStatus.textContent, '已关闭');
}

async function testExplicitFailureRestoresSavedAndCanRetry() {
    const h = harness();
    h.context.request = async () => { throw Object.assign(new Error('配置已更新，请刷新后重试'), { status: 409, responseReceived: true }); };
    await h.context.updatePricingCountMode('business_day');
    assertStatus(h, '保存失败');
    assert.strictEqual(h.nodes.pricingCountMode.value, 'rolling_24h');
    assert.strictEqual(h.pricing.feature.version, 3);
    assert.strictEqual(h.toasts.at(-1), '配置已更新，请刷新后重试');
    assert.strictEqual(h.nodes.pricingCountMode.disabled, false);
    const next = feature({ count_mode: 'business_day', version: 4 });
    h.context.request = async (_url, options) => options && options.method === 'POST' ? { feature: next } : payload(next);
    await h.context.updatePricingCountMode('business_day');
    assertStatus(h, '已生效');
    assert.strictEqual(h.nodes.pricingCountMode.value, 'business_day');

    const validation = harness();
    validation.context.request = async () => { throw Object.assign(new Error('不支持该订单周期'), { status: 400, responseReceived: true }); };
    await validation.context.updatePricingCountMode('business_day');
    assertStatus(validation, '保存失败');
    assert.strictEqual(validation.nodes.pricingCountMode.value, 'rolling_24h');
}

async function testStaleResponsesNeverMergeOldCountsIntoNewMode() {
    const h = harness();
    const saved = feature({ count_mode: 'business_day', reconcile_required: true, version: 4 });
    h.context.request = async (_url, options) => options && options.method === 'POST'
        ? { feature: saved }
        : payload(feature(), { list: [{ game_account: 'stale', today_order_count: 99 }] });
    await h.context.updatePricingCountMode('business_day');
    assert.strictEqual(h.nodes.pricingCountMode.value, 'business_day');
    assert.strictEqual(h.pricing.feature.version, 4);
    assertStatus(h, '待生效');
    assert(!h.pricing.list.some(item => item.game_account === 'stale'));
    assert(!h.list.innerHTML.includes('99单'));
    const before = JSON.stringify({ feature: h.pricing.feature, list: h.pricing.list, count_mode: h.pricing.count_mode });
    assert.strictEqual(h.context.applyPricingPayload(payload(feature(), { list: [{ game_account: 'stale-direct' }] })), false);
    assert.strictEqual(JSON.stringify({ feature: h.pricing.feature, list: h.pricing.list, count_mode: h.pricing.count_mode }), before);
}

function testSameVersionConflictsAndReconcileCannotRegress() {
    const h = harness(feature({ reconcile_required: true }));
    const original = JSON.stringify(h.pricing.list);
    assert.strictEqual(h.context.applyPricingPayload(payload(feature({ count_mode: 'business_day', reconcile_required: true }), { list: [{ game_account: 'wrong-mode' }] })), false);
    assert.strictEqual(h.context.applyPricingPayload(payload(feature({ enabled: false, reconcile_required: true }), { list: [{ game_account: 'wrong-switch' }] })), false);
    assert.strictEqual(h.context.applyPricingPayload(payload(feature({ reconcile_required: true }), { count_mode: 'business_day', list: [{ game_account: 'wrong-top-mode' }] })), false);
    assert.strictEqual(JSON.stringify(h.pricing.list), original);
    assert.strictEqual(h.context.applyPricingPayload(payload(feature({ reconcile_required: false }))), true);
    h.context.renderPricingView();
    assertStatus(h, '已生效');
    assert.strictEqual(h.context.applyPricingPayload(payload(feature({ reconcile_required: true }), { list: [{ game_account: 'stale-pending' }] })), false);
    h.context.renderPricingView();
    assertStatus(h, '已生效');
    assert(!h.pricing.list.some(item => item.game_account === 'stale-pending'));
}

async function testHigherVersionFromOtherSession() {
    const h = harness();
    h.context.request = async () => payload(feature({ count_mode: 'business_day', reconcile_required: true, version: 8 }));
    const result = await h.context.loadPricingView();
    assert.strictEqual(result.ok, true);
    assert.strictEqual(h.nodes.pricingCountMode.value, 'business_day');
    assert.strictEqual(h.pricing.feature.version, 8);
    assertStatus(h, '待生效');
    assert(h.toasts.some(value => /其他|别处|更新/.test(value)), 'newer external configuration is disclosed');
}

async function testNetworkOutcomeConfirmedByReadback() {
    const h = harness();
    const saved = feature({ count_mode: 'business_day', version: 4 });
    let gets = 0;
    h.context.request = async (_url, options) => {
        if (options && options.method === 'POST') throw new Error('请求超时');
        gets += 1;
        return payload(saved);
    };
    await h.context.updatePricingCountMode('business_day');
    assert(gets > 0, 'ambiguous network failure is checked with a read');
    assert.strictEqual(h.nodes.pricingCountMode.value, 'business_day');
    assert.strictEqual(h.pricing.feature.version, 4);
    assertStatus(h, '已生效');
    assert(!h.toasts.some(value => /保存失败/.test(value)));
}

async function testUncertainNetworkKeepsIntentAndAllowsRetry() {
    const h = harness();
    let posts = 0;
    h.context.request = async (_url, options) => {
        if (options && options.method === 'POST') posts += 1;
        throw new Error('network unavailable');
    };
    await h.context.updatePricingCountMode('business_day');
    assertStatus(h, '待生效');
    assert.strictEqual(h.nodes.pricingCountMode.value, 'business_day');
    assert.strictEqual(h.nodes.pricingCountMode.disabled, false);
    assert.strictEqual(h.toggle.disabled, false);
    assert.strictEqual(h.pricing.feature.version, 3);
    assert(!h.toasts.some(value => /保存失败/.test(value)));
    const saved = feature({ count_mode: 'business_day', version: 4 });
    h.context.request = async (_url, options) => {
        if (options && options.method === 'POST') { posts += 1; return { feature: saved }; }
        return payload(saved);
    };
    await h.context.updatePricingCountMode('business_day');
    assert.strictEqual(posts, 2, 'retry can submit an unresolved selection');
    assertStatus(h, '已生效');
    assert.strictEqual(h.nodes.pricingCountMode.value, 'business_day');
}

async function testOldReadbackDoesNotProveFailure() {
    const h = harness();
    h.context.request = async (_url, options) => {
        if (options && options.method === 'POST') throw new Error('请求超时');
        return payload(feature());
    };
    await h.context.updatePricingCountMode('business_day');
    assertStatus(h, '待生效');
    assert.strictEqual(h.nodes.pricingCountMode.value, 'business_day');
    assert.strictEqual(h.pricing.feature.version, 3);
}

async function testIncompletePostNeverDefaultsToRollingSuccess() {
    for (const confirmed of [true, false]) {
        const h = harness();
        const saved = feature({ count_mode: 'business_day', reconcile_required: true, version: 4 });
        let reads = 0;
        h.context.request = async (_url, options) => {
            if (options && options.method === 'POST') return { feature: { enabled: true, reconcile_required: true, version: 4 } };
            reads += 1;
            return payload(confirmed ? saved : feature());
        };
        await h.context.updatePricingCountMode('business_day');
        assert(reads > 0);
        assert.strictEqual(h.nodes.pricingCountMode.value, 'business_day');
        assertStatus(h, '待生效');
        assert.strictEqual(h.pricing.feature.version, confirmed ? 4 : 3);
        assert(!h.toasts.some(value => /保存失败/.test(value)));
    }
}

async function testSavedPostSurvivesRefreshFailure() {
    const h = harness();
    const saved = feature({ count_mode: 'business_day', reconcile_required: true, version: 4 });
    h.context.request = async (_url, options) => {
        if (options && options.method === 'POST') return { feature: saved };
        throw new Error('列表暂时不可用');
    };
    await h.context.updatePricingCountMode('business_day');
    assert.strictEqual(h.nodes.pricingCountMode.value, 'business_day');
    assert.strictEqual(h.pricing.feature.version, 4);
    assertStatus(h, '待生效');
    assert(h.toasts.includes('设置已保存，数据刷新失败'));
    assert(!h.toasts.some(value => /保存失败/.test(value)));
}

async function testCrossGameAndSameGameGetRace() {
    const h = harness();
    const first = deferred();
    const second = deferred();
    let call = 0;
    h.context.request = async () => (++call === 1 ? first.promise : second.promise);
    const wzry = h.context.loadPricingView();
    h.pricing.game_name = 'CSGO';
    const csgo = h.context.loadPricingView();
    second.resolve(payload(feature(), { game_name: 'CSGO', list: [{ game_account: 'csgo-new', today_order_count: 7 }] }));
    await csgo;
    first.resolve(payload(feature(), { game_name: 'WZRY', list: [{ game_account: 'wzry-old', today_order_count: 99 }] }));
    await wzry;
    assert.strictEqual(h.pricing.game_name, 'CSGO');
    assert.strictEqual(h.pricing.list[0].game_account, 'csgo-new');
    assert(!h.list.innerHTML.includes('99单'));
    assert.strictEqual(h.pricing.loading, false);

    const old = deferred();
    const recent = deferred();
    call = 0;
    h.context.request = async () => (++call === 1 ? old.promise : recent.promise);
    const oldLoad = h.context.loadPricingView();
    const newLoad = h.context.loadPricingView();
    recent.resolve(payload(feature(), { game_name: 'CSGO', list: [{ game_account: 'latest', today_order_count: 8 }] }));
    await newLoad;
    old.resolve(payload(feature(), { game_name: 'CSGO', list: [{ game_account: 'old', today_order_count: 99 }] }));
    await oldLoad;
    assert.strictEqual(h.pricing.list[0].game_account, 'latest');
    assert.strictEqual(h.pricing.loading, false);
}

async function testGetStartedBeforeSaveCannotPublishDuringSave() {
    const h = harness();
    const oldGet = deferred();
    const post = deferred();
    let reads = 0;
    const saved = feature({ count_mode: 'business_day', reconcile_required: true, version: 4 });
    h.context.request = async (_url, options) => {
        if (options && options.method === 'POST') return post.promise;
        return ++reads === 1 ? oldGet.promise : payload(saved);
    };
    const oldLoad = h.context.loadPricingView();
    const saving = h.context.updatePricingCountMode('business_day');
    oldGet.resolve(payload(feature(), { list: [{ game_account: 'from-before-save', today_order_count: 99 }] }));
    const oldResult = await oldLoad;
    assert.strictEqual(oldResult.ok, false);
    assert.strictEqual(oldResult.reason, 'superseded');
    assert.strictEqual(h.nodes.pricingCountMode.value, 'business_day');
    assertStatus(h, '待生效');
    assert(!h.pricing.list.some(item => item.game_account === 'from-before-save'));
    post.resolve({ feature: saved });
    await saving;
    assert.strictEqual(h.pricing.feature.version, 4);
    assert.strictEqual(h.pricing.loading, false);
    assertStatus(h, '待生效');
}

async function testChangedOwnerIgnoresOutstandingPostAndGet() {
    const h = harness();
    h.context.state.user = { id: 10 };
    const delayed = deferred();
    h.context.request = async () => delayed.promise;
    const saving = h.context.updatePricingCountMode('business_day');
    const oldPricing = h.pricing;
    h.context.state.user = { id: 20 };
    h.context.state.pricing = {};
    h.context.ensurePricingLadderState();
    delayed.resolve({ feature: feature({ count_mode: 'business_day', version: 4 }) });
    await saving;
    assert.strictEqual(h.pricing.feature.version, 0);
    assert.strictEqual(h.pricing.feature.count_mode, 'rolling_24h');
    assert.strictEqual(oldPricing.feature.version, 3);
    assert.strictEqual(oldPricing.feature_saving, false, 'a discarded owner request must still release its old saving lock');
    assert.strictEqual(h.toasts.length, 0);

    const g = harness();
    g.context.state.user = { id: 10 };
    const old = deferred();
    g.context.request = async () => old.promise;
    const loading = g.context.loadPricingView();
    g.context.state.user = { id: 20 };
    g.context.state.pricing = {};
    g.context.ensurePricingLadderState();
    old.resolve(payload(feature({ count_mode: 'business_day', version: 4 })));
    const result = await loading;
    assert.strictEqual(result.reason, 'superseded');
    assert.strictEqual(g.pricing.feature.version, 0);
    assert.strictEqual(g.toasts.length, 0);
}

async function testUnconfirmedInitialContractDisablesSettings() {
    const h = harness();
    h.context.state.pricing = {};
    h.context.request = async () => payload({ enabled: true, reconcile_required: false, version: 3 });
    await h.context.loadPricingView();
    assert.strictEqual(h.pricing.feature_confirmed, false);
    assert.strictEqual(h.nodes.pricingCountMode.disabled, true);
    assert.strictEqual(h.toggle.disabled, true);
    assert.strictEqual(h.nodes.pricingCountStatus.hidden, true);
    assert.strictEqual(h.featureStatus.textContent, '已开启', 'a legacy response still preserves its truthful enabled switch');
    assert.strictEqual(h.toggle.checked, true);
}

async function testCancelledEnableAndSwitchStatus() {
    const h = harness(feature({ enabled: false }));
    h.context.window.confirm = () => false;
    let calls = 0;
    h.context.request = async () => { calls += 1; return {}; };
    await h.context.updatePricingFeature(true);
    assert.strictEqual(calls, 0);
    assert.strictEqual(h.toggle.checked, false);
    assert.strictEqual(h.featureStatus.textContent, '已关闭');
    assertStatus(h, '待生效');
}

async function testPendingPollCompletesAndStops() {
    const timers = fakeTimers();
    const h = harness(feature({ reconcile_required: true }), { timers });
    h.context.state.user = { id: 10 };
    let gets = 0;
    h.context.request = async (_url, options) => {
        assert.strictEqual(options.background, true, 'status polling must be a quiet background request');
        return payload(feature({ reconcile_required: ++gets < 2 }));
    };
    h.context.schedulePricingFeatureRefresh();
    assert.strictEqual(timers.size, 1);
    await timers.next();
    assert.strictEqual(gets, 1);
    assertStatus(h, '待生效');
    assert.strictEqual(timers.size, 1);
    await timers.next();
    assert.strictEqual(gets, 2);
    assertStatus(h, '已生效');
    assert.strictEqual(timers.size, 0, 'confirmed effective settings stop background reads');
}

async function testUncertainSaveCanBecomeEffectiveThroughPolling() {
    const timers = fakeTimers();
    const h = harness(feature(), { timers });
    h.context.state.user = { id: 10 };
    h.context.request = async (_url, options) => {
        if (options && options.method === 'POST') throw new Error('response lost');
        return payload(feature());
    };
    await h.context.updatePricingCountMode('business_day');
    assertStatus(h, '待生效');
    assert.strictEqual(h.nodes.pricingCountMode.value, 'business_day');
    assert.strictEqual(timers.size, 1);
    h.context.request = async () => payload(feature({ count_mode: 'business_day', version: 4 }));
    await timers.next();
    assertStatus(h, '已生效');
    assert.strictEqual(h.nodes.pricingCountMode.value, 'business_day');
    assert.strictEqual(h.pricing.feature.version, 4);
    assert.strictEqual(timers.size, 0);
}

async function testHangingSaveAndReadbackUnlockWithoutAcceptingLateResponses() {
    const h = harness();
    h.context.window.PricingFeatureState.withTimeout = (request, url, options) => featureState.withTimeout(request, url, options, 1);
    const post = deferred();
    const readback = deferred();
    h.context.request = async (_url, options) => options && options.method === 'POST' ? post.promise : readback.promise;
    await h.context.updatePricingCountMode('business_day');
    assertStatus(h, '待生效');
    assert.strictEqual(h.nodes.pricingCountMode.disabled, false);
    assert.strictEqual(h.toggle.disabled, false);
    assert.strictEqual(h.nodes.pricingCountMode.value, 'business_day');
    post.resolve({ feature: feature({ count_mode: 'business_day', version: 4 }) });
    readback.resolve(payload(feature({ count_mode: 'business_day', version: 4 })));
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
    assert.strictEqual(h.pricing.feature.version, 3, 'timed-out late replies do not write UI state');
    assertStatus(h, '待生效');
}

async function testPollStopsOutsideCurrentVisibleOwnerPage() {
    for (const leave of [
        h => { h.context.state.currentMenu = 'orders'; },
        h => { h.context.state.user = null; },
        h => { h.context.document.visibilityState = 'hidden'; },
        h => { h.context.state.pricing = {}; }
    ]) {
        const timers = fakeTimers();
        const h = harness(feature({ reconcile_required: true }), { timers });
        h.context.state.user = { id: 10 };
        let gets = 0;
        h.context.request = async () => { gets += 1; return payload(feature()); };
        h.context.schedulePricingFeatureRefresh();
        leave(h);
        await timers.next();
        assert.strictEqual(gets, 0);
        assert.strictEqual(timers.size, 0);
    }
    for (const config of [feature({ enabled: false, reconcile_required: true }), feature()]) {
        const timers = fakeTimers();
        const h = harness(config, { timers });
        h.context.state.user = { id: 10 };
        h.context.schedulePricingFeatureRefresh();
        assert.strictEqual(timers.size, 0);
    }
    const timers = fakeTimers();
    const h = harness(feature({ reconcile_required: true }), { timers });
    h.context.state.user = { id: 10 };
    h.pricing.feature_save_error = true;
    h.context.schedulePricingFeatureRefresh();
    assert.strictEqual(timers.size, 0, 'explicitly failed settings are not silently retried');
}

async function testPollDefersLoadingPreservesDataOnErrorAndIsBounded() {
    const timers = fakeTimers();
    const h = harness(feature({ reconcile_required: true }), { timers });
    h.context.state.user = { id: 10 };
    h.pricing.loading = true;
    let gets = 0;
    h.context.request = async () => { gets += 1; throw new Error('background network failure'); };
    h.context.schedulePricingFeatureRefresh();
    await timers.next();
    assert.strictEqual(gets, 0);
    assert.strictEqual(Number(h.pricing.feature_poll_attempts || 0), 0);
    assert.strictEqual(timers.size, 1);
    const original = JSON.stringify(h.pricing.list);
    h.pricing.loading = false;
    await timers.next();
    assert.strictEqual(gets, 1);
    assert.strictEqual(JSON.stringify(h.pricing.list), original);
    assert.strictEqual(h.pricing.error, '', 'background failures do not replace the account list with an error');
    assertStatus(h, '待生效');
    h.context.request = async () => { gets += 1; return payload(feature({ reconcile_required: true })); };
    for (let i = 1; i < 20; i += 1) await timers.next();
    assert.strictEqual(gets, 20);
    assert.strictEqual(h.pricing.feature_poll_attempts, 20);
    assert.strictEqual(timers.size, 0, 'background polling stops after 20 reads');
}

async function testNewerExternalWriteSupersedesLateSaveAcknowledgement() {
    const h = harness();
    const oldSave = deferred();
    const external = feature({ version: 5 });
    h.context.request = async (_url, options) => options && options.method === 'POST'
        ? oldSave.promise : payload(external);
    const saving = h.context.updatePricingCountMode('business_day');
    await h.context.loadPricingView();
    assert.strictEqual(h.pricing.feature.version, 5);
    oldSave.resolve({ feature: feature({ count_mode: 'business_day', reconcile_required: true, version: 4 }) });
    await saving;
    assert.strictEqual(h.pricing.feature.version, 5);
    assert.strictEqual(h.nodes.pricingCountMode.value, 'rolling_24h');
    assert(h.toasts.some(text => /其他|别处/.test(text)));
    assert(!h.toasts.some(text => /计数周期已保存/.test(text)), 'superseded save must not announce its old intent as current');
}

async function testPollingPausesDuringAccountEditingAndSaving() {
    const timers = fakeTimers();
    const h = harness(feature({ reconcile_required: true }), { timers });
    h.context.state.user = { id: 10 };
    let reads = 0;
    h.context.request = async () => { reads += 1; return payload(feature()); };
    h.context.schedulePricingFeatureRefresh();
    assert.strictEqual(timers.size, 1);
    h.context.enterPricingEdit('demo');
    assert.strictEqual(timers.size, 0, 'starting editing cancels a scheduled background refresh');
    h.context.schedulePricingFeatureRefresh();
    assert.strictEqual(timers.size, 0);
    h.pricing.editing.demo = false;
    h.pricing.saving.demo = true;
    h.context.renderPricingView();
    assert.strictEqual(timers.size, 0, 'an account save also pauses background refresh');
    assert.strictEqual(reads, 0);
    h.pricing.saving.demo = false;
    h.context.renderPricingView();
    assert.strictEqual(timers.size, 1, 'finishing account work resumes pending status checks');
}

async function testInflightPollCannotReplaceAnActiveAccountDraftOrDom() {
    const timers = fakeTimers();
    const h = harness(feature({ reconcile_required: true }), { timers });
    h.context.state.user = { id: 10 };
    const old = deferred();
    h.context.request = async () => old.promise;
    const reading = h.context.loadPricingView({ poll: true });
    h.context.enterPricingEdit('demo');
    h.pricing.drafts.demo.prices[0] = '6.6';
    const original = h.pricing.list[0];
    h.list.innerHTML = 'focused-input-and-unsaved-6.6';
    old.resolve(payload(feature(), { list: [{ game_account: 'demo', prices: [99, 99, 99, 99] }] }));
    const result = await reading;
    assert.strictEqual(result.reason, 'superseded');
    assert.strictEqual(h.pricing.list[0], original);
    assert.strictEqual(h.pricing.drafts.demo.prices[0], '6.6');
    assert.strictEqual(h.list.innerHTML, 'focused-input-and-unsaved-6.6', 'even the finally block must not rerender focused editing DOM');
    assert.strictEqual(timers.size, 0);
}

async function testInflightPollCannotOverwriteAnAccountSavedAfterReadStarted() {
    const timers = fakeTimers();
    const h = harness(feature({ reconcile_required: true }), { timers });
    h.context.state.user = { id: 10 };
    const old = deferred();
    h.context.request = async (_url, options) => {
        if (options && options.method === 'POST') return { rule: { configured: true, prices: [6, 7, 8, 9], version: 2 } };
        return old.promise;
    };
    const reading = h.context.loadPricingView({ poll: true });
    h.context.enterPricingEdit('demo');
    await h.context.savePricingAccount('demo', { querySelectorAll: () => [6, 7, 8, 9].map(value => ({ value: String(value) })) });
    assert.strictEqual(h.pricing.editing.demo, false);
    assert.strictEqual(h.pricing.saving.demo, false);
    assert.deepStrictEqual(Array.from(h.pricing.list[0].prices), [6, 7, 8, 9]);
    const savedDom = h.list.innerHTML;
    old.resolve(payload(feature(), { list: [{ game_account: 'demo', prices: [2, 3, 4, 5], version: 1 }] }));
    const result = await reading;
    assert.strictEqual(result.reason, 'superseded');
    assert.deepStrictEqual(Array.from(h.pricing.list[0].prices), [6, 7, 8, 9]);
    assert.strictEqual(h.pricing.list[0].version, 2);
    assert.strictEqual(h.list.innerHTML, savedDom, 'a completed edit still invalidates older poll snapshots');
}

async function testOwnerBindingResetsOldVersionBeforeReadingNewOwner() {
    const timers = fakeTimers();
    const h = harness(feature({ count_mode: 'business_day', version: 8, reconcile_required: true }), { timers });
    const previous = h.pricing;
    assert.strictEqual(previous.feature_owner_id, '10');
    h.context.schedulePricingFeatureRefresh();
    assert.strictEqual(timers.size, 1);
    // Authentication can replace state.user without replacing the pricing object.
    h.context.state.user = { id: 20 };
    const incoming = feature({ enabled: false, version: 1 });
    h.context.request = async () => payload(incoming, { list: [{ game_account: 'owner-20', prices: [1, 2, 3, 4] }] });
    const result = await h.context.loadPricingView();
    assert.strictEqual(result.ok, true);
    assert.notStrictEqual(h.pricing, previous);
    assert.strictEqual(h.pricing.feature_owner_id, '20');
    assert.strictEqual(h.pricing.feature.version, 1, 'owner 20 version 1 is not compared with owner 10 version 8');
    assert.strictEqual(h.pricing.feature.count_mode, 'rolling_24h');
    assert.strictEqual(h.pricing.list[0].game_account, 'owner-20');
    assert.strictEqual(h.nodes.pricingCountMode.disabled, false);
    assert.strictEqual(h.toggle.checked, false);
    assert.strictEqual(timers.size, 0, 'old-owner poll timer was cancelled');
}

async function testExpiredLoginDoesNotLeaveSameOwnerPermanentlySaving() {
    const h = harness();
    const previous = h.pricing;
    h.context.request = async () => {
        h.context.state.user = null;
        throw new Error('登录已过期，请重新登录');
    };
    await h.context.updatePricingCountMode('business_day');
    assert.strictEqual(previous.feature_saving, false);
    assert.strictEqual(previous.feature_intent, null);
    assert.strictEqual(previous.pending_count_mode, undefined);
    h.context.state.user = { id: 10 };
    h.context.renderPricingView();
    assert.strictEqual(h.nodes.pricingCountMode.disabled, false);
    assert.strictEqual(h.toggle.disabled, false);
    const saved = feature({ count_mode: 'business_day', version: 4 });
    h.context.request = async (_url, options) => options && options.method === 'POST' ? { feature: saved } : payload(saved);
    await h.context.updatePricingCountMode('business_day');
    assert.strictEqual(h.pricing.feature.version, 4);
    assertStatus(h, '已生效');
}

async function testConfirmedConfigurationRejectsMissingModeOrFeatureAsWholePayload() {
    const current = feature({ count_mode: 'business_day', version: 4 });
    const h = harness(current);
    const original = JSON.stringify(h.pricing.list);
    const legacyFeature = { enabled: true, reconcile_required: false, version: 4 };
    for (const incomplete of [legacyFeature, undefined]) {
        const stale = payload(current, {
            feature: incomplete,
            count_mode: 'rolling_24h',
            list: [{ game_account: 'unconfirmed-legacy-data', today_order_count: 99 }]
        });
        assert.strictEqual(h.context.applyPricingPayload(stale), false);
        assert.strictEqual(h.pricing.feature.count_mode, 'business_day');
        assert.strictEqual(h.pricing.feature.version, 4);
        assert.strictEqual(JSON.stringify(h.pricing.list), original);
        h.context.request = async () => stale;
        const result = await h.context.loadPricingView();
        assert.strictEqual(result.ok, false);
        assert.strictEqual(result.reason, 'stale');
        assert.strictEqual(h.nodes.pricingCountMode.value, 'business_day');
        assert.strictEqual(h.pricing.feature.version, 4);
        assert.strictEqual(JSON.stringify(h.pricing.list), original);
        assert(!h.toasts.some(text => /已保存/.test(text)));
    }
}

async function testRealGameTabClickClearsPreviousGameBeforeLoading() {
    const h = harness();
    const tab = { getAttribute: () => 'CSGO' };
    h.context.els.pricingGameTabs = { innerHTML: '', querySelectorAll: () => [tab] };
    h.context.renderPricingGameTabs();
    const result = deferred();
    const calls = [];
    h.context.request = async url => { calls.push(url); return result.promise; };
    h.pricing.editing.demo = true;
    h.pricing.saving.demo = true;
    h.pricing.drafts.demo = { prices: ['2', '3', '4', '5'] };
    h.pricing.query = 'old game search';
    tab.onclick();
    assert.strictEqual(h.pricing.game_name, 'CSGO');
    assert.strictEqual(h.pricing.list.length, 0, 'old game accounts are cleared before the next response arrives');
    assert.strictEqual(Object.keys(h.pricing.editing).length, 0);
    assert.strictEqual(Object.keys(h.pricing.saving).length, 0);
    assert.strictEqual(Object.keys(h.pricing.drafts).length, 0);
    assert.strictEqual(h.pricing.query, '');
    assert.strictEqual(calls.length, 1);
    assert(calls[0].includes('game_name=CSGO'));
    tab.onclick();
    assert.strictEqual(calls.length, 1, 'clicking the active tab does not start another request');
    result.resolve(payload(feature(), { game_name: 'CSGO', list: [{ game_account: 'csgo-only', today_order_count: 1 }] }));
    for (let i = 0; i < 20; i += 1) await Promise.resolve();
    assert.strictEqual(h.pricing.list[0].game_account, 'csgo-only');
    assert.strictEqual(h.pricing.loading, false);
}

async function testRatioMenuRoutesToRatioLoaderOnly() {
    const h = harness();
    let ratioLoads = 0;
    let ladderLoads = 0;
    h.context.state.currentMenu = 'pricing_ratios';
    h.context.loadPricingRatioSettings = async () => { ratioLoads += 1; };
    h.context.request = async () => { ladderLoads += 1; return payload(feature()); };
    const result = await h.context.loadPricingView();
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.reason, 'superseded');
    assert.strictEqual(ratioLoads, 1);
    assert.strictEqual(ladderLoads, 0);
}

async function main() {
    testFeatureStateContracts();
    await testBoundedRequestsAbortAndIgnoreLateResponses();
    await testThreeStatusLifecycleAndSavingLock();
    await testExplicitFailureRestoresSavedAndCanRetry();
    await testStaleResponsesNeverMergeOldCountsIntoNewMode();
    testSameVersionConflictsAndReconcileCannotRegress();
    await testHigherVersionFromOtherSession();
    await testNetworkOutcomeConfirmedByReadback();
    await testUncertainNetworkKeepsIntentAndAllowsRetry();
    await testOldReadbackDoesNotProveFailure();
    await testIncompletePostNeverDefaultsToRollingSuccess();
    await testSavedPostSurvivesRefreshFailure();
    await testCrossGameAndSameGameGetRace();
    await testGetStartedBeforeSaveCannotPublishDuringSave();
    await testChangedOwnerIgnoresOutstandingPostAndGet();
    await testUnconfirmedInitialContractDisablesSettings();
    await testCancelledEnableAndSwitchStatus();
    await testPendingPollCompletesAndStops();
    await testUncertainSaveCanBecomeEffectiveThroughPolling();
    await testHangingSaveAndReadbackUnlockWithoutAcceptingLateResponses();
    await testPollStopsOutsideCurrentVisibleOwnerPage();
    await testPollDefersLoadingPreservesDataOnErrorAndIsBounded();
    await testNewerExternalWriteSupersedesLateSaveAcknowledgement();
    await testPollingPausesDuringAccountEditingAndSaving();
    await testInflightPollCannotReplaceAnActiveAccountDraftOrDom();
    await testInflightPollCannotOverwriteAnAccountSavedAfterReadStarted();
    await testOwnerBindingResetsOldVersionBeforeReadingNewOwner();
    await testExpiredLoginDoesNotLeaveSameOwnerPermanentlySaving();
    await testConfirmedConfigurationRejectsMissingModeOrFeatureAsWholePayload();
    await testRealGameTabClickClearsPreviousGameBeforeLoading();
    await testRatioMenuRoutesToRatioLoaderOnly();
    console.log('[OK] pricing_count_mode_settings_smoke_test passed: three statuses, version guards, ambiguous saves and GET races');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
