'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'game-info-service-'));
for (const key of ['MAIN', 'RUNTIME', 'ORDER', 'STATS', 'PRICE']) process.env[`${key}_DB_FILE_PATH`] = path.join(dir, `${key}.db`);
global.fetch = async () => { throw new Error('real network is forbidden'); };
const policyApi = require('../order/game_info_refresh_policy');
const service = require('../order/game_info_refresh_service');
const ledger = require('../database/order_game_info_refresh_db');
const { initOrderDb, upsertOrder } = require('../database/order_db');
const NOW = new Date('2026-11-12T16:00:00');
const activation = '2026-11-12 14:00:00';
const policy = policyApi.normalizeGameInfoRefreshPolicy({ enabled: true, user_ids: [8], activated_at: activation });
const copy = value => JSON.parse(JSON.stringify(value));
let cases = 0;

function harness() {
    const order = { id: 1, user_id: 8, channel: 'uuzuhao', order_no: 'O1', game_id: '1', game_name: 'WZRY', game_account: 'QQ-A', order_status: '已完成', start_time: '2026-11-12 15:00:00', end_time: '2026-11-12 15:30:00', is_deleted: 0 };
    const task = { ...order, business_scene: 'order_game_info_refresh', target_channel: 'uuzuhao', source_channel: order.channel, target_product_id: '202611121234567890', status: 'pending', attempted_at: '', observed_active_at: '', sync_token: 'fixture-sync', sync_ready: 1 };
    const account = { user_id: 8, game_id: '1', game_account: 'QQ-A', channel_prd_info: { uuzuhao: { prd_id: task.target_product_id } }, uuzuhao_auth_state: { required: false } };
    const authRows = [{ platform: 'uuzuhao', channel_enabled: true, auth_status: 'valid', expire_at: '', auth_payload: { app_key: 'fixture-key', app_secret: 'fixture-secret' } }];
    const state = { order, task, account, authRows, policy, sources: [order], tasks: [task], apiCalls: [], releases: [], locks: [], finishes: [], defers: [], skips: [], observed: [], enqueued: [], progress: [], logs: [], begins: [], completes: [], observationOptions: [], enqueueOptions: [] };
    const d = {
        loadGameInfoRefreshPolicy: async () => state.policy,
        initOrderGameInfoRefreshDb: async () => {},
        beginRefreshOrderSync: async (uid, opts) => {
            state.begins.push({ uid, ...opts });
            for (const t of state.tasks) if (t.user_id === uid && !t.attempted_at) { t.sync_token = opts.token; t.sync_ready = 0; }
            return { changes: state.tasks.length };
        },
        completeRefreshOrderSync: async (uid, opts) => {
            state.completes.push({ uid, ...opts }); let changes = 0;
            for (const t of state.tasks) if (t.user_id === uid && t.sync_token === opts.token && !t.attempted_at) { t.sync_ready = 1; changes++; }
            return { changes };
        },
        getActiveUserById: async () => ({ id: 8, status: 'enabled' }),
        listSourceOrdersForRefresh: async (_uid, opts) => state.sources.filter(o => o.id > opts.after_id).slice(0, opts.limit).map(o => ({ ...o, observed_active_at: state.tasks.find(t => t.order_no === o.order_no)?.observed_active_at || '' })),
        observeActiveOrder: async (input, opts) => { state.observed.push(input); state.observationOptions.push(opts); const t = state.tasks.find(t => t.order_no === input.order_no); if (t && !t.attempted_at) { t.status = 'watching'; t.observed_active_at = '2026-11-12 15:59:00'; } },
        enqueueRefreshOrder: async (input, opts) => { state.enqueued.push(input); state.enqueueOptions.push(opts); return { created: true, queued: true, row: input }; },
        getLatestUserGameAccountByUserAndAccount: async () => state.account,
        recoverStaleRefreshAttempts: async () => ({ changes: 0 }),
        listPendingRefreshTasks: async () => state.tasks.filter(t => t.status === 'pending' && !t.attempted_at && t.sync_ready === 1).map(copy),
        getSourceOrder: async () => state.order,
        listUserPlatformAuth: async () => state.authRows,
        getLastSyncTimestamp: async () => NOW.getTime() / 1000,
        listRentingWindowByAccounts: async () => ({}),
        assertUuzuhaoBackgroundOperationAllowed: async () => {},
        tryAcquireLock: async (key, lease, owner) => { state.locks.push({ key, lease, owner }); return { acquired: true }; },
        releaseOwnedLock: async (key, owner) => { state.releases.push({ key, owner }); return true; },
        claimRefreshAttempt: async (id, opts) => { const t = state.tasks.find(t => t.id === id); if (!t || t.status !== 'pending' || t.attempted_at || t.sync_ready !== 1 || !opts.sync_token || t.sync_token !== opts.sync_token) return null; t.status = 'sending'; t.attempted_at = NOW.toISOString(); return { ...t }; },
        finishRefreshAttempt: async (id, result) => { state.finishes.push({ id, ...result }); const t = state.tasks.find(t => t.id === id); if (t.status !== 'sending') return false; t.status = result.status; return true; },
        deferRefreshTask: async (id, result) => { state.defers.push({ id, ...result }); return true; },
        skipRefreshTask: async (id, result) => { state.skips.push({ id, ...result }); return true; },
        updateProductGameInfo: async (productId, options) => { state.apiCalls.push({ productId, options }); return { product_id: productId, data: { gameAccountInfoList: [{ itemValue: 'private-account-value' }] }, raw: { code: 0, msg: '成功 fixture-key fixture-secret' } }; }
    };
    const options = { now: NOW, sync_token: 'fixture-sync', deps: d, logger: { warn: value => state.logs.push(value) } };
    return { state, d, options };
}
async function caseOf(name, run) { await run(); cases++; }
async function outcome(setup, expected, reason) {
    const h = harness(); await setup(h); const result = await service.processGameInfoRefreshTasks(h.options);
    assert.strictEqual(result[expected], 1, JSON.stringify(result));
    if (reason) assert.strictEqual(result.results[0].reason, reason);
    assert.strictEqual(h.state.apiCalls.length, expected === 'success' ? 1 : 0);
    return h;
}

async function main() {
    await caseOf('successful request and permanent attempt record', async () => {
        const h = harness(); const out = await service.processGameInfoRefreshTasks(h.options);
        assert.strictEqual(out.success, 1); assert.strictEqual(out.claimed, 1);
        assert.strictEqual(h.state.apiCalls[0].productId, '202611121234567890');
        assert.strictEqual(h.state.apiCalls[0].options.auth.timeout_ms, 15000);
        assert.strictEqual(h.state.locks[0].key, 'order_game_info_refresh:uuzuhao:8:uuzuhao:O1');
        assert(h.state.locks[0].lease > 15); assert(/^pid=\d+ refresh=/.test(h.state.locks[0].owner));
        assert.deepStrictEqual(h.state.releases[0], { key: h.state.locks[0].key, owner: h.state.locks[0].owner });
        assert.strictEqual(h.state.finishes[0].message, '成功 [REDACTED] [REDACTED]');
        assert.deepStrictEqual(h.state.finishes[0].summary, { data_type: 'object', game_account_info_count: 1 });
        assert(!JSON.stringify(h.state.finishes).includes('private-account-value'));
        assert.strictEqual((await service.processGameInfoRefreshTasks(h.options)).runnable, 0);
        assert.strictEqual(h.state.apiCalls.length, 1);
    });
    for (const status of ['已完成', '部分完成', '已退款', '已撤单', '投诉/撤单']) {
        await caseOf(status + ' at exactly twenty minutes', async () => {
            const h = harness(); h.state.order.order_status = status; h.state.order.end_time = '2026-11-12 15:20:00';
            assert.strictEqual((await service.processGameInfoRefreshTasks(h.options)).success, 1);
        });
    }
    for (const channel of ['uuzuhao', 'uhaozu', 'zuhaowang', '5e']) {
        await caseOf('source isolation ' + channel, async () => {
            const h = harness(); h.state.order.channel = channel; h.state.task.source_channel = channel;
            if (channel !== 'uuzuhao') h.state.authRows.push({ platform: channel === 'zuhaowang' ? 'zuhaowang-yuanbao' : channel, auth_status: 'valid', channel_enabled: true });
            assert.strictEqual((await service.processGameInfoRefreshTasks(h.options)).success, 1);
            assert(h.state.locks[0].key.includes(':' + channel + ':'));
        });
    }
    for (const [label, configure, expected] of [
        ['disabled', h => { h.state.policy = { available: true, enabled: false, user_ids: [8], reason: 'disabled' }; }, 'disabled'],
        ['missing', h => { h.state.policy = { available: false, enabled: false }; }, 'disabled'],
        ['empty gray list', h => { h.state.policy = { ...policy, user_ids: [] }; }, 'disabled']
    ]) await caseOf(label, async () => { const h = harness(); configure(h); const out = await service.processGameInfoRefreshTasks(h.options); assert.strictEqual(out[expected], true); assert.strictEqual(h.state.locks.length, 0); });
    await caseOf('policy changed after queue listing', async () => {
        const h = harness(); let calls = 0; h.d.loadGameInfoRefreshPolicy = async () => ++calls === 1 ? policy : { ...policy, enabled: false };
        assert.strictEqual((await service.processGameInfoRefreshTasks(h.options)).claimed, 0); assert.strictEqual(h.state.locks.length, 0);
    });
    await caseOf('worker stopped before picking', async () => {
        const h = harness(); h.options.should_stop = () => true;
        assert.strictEqual((await service.processGameInfoRefreshTasks(h.options)).results.length, 0); assert.strictEqual(h.state.apiCalls.length, 0);
    });
    await caseOf('worker stop before send', async () => {
        let calls = 0; await outcome(h => { h.options.should_stop = () => ++calls > 1; }, 'deferred', 'policy_or_worker_changed');
    });
    await caseOf('config closes during preflight', async () => {
        await outcome(h => { h.d.listRentingWindowByAccounts = async () => { h.state.policy = { ...policy, enabled: false }; return {}; }; }, 'deferred', 'policy_or_worker_changed');
    });
    const casesBeforeSend = [
        ['other business', h => { h.state.task.business_scene = 'other_scene'; }, 'skipped', 'different_business'],
        ['other target', h => { h.state.task.target_channel = 'other_target'; }, 'skipped', 'different_business'],
        ['lock busy', h => { h.d.tryAcquireLock = async () => ({ acquired: false }); }, 'deferred', 'order_locked'],
        ['missing order', h => { h.d.getSourceOrder = async () => null; }, 'skipped', 'order_missing'],
        ['deleted order', h => { h.state.order.is_deleted = 1; }, 'skipped', 'order_missing'],
        ['changed game', h => { h.state.order.game_id = '2'; }, 'skipped', 'order_identity_changed'],
        ['changed source owner', h => { h.state.order.user_id = 9; }, 'skipped', 'order_identity_changed'],
        ['changed source channel', h => { h.state.order.channel = 'uhaozu'; }, 'skipped', 'order_identity_changed'],
        ['changed source order', h => { h.state.order.order_no = 'OTHER'; }, 'skipped', 'order_identity_changed'],
        ['changed account', h => { h.state.order.game_account = 'OTHER'; }, 'skipped', 'order_identity_changed'],
        ['short duration', h => { h.state.order.end_time = '2026-11-12 15:19:59'; }, 'deferred', 'order_not_eligible'],
        ['settling', h => { h.state.order.order_status = '结算中'; }, 'deferred', 'order_not_eligible'],
        ['future end', h => { h.state.order.end_time = '2026-11-12 16:01:00'; }, 'deferred', 'order_not_eligible'],
        ['bad end', h => { h.state.order.end_time = ''; }, 'deferred', 'order_not_eligible'],
        ['user disabled', h => { h.d.getActiveUserById = async () => ({ status: 'disabled' }); }, 'deferred', 'user_unavailable'],
        ['user missing', h => { h.d.getActiveUserById = async () => null; }, 'deferred', 'user_unavailable'],
        ['empty authorizations', h => { h.state.authRows = []; }, 'deferred', 'platform_authorization_unavailable'],
        ['invalid authorization', h => { h.state.authRows[0].auth_status = 'expired'; }, 'deferred', 'platform_authorization_unavailable'],
        ['expired authorization', h => { h.state.authRows[0].expire_at = '2026-11-12 15:59:00'; }, 'deferred', 'platform_authorization_unavailable'],
        ['invalid expiry', h => { h.state.authRows[0].expire_at = 'invalid'; }, 'deferred', 'platform_authorization_unavailable'],
        ['source disabled', h => { h.state.task.source_channel = 'uhaozu'; h.state.order.channel = 'uhaozu'; }, 'deferred', 'source_channel_unavailable'],
        ['missing target auth', h => { h.state.authRows = [{ platform: 'uhaozu', channel_enabled: true, auth_status: 'valid' }]; h.state.order.channel = 'uhaozu'; h.state.task.source_channel = 'uhaozu'; }, 'deferred', 'uuzuhao_authorization_unavailable'],
        ['missing auth secret', h => { delete h.state.authRows[0].auth_payload.app_secret; }, 'deferred', 'uuzuhao_authorization_unavailable'],
        ['stale orders', h => { h.d.getLastSyncTimestamp = async () => NOW.getTime() / 1000 - 721; }, 'deferred', 'order_snapshot_stale'],
        ['zero watermark', h => { h.d.getLastSyncTimestamp = async () => 0; }, 'deferred', 'order_snapshot_stale'],
        ['future watermark', h => { h.d.getLastSyncTimestamp = async () => NOW.getTime() / 1000 + 61; }, 'deferred', 'order_snapshot_stale'],
        ['missing account', h => { h.state.account = null; }, 'skipped', 'account_missing_or_changed'],
        ['other owner account', h => { h.state.account.user_id = 9; }, 'skipped', 'account_missing_or_changed'],
        ['missing product', h => { h.state.account.channel_prd_info = {}; }, 'skipped', 'product_missing'],
        ['product recreated', h => { h.state.account.channel_prd_info.uuzuhao.prd_id = 'new-product'; }, 'skipped', 'product_changed'],
        ['authorization paused marker', h => { h.state.account.uuzuhao_auth_state.required = true; }, 'deferred', 'authorization_paused'],
        ['authorization paused product', h => { h.state.account.channel_prd_info.uuzuhao.off_type = 'ACCOUNT_ERROR'; }, 'deferred', 'authorization_paused'],
        ['active second order', h => { h.d.listRentingWindowByAccounts = async () => ({ '1::QQ-A': { count: 1 } }); }, 'deferred', 'account_renting'],
        ['claim lost', h => { h.d.claimRefreshAttempt = async () => null; }, 'skipped', 'already_claimed'],
        ['background guard throws', h => { h.d.assertUuzuhaoBackgroundOperationAllowed = async () => { throw Object.assign(new Error('fixture-secret'), { code: 'UUZUHAO_AUTHORIZATION_PAUSED' }); }; }, 'deferred', 'preflight_unavailable'],
        ['lock storage fails', h => { h.d.tryAcquireLock = async () => { throw new Error('fixture DB failure'); }; }, 'deferred', 'preflight_unavailable']
    ];
    for (const [name, configure, expected, reason] of casesBeforeSend) await caseOf(name, async () => { await outcome(configure, expected, reason); });
    await caseOf('active order resumes watching', async () => {
        const h = await outcome(h => { h.state.order.order_status = '租赁中'; }, 'deferred', 'order_active_again');
        assert.strictEqual(h.state.task.status, 'watching'); assert.strictEqual(h.state.observed[0].order_status, '租赁中');
    });
    for (const [name, error, expected] of [
        ['business failure', Object.assign(new Error('do-not-log'), { code: '12102012', uuzuhao_response: { code: 12102012, msg: 'fixture-key fixture-secret' } }), 'failed'],
        ['HTTP failure', Object.assign(new Error('HTTP 503'), { code: '503', uuzuhao_response: { code: 503 } }), 'failed'],
        ['timeout', new DOMException('remote outcome unknown', 'AbortError'), 'unknown'],
        ['network failure', new TypeError('do-not-log'), 'unknown']
    ]) await caseOf(name + ' no retry', async () => {
        const h = harness(); h.d.updateProductGameInfo = async (...args) => { h.state.apiCalls.push(args); throw error; };
        const out = await service.processGameInfoRefreshTasks(h.options); assert.strictEqual(out[expected], 1); assert.strictEqual(h.state.apiCalls.length, 1);
        assert.strictEqual((await service.processGameInfoRefreshTasks(h.options)).runnable, 0); assert.strictEqual(h.state.apiCalls.length, 1);
        assert(!JSON.stringify(h.state.finishes).includes('fixture-secret')); assert(!JSON.stringify(h.state.logs).includes('do-not-log'));
    });
    for (const response of [null, {}, { raw: { code: '0' } }]) await caseOf('malformed successful client response', async () => {
        const h = harness(); h.d.updateProductGameInfo = async () => response;
        assert.strictEqual((await service.processGameInfoRefreshTasks(h.options)).failed, 1);
    });
    for (const data of [null, [], 'opaque', {}]) await caseOf('safe response metadata for ' + typeof data, async () => {
        const h = harness(); h.d.updateProductGameInfo = async () => ({ data, raw: { code: 0 } });
        assert.strictEqual((await service.processGameInfoRefreshTasks(h.options)).success, 1);
        assert.strictEqual(h.state.finishes[0].summary.game_account_info_count, null);
    });
    await caseOf('send result persistence failure does not resend', async () => {
        const h = harness(); h.d.finishRefreshAttempt = async () => { throw new Error('DB unavailable'); };
        assert.strictEqual((await service.processGameInfoRefreshTasks(h.options)).unknown, 1);
        assert.strictEqual((await service.processGameInfoRefreshTasks(h.options)).runnable, 0); assert.strictEqual(h.state.apiCalls.length, 1);
    });
    await caseOf('finish CAS lost', async () => { const h = harness(); h.d.finishRefreshAttempt = async () => false; assert.strictEqual((await service.processGameInfoRefreshTasks(h.options)).unknown, 1); });
    await caseOf('deferral and owner release failures stay safe', async () => {
        const h = harness(); h.d.assertUuzuhaoBackgroundOperationAllowed = async () => { throw new Error('no'); }; h.d.deferRefreshTask = async () => { throw new Error('DB no'); }; h.d.releaseOwnedLock = async () => { throw new Error('lock no'); };
        assert.strictEqual((await service.processGameInfoRefreshTasks(h.options)).deferred, 1); assert.strictEqual(h.state.apiCalls.length, 0); assert(h.state.logs.length >= 2);
    });
    await caseOf('progress callback failure stops batch without reopening attempt', async () => {
        const h = harness(); h.state.tasks.push({ ...h.state.task, id: 2 }); h.options.on_progress = async () => { throw new Error('worker lease lost'); };
        const out = await service.processGameInfoRefreshTasks(h.options); assert.strictEqual(out.success, 1); assert.strictEqual(out.results.length, 1); assert.strictEqual(h.state.apiCalls.length, 1);
    });
    await caseOf('successful progress callback', async () => { const h = harness(); h.options.on_progress = async value => h.state.progress.push(value); await service.processGameInfoRefreshTasks(h.options); assert.strictEqual(h.state.progress.length, 1); });
    await caseOf('stale sending recovered as unknown', async () => { const h = harness(); h.d.recoverStaleRefreshAttempts = async () => ({ changes: 2 }); h.state.tasks = []; const out = await service.processGameInfoRefreshTasks(h.options); assert.strictEqual(out.unknown, 2); assert.strictEqual(out.claimed, 0); });
    await caseOf('overlapping workers and expired lock still use CAS', async () => {
        const h = harness(); let release; const finish = new Promise(resolve => { release = resolve; }); let entered; const started = new Promise(resolve => { entered = resolve; });
        h.d.listPendingRefreshTasks = async () => [h.state.task]; // both can observe the same queued row
        h.d.updateProductGameInfo = async (...args) => { h.state.apiCalls.push(args); entered(); await finish; return { raw: { code: 0 } }; };
        const first = service.processGameInfoRefreshTasks(h.options); await started;
        const second = await service.processGameInfoRefreshTasks(h.options); assert.strictEqual(second.skipped, 1); release(); await first;
        assert.strictEqual(h.state.apiCalls.length, 1); assert.strictEqual(h.state.task.status, 'success'); assert.strictEqual(h.state.releases.length, 2);
    });
    await caseOf('prepare watches old active orders and preserves status audit', async () => {
        const h = harness(); h.state.order.order_status = '租赁中'; h.state.order.start_time = '2026-11-12 13:00:00';
        const out = await service.prepareGameInfoRefreshByUser(8, h.options); assert.strictEqual(out.observed, 1); assert.strictEqual(h.state.observed[0].order_status, '租赁中'); assert.strictEqual(h.state.apiCalls.length, 0);
        assert.strictEqual(h.state.begins[0].token, out.sync_token); assert.strictEqual(h.state.observationOptions[0].sync_token, out.sync_token);
        assert.strictEqual(h.state.task.sync_ready, 0); assert.strictEqual(h.state.completes.length, 0);
    });
    await caseOf('prepare skips disabled user/config', async () => {
        const h = harness(); h.state.policy = { ...policy, enabled: false }; assert.strictEqual((await service.prepareGameInfoRefreshByUser(8, h.options)).skipped, true);
        h.state.policy = policy; h.d.getActiveUserById = async () => null; assert.strictEqual((await service.prepareGameInfoRefreshByUser(8, h.options)).skipped, true);
    });
    await caseOf('malformed active identities are not observed', async () => {
        const h = harness(); h.state.order.order_status = '租赁中';
        h.state.sources = [
            { ...h.state.order, user_id: 9 }, { ...h.state.order, is_deleted: 1 },
            { ...h.state.order, channel: 'unknown' }, { ...h.state.order, game_id: 'bad' },
            { ...h.state.order, game_account: '' }, { ...h.state.order, order_no: '' }
        ];
        assert.strictEqual((await service.prepareGameInfoRefreshByUser(8, h.options)).observed, 0);
    });
    await caseOf('reconcile requires complete platform sync', async () => { const h = harness(); assert.strictEqual((await service.reconcileGameInfoRefreshByUser(8, h.options)).reason, 'order_sync_incomplete'); assert.strictEqual(h.state.enqueued.length, 0); });
    for (const missing of [undefined, '', '  ', 7]) await caseOf('reconcile requires the prepared sync context', async () => {
        const h = harness(); h.options.sync_complete = true; h.options.sync_token = missing;
        assert.strictEqual((await service.reconcileGameInfoRefreshByUser(8, h.options)).reason, 'sync_context_missing');
        assert.strictEqual(h.state.enqueued.length, 0); assert.strictEqual(h.state.completes.length, 0);
    });
    await caseOf('failed current sync blocks an old pending task despite fresh old watermarks', async () => {
        const h = harness(); const prepared = await service.prepareGameInfoRefreshByUser(8, h.options);
        const reconciliation = await service.reconcileGameInfoRefreshByUser(8, { ...h.options, sync_token: prepared.sync_token, sync_complete: false });
        assert.strictEqual(reconciliation.reason, 'order_sync_incomplete'); assert.strictEqual(h.state.completes.length, 0);
        assert.strictEqual((await service.processGameInfoRefreshTasks(h.options)).runnable, 0); assert.strictEqual(h.state.apiCalls.length, 0);
    });
    await caseOf('new sync during an old worker preflight fences the old claim', async () => {
        const h = harness(); let prepared;
        h.d.listRentingWindowByAccounts = async () => { prepared = await service.prepareGameInfoRefreshByUser(8, h.options); return {}; };
        const result = await service.processGameInfoRefreshTasks(h.options);
        assert.strictEqual(result.skipped, 1); assert.strictEqual(result.results[0].reason, 'already_claimed'); assert.strictEqual(result.claimed, 0);
        assert.strictEqual(h.state.task.sync_token, prepared.sync_token); assert.strictEqual(h.state.task.sync_ready, 0); assert.strictEqual(h.state.apiCalls.length, 0);
    });
    await caseOf('old worker token cannot claim even after the newer sync completes', async () => {
        const h = harness();
        h.d.listRentingWindowByAccounts = async () => {
            const prepared = await service.prepareGameInfoRefreshByUser(8, h.options);
            await h.d.completeRefreshOrderSync(8, { token: prepared.sync_token, now: NOW }); return {};
        };
        assert.strictEqual((await service.processGameInfoRefreshTasks(h.options)).claimed, 0);
        assert.strictEqual(h.state.task.sync_ready, 1); assert.strictEqual(h.state.apiCalls.length, 0);
    });
    await caseOf('source scan failure never completes a partially rebuilt queue', async () => {
        const h = harness(); const prepared = await service.prepareGameInfoRefreshByUser(8, h.options);
        h.options.batch_size = 1; h.options.sync_complete = true; h.options.sync_token = prepared.sync_token;
        h.d.listSourceOrdersForRefresh = async (_uid, opts) => {
            if (opts.after_id) throw new Error('fixture second page unavailable'); return [h.state.order];
        };
        await assert.rejects(() => service.reconcileGameInfoRefreshByUser(8, h.options), /second page unavailable/);
        assert.strictEqual(h.state.enqueued.length, 1); assert.strictEqual(h.state.completes.length, 0); assert.strictEqual(h.state.task.sync_ready, 0);
        assert.strictEqual((await service.processGameInfoRefreshTasks(h.options)).runnable, 0);
    });
    await caseOf('reconcile skips disabled', async () => { const h = harness(); h.options.sync_complete = true; h.state.policy = { ...policy, enabled: false }; assert.strictEqual((await service.reconcileGameInfoRefreshByUser(8, h.options)).skipped, true); });
    await caseOf('reconcile paginates and never sends API', async () => {
        const h = harness(); h.state.sources = [h.state.order, { ...h.state.order, id: 2, order_no: 'O2' }]; h.options.sync_complete = true; h.options.batch_size = 1;
        const out = await service.reconcileGameInfoRefreshByUser(8, h.options); assert.strictEqual(out.scanned, 2); assert.strictEqual(out.queued, 2); assert.strictEqual(h.state.apiCalls.length, 0);
        assert.strictEqual(h.state.enqueued[0].order_status, '已完成'); assert.strictEqual(h.state.enqueued[0].business_scene, 'order_game_info_refresh');
        assert(h.state.enqueueOptions.every(opts => opts.sync_token === h.options.sync_token)); assert.strictEqual(h.state.completes.length, 1);
    });
    await caseOf('reconcile observes active and ignores history/short/missing target', async () => {
        const h = harness(); h.options.sync_complete = true;
        h.state.sources = [{ ...h.state.order, order_status: '出租中', start_time: '2026-11-12 13:00:00' }, { ...h.state.order, id: 2, order_no: 'old', start_time: '2026-11-12 12:00:00', end_time: '2026-11-12 13:00:00' }];
        const out = await service.reconcileGameInfoRefreshByUser(8, h.options); assert.strictEqual(out.observed, 1); assert.strictEqual(out.queued, 0);
        assert.strictEqual(h.state.observationOptions[0].sync_token, h.options.sync_token);
        h.state.sources = [h.state.order]; h.state.account = null; assert.strictEqual((await service.reconcileGameInfoRefreshByUser(8, h.options)).queued, 0);
    });
    await caseOf('paused target can enqueue but not send', async () => {
        const h = harness(); h.state.account.uuzuhao_auth_state.required = true; h.options.sync_complete = true;
        const out = await service.reconcileGameInfoRefreshByUser(8, h.options); assert.strictEqual(out.queued, 1); assert.strictEqual(h.state.enqueued[0].target_product_id, h.state.task.target_product_id);
    });
    await caseOf('duplicate queue registration', async () => { const h = harness(); h.options.sync_complete = true; h.d.enqueueRefreshOrder = async () => ({ created: false, queued: false }); const out = await service.reconcileGameInfoRefreshByUser(8, h.options); assert.strictEqual(out.created, 0); assert.strictEqual(out.queued, 0); });
    await caseOf('non-progressing source cursor fails before unbounded scan', async () => {
        const h = harness(); h.options.batch_size = 1; h.state.order.order_status = '租赁中'; h.d.listSourceOrdersForRefresh = async () => [h.state.order];
        await assert.rejects(() => service.prepareGameInfoRefreshByUser(8, h.options), /游标/);
    });
    await caseOf('invalid clock rejects', async () => { const h = harness(); h.options.now = 'invalid'; await assert.rejects(() => service.prepareGameInfoRefreshByUser(8, h.options), /时间/); });
    await caseOf('expired filter does not reject valid future authorization', async () => { const h = harness(); h.state.authRows[0].expire_at = '2026-11-12 17:00:00'; assert.strictEqual((await service.processGameInfoRefreshTasks(h.options)).success, 1); });
    await realDatabaseRoundTrip();
    console.log(`[PASS] order_game_info_refresh_service_test: ${cases} cases; isolated DBs, no real network`);
}

async function realDatabaseRoundTrip() {
    await initOrderDb(); await ledger.initOrderGameInfoRefreshDb();
    const h = harness();
    const deps = { ...h.d, ...ledger };
    const options = { ...h.options, deps, sync_complete: true };
    const active = { ...h.state.order, order_no: 'REAL', start_time: '2026-11-12 13:30:00', end_time: '2026-11-12 15:30:00', order_status: '租赁中' };
    await upsertOrder(active);
    const prepared = await service.prepareGameInfoRefreshByUser(8, options);
    assert.strictEqual(prepared.observed, 1); options.sync_token = prepared.sync_token;
    await upsertOrder({ ...active, order_status: '已退款' });
    const queued = await service.reconcileGameInfoRefreshByUser(8, options); assert.strictEqual(queued.queued, 1);
    const failedRound = await service.prepareGameInfoRefreshByUser(8, options);
    options.sync_token = failedRound.sync_token;
    assert.strictEqual((await service.reconcileGameInfoRefreshByUser(8, { ...options, sync_complete: false })).reason, 'order_sync_incomplete');
    assert.strictEqual((await service.processGameInfoRefreshTasks(options)).runnable, 0, 'real ledger must fence old pending tasks after an unsuccessful sync');
    assert.strictEqual(h.state.apiCalls.length, 0);
    options.sync_token = (await service.prepareGameInfoRefreshByUser(8, options)).sync_token;
    assert.strictEqual((await service.reconcileGameInfoRefreshByUser(8, options)).queued, 0, 'successful rescan reopens the same pending row without recreating it');
    const once = await service.processGameInfoRefreshTasks(options); assert.strictEqual(once.success, 1, JSON.stringify(once));
    assert.strictEqual((await service.processGameInfoRefreshTasks(options)).runnable, 0);
    await upsertOrder({ ...active, order_status: '投诉/撤单' });
    assert.strictEqual((await service.reconcileGameInfoRefreshByUser(8, options)).queued, 0);
    assert.strictEqual(h.state.apiCalls.length, 1);
    cases += 2;

    await upsertOrder({ ...active, order_no: 'REAL-RACE', start_time: '2026-11-12 15:00:00', order_status: '已完成' });
    options.sync_token = (await service.prepareGameInfoRefreshByUser(8, options)).sync_token;
    assert.strictEqual((await service.reconcileGameInfoRefreshByUser(8, options)).queued, 1);
    const originalRentingQuery = deps.listRentingWindowByAccounts;
    deps.listRentingWindowByAccounts = async () => {
        await ledger.beginRefreshOrderSync(8, { token: 'a-newer-real-sync', now: NOW });
        await ledger.completeRefreshOrderSync(8, { token: 'a-newer-real-sync', now: NOW });
        return {};
    };
    const fenced = await service.processGameInfoRefreshTasks(options);
    assert.strictEqual(fenced.claimed, 0); assert.strictEqual(fenced.skipped, 1); assert.strictEqual(h.state.apiCalls.length, 1);
    deps.listRentingWindowByAccounts = originalRentingQuery;
    assert.strictEqual((await service.processGameInfoRefreshTasks(options)).success, 1);
    assert.strictEqual(h.state.apiCalls.length, 2); cases++;
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; }).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
