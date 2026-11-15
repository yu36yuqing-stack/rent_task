'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const api = require('../h5/public/js/ui/order_search');
const coreFile = path.resolve(__dirname, '../h5/public/js/app_core.js');
const core = fs.readFileSync(coreFile, 'utf8');
let cases = 0;
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() { let resolve, reject; const promise = new Promise((ok, no) => { resolve = ok; reject = no; });return { promise, resolve, reject }; }
function node() {
  const events = {}, classes = new Set();
  return { value: '', textContent: '', attributes: {},
    classList: { toggle: (name, active) => active ? classes.add(name) : classes.delete(name), contains: name => classes.has(name) },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener(name, callback) { events[name] = callback; },
    dispatch(name, values = {}) { const event = { key: '', preventDefault() { this.prevented = true; }, ...values };events[name]?.(event);return event; }
  };
}
function fixture(extra = {}) {
  const o = { page: 3, pageSize: 20, total: 2, list: [{ order_no: 'old' }], stats: { done: 2 }, game_name: 'WZRY', quick_filter: 'last7', status_filter: 'done' };
  const state = { identity: '8', o, calls: [], errors: [], renders: 0 };
  const nodes = { form: node(), input: node(), clear: node(), feedback: node() };
  const controller = api.create({ getOrders: () => state.o, getIdentity: () => state.identity,
    request: async (url, options) => { state.calls.push({ url, options });return { keyword: new URL(url, 'http://localhost').searchParams.get('keyword'), list: [{ order_no: 'fresh' }], total: 1, page: 1, page_size: 20, game_name: 'WZRY' }; },
    render: () => { state.renders++;controller.render(); },onError: message => state.errors.push(message), nodes, ...extra });
  return { state, o, nodes, controller };
}
async function test(name, run) { await run();cases++; }
function authHarness(fetch) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) {
      const item = node();
      item.style = {};item.dataset = {};item.querySelectorAll = () => [];item.querySelector = () => null;
      item.classList.add = () => {};item.classList.remove = () => {};
      elements.set(id, item);
    }
    return elements.get(id);
  };
  const storage = { getItem: () => null, setItem() {}, removeItem() {} };
  const sandbox = { URLSearchParams, URL, FormData, ArrayBuffer, fetch, console,
    navigator: { maxTouchPoints: 0 }, localStorage: storage, sessionStorage: storage,
    document: { getElementById: element, querySelectorAll: () => [], addEventListener() {} },
    window: { location: { pathname: '/', href: 'http://localhost/' }, addEventListener() {}, OrderSearch: {
      create(options) {
        const controller = api.create(options);
        return { ...controller, reset() { sandbox.resets++;controller.reset(); } };
      }
    } }, resets: 0, renders: 0, loading: 0, setTimeout, clearTimeout, setInterval, clearInterval
  };
  const context = vm.createContext(sandbox);
  // Execute the entire original file: both V8 character offsets and source text are real.
  // DOM listeners are registered but no boot event or external request is dispatched.
  vm.runInContext(core, context, { filename: coreFile });
  sandbox.state = vm.runInContext('state', context);
  Object.assign(sandbox.state, { token: 'old-access', refreshToken: 'old-refresh', user: { id: 8 }, rememberLogin: false });
  sandbox.render = () => { sandbox.renders++; };
  sandbox.beginGlobalRequestLoading = () => { sandbox.loading++; };
  sandbox.endGlobalRequestLoading = async () => { sandbox.loading--; };
  return { context, sandbox };
}
const reply = (body, status = 200) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

async function main() {
  await test('keyword validation is literal and preserves numeric strings', async () => {
    assert.strictEqual(api.normalizeKeyword(null), '');assert.strictEqual(api.normalizeKeyword(123), '123');
    assert.strictEqual(api.normalizeKeyword('  0012345  '), '0012345');assert.strictEqual(api.normalizeKeyword(' %_\\ '), '%_\\');
    assert.strictEqual(api.normalizeKeyword('中'.repeat(64)).length, 64);assert.strictEqual(Array.from(api.normalizeKeyword('🐻'.repeat(64))).length, 64);
    assert.throws(() => api.normalizeKeyword('a'.repeat(65)), /64/);
  });
  await test('script browser export and optional nodes', async () => {
    const file = path.resolve(__dirname, '../h5/public/js/ui/order_search.js');const sandbox = { window: {}, URLSearchParams };
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });assert.strictEqual(typeof sandbox.window.OrderSearch.create, 'function');
    const h = fixture({ nodes: undefined });h.controller.render();assert(await h.controller.load());
  });
  await test('input does not request; submit trims and resets pagination while keeping filters', async () => {
    const h = fixture();h.controller.render();assert(h.nodes.clear.classList.contains('hidden'));
    h.nodes.input.value = '  呆熊宝  ';h.nodes.input.dispatch('input');assert.strictEqual(h.state.calls.length, 0);assert.strictEqual(h.o.keyword, '');
    h.nodes.form.dispatch('submit');await tick();assert.strictEqual(h.o.keyword, '呆熊宝');assert.strictEqual(h.o.search_draft, '呆熊宝');assert.strictEqual(h.o.page, 1);
    const q = new URL(h.state.calls[0].url, 'http://localhost').searchParams;
    assert.strictEqual(q.get('keyword'), '呆熊宝');assert.strictEqual(q.get('quick_filter'), 'last7');assert.strictEqual(q.get('status_filter'), 'done');assert.strictEqual(q.get('game_name'), 'WZRY');
    assert.strictEqual(h.state.calls[0].options.background, true);assert.strictEqual(typeof h.state.calls[0].options.is_current, 'function');
    assert.strictEqual(h.o.total, 1);assert.strictEqual(h.o.list[0].order_no, 'fresh');assert.strictEqual(h.nodes.form.attributes['aria-busy'], 'false');
  });
  await test('clear uses same filters and resets page', async () => {
    const h = fixture();h.o.search_draft = '0012345';assert(await h.controller.submit());h.o.page = 5;
    h.nodes.clear.dispatch('click');await tick();assert.strictEqual(h.o.keyword, '');assert.strictEqual(h.o.page, 1);assert.strictEqual(h.o.quick_filter, 'last7');assert(h.nodes.clear.classList.contains('hidden'));
    h.o.search_draft = '   ';assert(await h.controller.submit());assert.strictEqual(h.o.keyword, '');
  });
  await test('IME composition does not submit on Enter', async () => {
    const h = fixture();h.nodes.input.value = '中文';h.nodes.input.dispatch('input');h.nodes.input.dispatch('compositionstart');
    assert(h.nodes.input.dispatch('keydown', { key: 'Enter', isComposing: true }).prevented);
    h.nodes.form.dispatch('submit');await tick();assert.strictEqual(h.state.calls.length, 0);
    h.nodes.input.dispatch('compositionend');assert(h.nodes.input.dispatch('keydown', { key: 'Enter', keyCode: 229 }).prevented);
    assert(!h.nodes.input.dispatch('keydown', { key: 'a' }).prevented);
    h.nodes.form.dispatch('submit');await tick();assert.strictEqual(h.state.calls.length, 1);
  });
  await test('overlong input preserves previous applied keyword and performs no request', async () => {
    const h = fixture();h.o.keyword = 'old';h.o.search_draft = 'a'.repeat(65);
    assert.strictEqual(await h.controller.submit(), false);assert.strictEqual(h.state.calls.length, 0);assert.strictEqual(h.o.keyword, 'old');assert(h.o.search_error.includes('64'));assert.strictEqual(h.state.errors.length, 1);
  });
  await test('failure retains rows and shows an explicit error, not empty results', async () => {
    const h = fixture({ request: async () => { throw new Error('fixture offline'); } });h.o.keyword = 'new';
    assert.strictEqual(await h.controller.load(), false);assert.strictEqual(h.o.list[0].order_no, 'old');assert.strictEqual(h.o.total, 2);assert(h.nodes.feedback.textContent.includes('已保留上次结果'));assert(!h.nodes.feedback.classList.contains('hidden'));assert.strictEqual(h.o.loading, false);
    const fallback = fixture({ request: async () => { throw null; } });await fallback.controller.load();assert(fallback.o.search_error.includes('订单查询失败'));
  });
  await test('stale success and stale error cannot replace latest results or feedback', async () => {
    const a = deferred(), b = deferred();let calls = 0;const h = fixture({ request: () => ++calls === 1 ? a.promise : b.promise });
    h.o.keyword = 'old';const pa = h.controller.load();h.o.keyword = 'new';const pb = h.controller.load();
    b.resolve({ keyword: 'new', list: [{ order_no: 'new' }], total: 1 });assert(await pb);a.resolve({ keyword: 'old', list: [{ order_no: 'old' }], total: 10 });assert.strictEqual(await pa, false);assert.strictEqual(h.o.list[0].order_no, 'new');
    const late = deferred();const h2 = fixture({ request: () => late.promise });const p = h2.controller.load();h2.o.keyword = 'other';late.reject(new Error('stale error'));assert.strictEqual(await p, false);assert.strictEqual(h2.state.errors.length, 0);assert.strictEqual(h2.o.list[0].order_no, 'old');
  });
  await test('old finally cannot clear busy state of current request', async () => {
    const a = deferred(), b = deferred();let calls = 0;const h = fixture({ request: () => ++calls === 1 ? a.promise : b.promise });
    const pa = h.controller.load();h.o.quick_filter = 'last30';const pb = h.controller.load();a.resolve({});await pa;assert.strictEqual(h.o.loading, true);b.resolve({});await pb;assert.strictEqual(h.o.loading, false);
  });
  await test('changing owner or same-user logout invalidates in-flight work and private state', async () => {
    const late = deferred();const h = fixture({ request: () => late.promise });h.o.keyword = 'private';h.o.search_draft = 'private';const p = h.controller.load();h.state.identity = '9';h.controller.render();
    assert.strictEqual(h.o.keyword, '');assert.strictEqual(h.o.total, 0);assert.strictEqual(h.o.list.length, 0);assert.strictEqual(h.o.detail_view.open, false);
    late.resolve({ keyword: 'private', list: [{ order_no: 'old-user' }] });assert.strictEqual(await p, false);assert.strictEqual(h.o.list.length, 0);
    const next = deferred();const same = fixture({ request: () => next.promise });const ps = same.controller.load();same.controller.reset();next.reject(new Error('old session'));await ps;assert.strictEqual(same.state.errors.length, 0);
    same.state.identity = '';assert.strictEqual(await same.controller.load(), false);await same.controller.clear();
  });
  await test('draft and input focus value survive unrelated renders, missing data defaults safely', async () => {
    const h = fixture({ request: async () => ({}) });h.nodes.input.value = '未提交';h.nodes.input.dispatch('input');h.controller.render();assert.strictEqual(h.nodes.input.value, '未提交');assert.strictEqual(h.o.keyword, '');
    assert(await h.controller.load());assert.strictEqual(h.o.list.length, 0);assert.strictEqual(h.o.stats.done_zero, 0);assert.strictEqual(h.o.range, null);
    const mismatch = fixture({ request: async () => ({ keyword: 'unexpected', list: [] }) });await mismatch.controller.load();assert.strictEqual(mismatch.o.list[0].order_no, 'old');assert(mismatch.o.search_error.includes('不一致'));
    const initial = fixture({ getOrders: () => ({ keyword: 'saved', search_draft: 'draft' }) });initial.controller.render();
  });
  await test('real request refresh is shared by latest search and ordinary request without logging out', async () => {
    const refresh = deferred();let refreshes = 0;const calls = [];const h = authHarness(async (url, options) => {
      calls.push({ url, options });if (url === '/api/refresh') { refreshes++;return refresh.promise; }
      return options.headers.Authorization === 'Bearer old-access' ? reply({}, 401) : reply({ ok: true, url });
    });
    let currentA = true;const a = h.context.request('/api/orders?keyword=A', { background: true, is_current: () => currentA });await tick();currentA = false;
    const b = h.context.request('/api/orders?keyword=B', { background: true, is_current: () => true });const ordinary = h.context.request('/api/profile');await tick();assert.strictEqual(refreshes, 1);
    refresh.resolve(reply({ ok: true, token: 'new-access', refresh_token: 'new-refresh', user: { id: 8 } }));
    await assert.rejects(a, /失效/);assert.strictEqual((await b).url, '/api/orders?keyword=B');assert.strictEqual((await ordinary).url, '/api/profile');assert.strictEqual(h.sandbox.state.token, 'new-access');assert.strictEqual(h.sandbox.resets, 0);assert.strictEqual(h.sandbox.renders, 0);assert.strictEqual(h.sandbox.loading, 0);
    for (const call of calls.filter(c => c.url !== '/api/refresh')) assert(!Object.hasOwn(call.options, 'is_current'));
  });
  await test('old 401 cannot refresh or log out a new user', async () => {
    const response = deferred();let refreshes = 0;const h = authHarness(async url => { if (url === '/api/refresh') refreshes++;return response.promise; });
    const old = h.context.request('/api/orders', { is_current: () => true });h.context.setAuth('user-9', { id: 9 }, 'refresh-9');response.resolve(reply({}, 401));await assert.rejects(old, /失效/);assert.strictEqual(refreshes, 0);assert.strictEqual(h.sandbox.state.user.id, 9);assert.strictEqual(h.sandbox.state.token, 'user-9');assert.strictEqual(h.sandbox.loading, 0);
  });
  await test('old refresh success and failure cannot mutate a newer session', async () => {
    for (const succeed of [true, false]) {
      const refresh = deferred();const h = authHarness(async url => url === '/api/refresh' ? refresh.promise : reply({}, 401));
      const old = h.context.request('/api/orders', { is_current: () => true });await tick();h.context.setAuth('new-user', { id: 9 }, 'new-refresh');
      if (succeed) refresh.resolve(reply({ token: 'old-user-refreshed', user: { id: 8 }, refresh_token: 'bad' }));else refresh.reject(new Error('old refresh failed'));
      await assert.rejects(old);assert.strictEqual(h.sandbox.state.user.id, 9);assert.strictEqual(h.sandbox.state.token, 'new-user');assert.strictEqual(h.sandbox.renders, 0);
    }
  });
  await test('current refresh failure preserves original auth-failure behavior', async () => {
    const h = authHarness(async url => url === '/api/refresh' ? reply({ ok: false, message: 'expired' }, 401) : reply({}, 401));
    await assert.rejects(h.context.request('/api/orders', { is_current: () => true }), /expired/);assert.strictEqual(h.sandbox.state.user, null);assert.strictEqual(h.sandbox.renders, 1);assert.strictEqual(h.sandbox.resets, 1);
    const missing = authHarness(async () => reply({}, 401));missing.sandbox.state.refreshToken = '';await assert.rejects(missing.context.request('/api/orders'), /登录已过期/);
  });
  await test('old refresh completion cannot clear a newer refresh promise', async () => {
    const first = deferred(), second = deferred();let count = 0;const h = authHarness(async url => url === '/api/refresh' ? (++count === 1 ? first.promise : second.promise) : reply({}, 401));
    const a = h.context.tryRefreshAccessToken();await tick();h.context.setAuth('user9', { id: 9 }, 'refresh9');const b = h.context.tryRefreshAccessToken();await tick();first.resolve(reply({ token: 'stale', user: { id: 8 } }));await assert.rejects(a, /失效/);
    const c = h.context.tryRefreshAccessToken();assert.strictEqual(count, 2);second.resolve(reply({ token: 'new9', refresh_token: 'refresh9-new', user: { id: 9 } }));await Promise.all([b, c]);assert.strictEqual(h.sandbox.state.user.id, 9);assert.strictEqual(h.sandbox.state.token, 'new9');
  });
  console.log(`[PASS] order_search_frontend_test: ${cases} cases; no network or real database`);
}
main().catch(error => { console.error(error);process.exitCode = 1; });
