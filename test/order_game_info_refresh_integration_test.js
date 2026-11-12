'use strict';

// This suite checks the real order orchestrator with channel/IO boundaries replaced.
// No fork, network request, or repository database write is permitted.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-refresh-integration-'));
for (const key of ['MAIN', 'RUNTIME', 'ORDER', 'STATS', 'PRICE']) process.env[`${key}_DB_FILE_PATH`] = path.join(tmp, `${key}.db`);
global.fetch = async () => { throw new Error('integration fixture forbids real HTTP'); };
const orderPath = require.resolve('../order/order');
const originalLoad = Module._load;
const originalConsole = { ...console };
const RealDate = Date;
let s;
function reset() {
    s = {
        auth: ['uuzuhao', 'uhaozu', 'zuhaowang', '5e'].map(platform => ({ platform, auth_status: 'valid', channel_enabled: true, auth_payload: { fixture: platform } })),
        accounts: [{ game_account: 'QQ1', account_remark: '角色', game_id: '1', game_name: 'WZRY', channel_prd_info: { uuzuhao: { prd_id: 'YY1' }, uhaozu: { prd_id: 'UH1' }, '5e': { account_no: 'STEAM1' } } }],
        users: [{ id: 8, account: 'fixture', status: 'enabled' }], orders: new Map(), details: new Map(), complaints: new Map(), pending: [],
        raw: { uuzuhao: [], uhaozu: [], zuhaowang: [], '5e': [] }, calls: [], fail: {}, counts: {}, rules: {}, blacklist: [], watermark: {},
        yyDetail: { complaintStatus: 1, complaintId: 'C1', complaintStartTime: 1794448800 },
        uhDetail: { detail_status: '已完成', actual_rent_amount: 10, service_fee_amount: 1, net_rent_amount: 9, complete_time: '2026-11-12 10:00:00' },
        feature: { enabled: false, version: 0 }, dbRows: [{ order_no: 'LIST1', has_complaint: 1 }, { order_no: 'LIST2', has_complaint: 0 }],
        cooldown: { hit_accounts: 0, added: 0, updated: 0 }, exists: true, forkPid: 22
    };
}
function key(uid, channel, no) { return `${uid}:${channel}:${no}`; }
function call(name, value) { s.calls.push({ name, value }); if (s.fail[name]) throw new Error(`fixture ${name}`); }
function calls(name) { return s.calls.filter(x => x.name === name).map(x => x.value); }
function channelList(name, query) { call(name, query); return { order_list: s.raw[name], total_count: (s.raw[name] || []).length, pages: 1 }; }
const stubs = {
    fs: { existsSync: () => s.exists },
    child_process: { fork(script, args, options) { call('fork', { script, args, options }); return { pid: s.forkPid, unref() { call('unref'); } }; } },
    '../database/user_platform_auth_db': { async listUserPlatformAuth(uid, options) { call('auth', { uid, options }); return s.auth; } },
    './service/order_query_service': { async initOrderQueryService() {}, async listPaidCountByAccounts(uid, accounts, options) { call('counts', { uid, accounts, options }); return s.counts; } },
    './service/order_command_service': {
        async initOrderCommandService() {}, async initOrderComplaintDb() {},
        async upsertOrder(row) { call('upsert', row); s.orders.set(key(row.user_id, row.channel, row.order_no), row); return { created: true, status_changed: true, current_order: row }; },
        async getOrderByKey(uid, channel, no) { call('getOrder', { uid, channel, no }); return s.orders.get(key(uid, channel, no)) || null; },
        async updateOrderRecAmount(uid, channel, no, amount) { call('recAmount', { uid, channel, no, amount }); },
        async upsertOrderDetail(row) { call('detailWrite', row); s.details.set(key(row.user_id, row.channel, row.order_no), row); },
        async getOrderDetailByOrder(uid, channel, no) { return s.details.get(key(uid, channel, no)) || null; },
        async listPendingUhaozuOrderDetailsByUser(uid, nos) { call('pending', { uid, nos }); return s.pending; },
        async getLastSyncTimestamp(uid, channel) { return s.watermark[channel] || 0; },
        async setLastSyncTimestamp(uid, channel, timestamp) { call('watermark', { uid, channel, timestamp }); s.watermark[channel] = timestamp; },
        async getOrderComplaintByOrder(uid, channel, no) { return s.complaints.get(key(uid, channel, no)) || null; },
        async upsertOrderComplaint(row) { call('complaintWrite', row); s.complaints.set(key(row.user_id, row.channel, row.order_no), row); }
    },
    '../database/user_rule_db': { async getUserRuleByName(uid, name) { call('rule', { uid, name }); return s.rules[name] || null; } },
    '../database/user_blacklist_db': { async listUserBlacklistByUserWithMeta() { return s.blacklist; } },
    '../blacklist/blacklist_source_gateway': { async upsertSourceAndReconcile(...args) { call('blacklist', args); } },
    './order_cooldown': { async reconcileOrderCooldownEntryByUser(uid, options) { call('cooldown', { uid, options }); return s.cooldown; } },
    '../report/dingding/ding_notify': { async sendDingdingMessage(...args) { call('notify', args); }, resolveDingdingAtOptions: (_, field) => ({ fixture_at: field }) },
    '../report/dingding/ding_style': { buildComplaintFirstHitText(row) { call('notifyStyle', row); return 'fixture complaint'; } },
    '../uuzuhao/uuzuhao_api': { async listAllOrders(query) { return channelList('uuzuhao', query); }, async getOrderDetail(query) { call('yyDetail', query); return { detail: s.yyDetail }; } },
    '../uhaozu/uhaozu_api': { async listAllOrderPages(size, query) { return channelList('uhaozu', query); }, async getOrderDetailPage(no) { call('uhDetail', no); if (s.fail[`uhDetail:${no}`]) throw new Error('fixture detail'); return '<html>fixture</html>'; }, parseUhaozuOrderDetailHtml() { return s.uhDetail; } },
    '../zuhaowang/zuhaowang_api': { async getOrderListByEncryptedPayload(query) { call('zuhaowang', query); const rows = typeof s.raw.zuhaowang === 'function' ? s.raw.zuhaowang(query, calls('zuhaowang').length) : s.raw.zuhaowang; return { order_list: rows, total_count: (rows || []).length }; } },
    '../5e_platfrom/5e_api': { async listAllRentOrders(query) { call('5e', query); return { list: s.raw['5e'], pages: 1, trace_id: 'TRACE' }; } },
    '../product/product': { async listAllUserGameAccountsByUser() { return s.accounts; } },
    '../database/user_db': { USER_STATUS_ENABLED: 'enabled', async listActiveUsers() { return s.users; } },
    '../database/sqlite_client': { openOrderDatabase() {
        return { get(sql, params, callback) { call('dbGet', { sql, params }); if (s.dbCallbackFailure === 'dbGet') return callback(new Error('fixture callback')); callback(null, sql.includes('progress_cnt') ? { progress_cnt: 1, done_cnt: 2, done_zero_cnt: 0, progress_order_amount_sum: 15 } : sql.includes('today_total') ? { today_total: 3 } : { total: 2 }); },
            all(sql, params, callback) { call('dbAll', { sql, params }); if (s.dbCallbackFailure === 'dbAll') return callback(new Error('fixture callback')); callback(null, s.dbRows); }, close() { call('dbClose'); } };
    } },
    '../user/user': { normalizeZuhaowangAuthPayload: row => ({ ...row, normalized: true }) },
    './auth_revoke_task_service': {
        buildAuthRevokeCandidateOnStatusChange(uid, row) { return row.order_no ? { uid, order_no: row.order_no } : null; },
        async enqueueAuthRevokeTasks(uid, rows) { call('authEnqueue', { uid, rows }); return { created: rows.length, existing: 0 }; },
        startAuthRevokeTaskWorker(options) { call('authWorker', options); return { triggered: true, pid: 23 }; }
    },
    './game_info_refresh_service': {
        async prepareGameInfoRefreshByUser(uid, options) { call('prepare', { uid, options }); return { observed: 1, sync_token: `fixture-token-${uid}` }; },
        async reconcileGameInfoRefreshByUser(uid, options) { call('reconcile', { uid, options }); return s.refreshSkipped || !options.sync_complete ? { skipped: true } : { queued: 1 }; }
    },
    './game_info_refresh_worker': { async startGameInfoRefreshWorker(options) { call('refreshWorker', options); await Promise.resolve(); return { triggered: true, pid: 24 }; } },
    '../database/price_ladder_feature_config_db': { async getPriceLadderFeatureConfig() { call('feature'); return s.feature; } },
    '../price/price_ladder_reconcile_service': {
        buildPriceLadderCandidatesFromOrderWrite(row) { call('priceCandidate', row); return [{ order_no: row.order_no }]; },
        async reconcilePriceLadderAfterOrderSync(uid, rows, options) { call('price', { uid, rows, options }); return { applied: options.allow_apply }; }
    }
};
Module._load = function(request, parent, isMain) {
    if (parent && parent.filename === orderPath && Object.hasOwn(stubs, request)) return stubs[request];
    return originalLoad.call(this, request, parent, isMain);
};
reset();
const order = require(orderPath);
function yy(no = 'YY-ORDER', extra = {}) { return { purchaseOrderNo: no, productId: 'YY1', gameId: 1, orderStatus: 4000, rentHour: 1, rentStartTime: 1794441600, rentEndTime: 1794445200, ...extra }; }
function uh(no = 'UH-ORDER', extra = {}) { return { id: no, goodsId: 'UH1', gameId: 1, status: 50, rentNum: 1, rentWay: 10, startTime: 1794441600, endTime: 1794445200, ...extra }; }
function zw(no = 'ZW-ORDER', extra = {}) { return { orderNo: no, accountNo: 'QQ1', status: 2, rentHourModel: '1小时', startTime: 1794441600, endTime: 1794445200, ...extra }; }
const fixedNow = new RealDate('2026-11-12T12:00:00+08:00');
function freeze(text) { global.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : [text])); } static now() { return new RealDate(text).getTime(); } }; }
async function main() {
    console.log = console.warn = console.error = () => {};
    // Complete multi-channel sync: prepare happens before the first HTTP boundary,
    // reconciliation receives complete freshness, and the awaited worker is ready.
    s.raw.uuzuhao = [yy()];s.raw.uhaozu = [uh()];s.raw.zuhaowang = [zw()];
    s.raw['5e'] = [{ orderChildNo: 'STEAM-ORDER', account_id: 'STEAM1', paySuccessTime: 1794441600, rentExpireTime: 1794445200, totalTimeLength: 3600 }];
    s.feature = { enabled: true, reconcile_required: true, version: 3 };
    let result = await order.syncOrdersByUser(8, { now: fixedNow, compensation_force: true });
    assert.strictEqual(result.ok, true);assert.deepStrictEqual(result.order_3_off_gate.expected, ['uuzuhao', 'uhaozu', 'zuhaowang', '5e']);
    assert.strictEqual(calls('reconcile')[0].options.sync_complete, true);assert.strictEqual(result.game_info_refresh.worker.pid, 24);
    assert.strictEqual(calls('reconcile')[0].options.sync_token, 'fixture-token-8');
    assert(s.calls.findIndex(x => x.name === 'prepare') < s.calls.findIndex(x => x.name === 'uuzuhao'));
    assert.strictEqual(calls('upsert').length, 4);assert.strictEqual(calls('price')[0].options.allow_apply, true);
    assert.strictEqual(result.platforms.zuhaowang.daily_compensation.hit, true);assert(!('_price_ladder_candidates' in result.platforms.uuzuhao));
    assert.strictEqual(calls('authWorker').length, 1);assert.strictEqual(calls('refreshWorker').length, 1);

    // A failed enabled channel blocks cross-channel convergence but doesn't stop
    // other channels from persisting orders; all four error paths remain intact.
    for (const channel of ['uuzuhao', 'uhaozu', 'zuhaowang', '5e']) {
        reset();s.fail[channel] = true;
        result = await order.syncOrdersByUser(8, { now: fixedNow, defer_game_info_refresh_worker: true });
        assert.strictEqual(result.ok, false);assert.deepStrictEqual(result.order_3_off_gate.missing, [channel]);
        assert.strictEqual(calls('reconcile')[0].options.sync_complete, false);assert.strictEqual(calls('refreshWorker').length, 0);
        assert.strictEqual(result.order_off.reason, 'authorized_platform_sync_incomplete');
    }
    reset();s.fail.uuzuhao = true;
    await order.syncOrdersByUser(8, { now: fixedNow });
    assert.strictEqual(calls('refreshWorker').length, 0, 'incomplete sync cannot start a consumer');
    reset();s.refreshSkipped = true;
    await order.syncOrdersByUser(8, { now: fixedNow });
    assert.strictEqual(calls('refreshWorker').length, 0, 'skipped registration cannot start a consumer');
    reset();s.auth = [];
    result = await order.syncOrdersByUser(8, { now: fixedNow });
    assert.strictEqual(result.ok, true);assert.strictEqual(result.order_off.reason, 'no_authorized_platform');
    assert.strictEqual(calls('reconcile')[0].options.sync_complete, false);assert.strictEqual(calls('uuzuhao').length, 0);
    for (const failure of ['prepare', 'reconcile', 'refreshWorker']) {
        reset();s.fail[failure] = true;
        result = await order.syncOrdersByUser(8, { now: fixedNow });
        assert.strictEqual(result.ok, true, `${failure} must not change successful order sync`);
        assert.strictEqual((failure === 'prepare' ? result.game_info_refresh_prepare : result.game_info_refresh).error, failure === 'prepare' ? 'refresh_prepare_failed' : 'refresh_reconcile_failed');
        if (failure === 'prepare') {
            assert.strictEqual(calls('reconcile')[0].options.sync_complete, false);
            assert.strictEqual(calls('reconcile')[0].options.sync_token, '');
            assert.strictEqual(calls('refreshWorker').length, 0);
        }
    }
    for (const failure of ['feature', 'cooldown', 'price', 'authEnqueue']) {
        reset();s.fail[failure] = true;if (failure === 'price') s.feature.enabled = true;
        result = await order.syncOrdersByUser(8, { now: fixedNow });
        assert.strictEqual(result.ok, failure === 'feature');
        if (failure === 'feature') assert.strictEqual(result.price_ladder.reason, 'feature_config_unavailable');
    }
    reset();s.users.push({ id: 9, account: 'disabled', status: 'disabled' });
    result = await order.syncOrdersForAllUsers({ now: fixedNow });
    assert.strictEqual(result.total_users, 1);assert.strictEqual(result.ok_users, 1);assert.strictEqual(calls('refreshWorker').length, 1);
    assert.deepStrictEqual(calls('refreshWorker')[0].user_ids, [8]);assert.strictEqual(calls('authWorker').length, 1);
    for (const failure of ['prepare', 'reconcile', 'uuzuhao']) {
        reset();s.fail[failure] = true;
        await order.syncOrdersForAllUsers({ now: fixedNow });
        assert.deepStrictEqual(calls('refreshWorker')[0].user_ids, [], `${failure} user must not be a consumer launch candidate`);
    }
    reset();s.refreshSkipped = true;await order.syncOrdersForAllUsers({ now: fixedNow });
    assert.deepStrictEqual(calls('refreshWorker')[0].user_ids, []);
    reset();s.fail.uuzuhao = true;
    result = await order.syncOrdersForAllUsers({ now: fixedNow, start_auth_revoke_worker: false, start_game_info_refresh_worker: false });
    assert.strictEqual(result.failed_users, 1);assert.strictEqual(result.game_info_refresh_worker.reason, 'disabled');assert.strictEqual(calls('refreshWorker').length, 0);
    reset();s.users = [];s.fail.refreshWorker = true;
    result = await order.syncOrdersForAllUsers();
    assert.strictEqual(result.total_users, 0);assert.strictEqual(result.processed_users, 0);assert.strictEqual(result.game_info_refresh_worker.reason, 'launch_failed');assert.deepStrictEqual(calls('refreshWorker')[0].user_ids, []);

    // Authorization validity, aliases, and product/account indexes preserve the
    // old mappings used by the refresh task's product lookup.
    for (const name of ['resolveUuzuhaoAuthByUser', 'resolveUhaozuAuthByUser', 'resolveZuhaowangAuthByUser', 'resolveFiveEAuthByUser']) {
        reset();await assert.rejects(order[name](0), /user_id/);assert(await order[name](8));
        for (const auth of [[], [{ platform: 'uuzuhao', auth_status: 'expired' }], [{ platform: 'uuzuhao', auth_status: 'valid', channel_enabled: false }], [{ platform: 'uuzuhao', auth_status: 'valid', expire_at: '2000-01-01' }]]) { s.auth = auth;await assert.rejects(order[name](8), /缺少/); }
    }
    reset();s.auth = [{ platform: 'zuhaowang-yuanbao', auth_status: 'valid', expire_at: 'invalid', auth_payload: {} }];
    assert.strictEqual((await order.resolveZuhaowangAuthByUser(8)).normalized, true);
    s.auth.push({ platform: 'zuhaowang-yuanbao', auth_status: 'valid' }, { platform: 'unknown', auth_status: 'valid' });
    result = await order.syncOrdersByUser(8, { now: fixedNow });assert.deepStrictEqual(result.order_3_off_gate.expected, ['zuhaowang']);
    reset();s.accounts = [s.accounts[0], { game_account: 'QQ1', account_remark: '第二角色', channel_prd_info: { uuzuhao: { prd_id: 'YY1' }, uhaozu: { prd_id: 'UH1' }, '5e': { prd_id: 'STEAM1' } } }, { game_account: '' }];
    assert.strictEqual((await order.buildUuzuhaoProductIndex(8)).get('YY1').role_name, '角色');
    assert.strictEqual((await order.buildUhaozuProductIndex(8)).get('UH1').game_account, 'QQ1');
    assert.strictEqual((await order.buildZuhaowangAccountIndex(8)).get('QQ1').role_name, '角色');
    assert.strictEqual((await order.buildFiveEProductIndex(8)).get('STEAM1').game_account, 'QQ1');

    // Complaint hydration, first-hit notification, notification isolation, and
    // detail failures do not drop a valid source order.
    reset();s.raw.uuzuhao = [yy('C1', { complaintStatus: 1 }), yy('C1', { complaintStatus: 1 }), yy('C2', { productId: 'missing', complaintId: 'C2' }), yy('', {}), yy('PLAIN')];
    const notifyUser = { id: 8, account: 'fixture', name: 'fixture', notify_config: { dingding: { webhook: 'fixture://not-a-real-webhook', secret: 'fixture' } } };
    result = await order.syncUuzuhaoOrdersToDb(8, { user: notifyUser, price_ladder_enabled: true, updateStartTime: 100, updateEndTime: 200 });
    assert.strictEqual(result.upserted, 4);assert.strictEqual(result.linked, 3);assert.strictEqual(result.unlinked, 1);assert.strictEqual(result.complaint.notify_sent, 2);
    assert.strictEqual(calls('yyDetail').length, 3);assert.strictEqual(calls('notifyStyle')[0].complaint_start_time.length, 19);assert.strictEqual(calls('uuzuhao')[0].updateStartTime, 100);
    s.raw.uuzuhao = [yy('NEW', { complaintStatus: 1 })];s.fail.notify = true;s.yyDetail.complaintStartTime *= 1000;
    result = await order.syncUuzuhaoOrdersToDb(8, { user: notifyUser });assert.strictEqual(result.complaint.notify_fail, 1);assert.strictEqual(result.complaint.detail_ok, 1);
    s.fail.yyDetail = true;
    result = await order.syncUuzuhaoOrdersToDb(8);assert.strictEqual(result.complaint.detail_fail, 1);assert.strictEqual(result.upserted, 1);
    reset();s.raw.uuzuhao = null;result = await order.syncUuzuhaoOrdersToDb(8);assert.strictEqual(result.pulled, 0);

    // Uhaozu detail hydration rewrites net revenue only when numeric, and isolates
    // a failed detail request from successful sibling orders.
    reset();s.raw.uhaozu = [uh(), uh('UNLINKED', { goodsId: '?' }), uh('')];s.pending = [{ order_no: '' }, { order_no: 'UH-ORDER' }, { order_no: 'BAD' }];s.fail['uhDetail:BAD'] = true;
    result = await order.syncUhaozuOrdersToDb(8, { price_ladder_enabled: true, startDate: '2026-11-01', endDate: '2026-11-12' });
    assert.strictEqual(result.upserted, 2);assert.strictEqual(result.unlinked, 1);assert.strictEqual(result.detail_sync.failed, 1);assert.strictEqual(result.detail_sync.rec_amount_rewritten, 1);
    s.uhDetail.net_rent_amount = 'not numeric';s.pending = [{ order_no: 'NON-NUM' }];
    result = await order.syncUhaozuOrdersToDb(8);assert.strictEqual(result.detail_sync.rec_amount_rewritten, 0);
    s.orders.set(key(8, 'uhaozu', 'ON-DEMAND'), { order_status: '已完成' });s.uhDetail.net_rent_amount = 7;
    result = await order.getOrderDetailViewByUser(8, { channel: 'UHAOZU', orderNo: 'ON-DEMAND' });
    assert.strictEqual(result.detail.net_rent_amount, 7);assert.strictEqual(calls('recAmount').at(-1).amount, 7);
    s.orders.set(key(8, 'uhaozu', 'FAIL'), { order_status: '部分完成' });s.fail.uhDetail = true;
    result = await order.getOrderDetailViewByUser(8, { channel: 'uhaozu', order_no: 'FAIL' });assert.strictEqual(result.detail, null);
    s.complaints.set(key(8, 'uuzuhao', 'COMPLAINT'), { complaint_id: 'C1' });
    assert.strictEqual((await order.getOrderComplaintDetailByUser(8, { channel: 'UUZUHAO', orderNo: 'COMPLAINT' })).complaint_id, 'C1');
    for (const fn of ['getOrderDetailViewByUser', 'getOrderComplaintDetailByUser']) {
        await assert.rejects(order[fn](0), /user_id/);await assert.rejects(order[fn](8), /channel/);await assert.rejects(order[fn](8, { channel: 'uuzuhao' }), /order_no/);
    }

    // Zuhaowang supports encrypted page payloads, plain pagination, direct one
    // page, short pages and absent lists; all maintain their original watermark.
    reset();s.raw.zuhaowang = (_, n) => n === 1 ? [zw(), zw('UNLINKED', { accountNo: 'QQ2' }), zw('')] : [];
    result = await order.syncZuhaowangOrdersToDb(8, { page_payloads: [{ ak: 'fixture1' }, { ak: 'fixture2' }, { ak: 'unused' }], price_ladder_enabled: true });
    assert.strictEqual(calls('zuhaowang').length, 2);assert.strictEqual(result.upserted, 2);assert.strictEqual(result.unlinked, 1);
    reset();s.raw.zuhaowang = (_, n) => n === 1 ? [zw('P1')] : n === 2 ? [zw('P2')] : [];
    result = await order.syncZuhaowangOrdersToDb(8, { request_payload: { pageNum: 3, pageSize: 1 }, maxPages: 3 });
    assert.deepStrictEqual(calls('zuhaowang').map(x => x.pageNum), [3, 4, 5]);assert.strictEqual(result.pulled, 2);
    reset();s.raw.zuhaowang = [zw()];result = await order.syncZuhaowangOrdersToDb(8, { auto_paginate: false, request_payload: { ak: 'fixture' } });assert.strictEqual(result.pulled, 1);
    reset();s.raw.zuhaowang = null;assert.strictEqual((await order.syncZuhaowangOrdersToDb(8)).pulled, 0);
    for (const fn of ['syncUuzuhaoOrdersToDb', 'syncUhaozuOrdersToDb', 'syncZuhaowangOrdersToDb', 'syncFiveEOrdersToDb', 'syncOrdersByUser', 'reconcileOrder3OffBlacklistByUser', 'reconcileOrderOffByUser']) await assert.rejects(order[fn](0), /user_id/);

    // SQL boundaries assert filtering, bind values and pagination, while the
    // existing SQLite suites verify actual row selection and compatibility.
    reset();freeze('2026-11-12T05:30:00+08:00');
    for (const filter of ['today', 'yesterday', 'last24h', 'week', 'last7', 'month', 'last30', 'unknown']) {
        result = await order.listOrdersForUser(8, { quick_filter: filter, status_filter: 'progress', game_name: 'all', page: 2, page_size: 5 });
        assert(result.range.start < result.range.end);assert.strictEqual(result.stats.progress_order_amount_sum, 15);assert.strictEqual(result.list[0].has_complaint, true);assert.strictEqual(result.list[1].has_complaint, false);
        assert.deepStrictEqual(calls('dbAll').at(-1).params.slice(-2), [5, 5]);assert(calls('dbAll').at(-1).sql.includes("('租赁中', '出租中')"));
    }
    for (const status of ['refund', 'done', 'bad']) {
        result = await order.listOrdersForUser(8, { status_filter: status, game_name: 'WZRY' });
        assert.strictEqual(result.status_filter, status === 'bad' ? 'all' : status);assert.strictEqual(result.stats.progress_order_amount_sum, 0);assert.strictEqual(calls('dbAll').at(-1).params[1], 'WZRY');
    }
    await assert.rejects(order.listOrdersForUser(0), /user_id/);
    for (const point of ['dbGet', 'dbAll']) {
        // Deliberate callback errors exercise finally-close (rather than a
        // synchronous stub throw before the callback contract is used).
        s.dbCallbackFailure = point;
        const before = calls('dbClose').length;await assert.rejects(order.listOrdersForUser(8), /fixture callback/);assert.strictEqual(calls('dbClose').length, before + 1);
        delete s.dbCallbackFailure;
    }
    for (const [status, progress, refund, done] of [['租赁中', true, false, false], ['出租中', true, false, false], ['已退款', false, true, true], ['部分完成', false, false, true], ['已完成', false, false, true], ['投诉/撤单', false, false, true], ['已撤单', false, false, true], ['结算中', false, false, false]]) {
        assert.strictEqual(order.isOrderProgressStatus(status), progress);assert.strictEqual(order.isOrderRefundStatus(status), refund);assert.strictEqual(order.isOrderDoneStatus(status), done);
    }
    assert.strictEqual(order.shouldSyncUhaozuOrderDetailByStatus('结算中'), false);

    // Rule reconciliation: account overrides, sold assets, lower counts, and
    // blocked recovery all retain their expected source ledger operations.
    reset();s.accounts.push({ game_account: 'SOLD', asset_status: 'sold' }, { game_account: '' }, { game_account: 'QQ2', game_id: '1', switch: { order_n_off: { threshold: 2, mode: 'rolling_24h' } } });
    s.rules['X单下架阈值'] = { rule_detail: { threshold: 3, mode: 'natural_day' } };s.counts = { '1::QQ1': 3, '1::QQ2': 2 };
    s.blacklist = [{ game_id: '1', game_account: 'OLD', reason: '3单下架' }, { game_account: 'OTHER', reason: '手工' }];
    result = await order.reconcileOrder3OffBlacklistByUser({ id: 8 });assert.strictEqual(result.added, 2);assert.strictEqual(result.deleted, 1);assert.strictEqual(calls('counts').length, 2);
    assert.strictEqual(calls('blacklist').filter(args => args[3].active === true).length, 2);
    for (const detail of [{ begin_time: '00:00', end_time: '00:00' }, { begin_time: '04:00', end_time: '06:00' }, { begin_time: '23:00', end_time: '07:00' }]) {
        s.calls = [];s.rules['3单下架-不恢复时段'] = { rule_detail: detail };
        result = await order.reconcileOrder3OffBlacklistByUser({ id: 8, switch: { order_3_off: false } });assert.strictEqual(result.delete_blocked, 1);assert.strictEqual(result.deleted, 0);
    }
    s.rules['3单下架-不恢复时段'] = { rule_detail: { begin_time: 'bad', end_time: '25:00' } };
    result = await order.reconcileOrder3OffBlacklistByUser({ id: 8, switch: { order_3_off: false } });assert.strictEqual(result.deleted, 1);
    s.cooldown = { hit_accounts: 1, added: 1, updated: 1 };s.rules['3单下架-不恢复时段'] = { rule_detail: {} };
    result = await order.reconcileOrderOffByUser({ id: 8 });assert.deepStrictEqual(result.summary.active_rules, ['order_cooldown', 'order_n_off']);
    reset();s.accounts = [];result = await order.reconcileOrder3OffBlacklistByUser({ id: 8 });assert.strictEqual(result.total_accounts, 0);assert.strictEqual(calls('counts').length, 0);

    // Scheduling boundaries and launcher assertions do not execute a child.
    reset();assert.strictEqual(order.shouldTriggerOrderSyncNow({ now: new Date('2026-11-12T12:00:00+08:00') }), true);
    assert.strictEqual(order.shouldTriggerOrderSyncNow({ now: new Date('2026-11-12T12:02:30+08:00'), window_sec: 10 }), false);
    assert.strictEqual(order.shouldTriggerOrderSyncNow({ force: true }), true);
    assert.strictEqual(order.shouldTriggerZuhaowangDailyCompensationNow({ now: new Date('2026-11-12T03:00:00+08:00') }), false);
    assert.strictEqual(order.shouldTriggerZuhaowangDailyCompensationNow({ now: fixedNow, last_sync_ts: fixedNow.getTime() / 1000, force: true }), false);
    assert.strictEqual(order.startOrderSyncWorkerIfNeeded({ enabled: false }).reason, 'disabled');
    freeze('2026-11-12T12:02:30+08:00');assert.strictEqual(order.startOrderSyncWorkerIfNeeded({ enabled: true, window_sec: 10 }).reason, 'out_of_window');
    s.exists = false;assert.strictEqual(order.startOrderSyncWorkerIfNeeded({ enabled: true, force: true }).reason, 'worker_missing');s.exists = true;
    const record = {};result = order.startOrderSyncWorkerIfNeeded({ enabled: true, force: true, task_dir: tmp, run_record: record });
    assert.strictEqual(result.pid, 22);assert.strictEqual(record.actions.length, 1);assert.strictEqual(calls('fork')[0].options.detached, true);assert.strictEqual(calls('unref').length, 1);
    result = order.startOrderSyncWorkerIfNeeded({ enabled: true, force: true });assert.strictEqual(result.triggered, true);
    originalConsole.log('PASS order refresh integration and whole order orchestrator regression');
}
main().catch(error => { originalConsole.error(error);process.exitCode = 1; }).finally(() => {
    Module._load = originalLoad;Object.assign(console, originalConsole);global.Date = RealDate;
});
