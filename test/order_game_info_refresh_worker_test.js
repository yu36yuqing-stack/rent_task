'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-refresh-worker-'));
for (const key of ['MAIN', 'RUNTIME', 'ORDER', 'STATS', 'PRICE']) process.env[`${key}_DB_FILE_PATH`] = path.join(tmp, `${key}.db`);
global.fetch = async () => { throw new Error('worker fixture forbids real HTTP'); };
const worker = require('../order/game_info_refresh_worker');
const now = new Date('2026-11-12T12:00:00+08:00');
const policy = { available: true, enabled: true, user_ids: [8], activated_at_ms: now.getTime() - 1000 };
const logger = { log() {}, warn() {}, error() {} };

async function main() {
    assert(!fs.existsSync(path.join(tmp, 'log')), 'import must not create log files or change console');
    for (const value of [null, { ...policy, enabled: false }, { ...policy, available: false }, { ...policy, user_ids: [] }, { ...policy, activated_at_ms: now.getTime() + 1 }]) {
        const result = await worker.startGameInfoRefreshWorker({ now, logger, deps: { loadPolicy: async () => value } });
        assert.strictEqual(result.triggered, false);
    }
    assert.strictEqual((await worker.startGameInfoRefreshWorker({ now, user_id: 9, logger, deps: { loadPolicy: async () => policy } })).reason, 'no_eligible_users');
    assert.strictEqual((await worker.startGameInfoRefreshWorker({ now, user_ids: [], logger, deps: { loadPolicy: async () => policy } })).reason, 'no_eligible_users');
    assert.strictEqual((await worker.startGameInfoRefreshWorker({ now, logger, deps: { loadPolicy: async () => policy, existsSync: () => false } })).reason, 'worker_missing');
    for (const deps of [
        { loadPolicy: async () => { throw new Error('fixture policy unavailable'); } },
        { loadPolicy: async () => policy, existsSync: () => true, fork: () => { throw new Error('fixture spawn denied'); } }
    ]) assert.strictEqual((await worker.startGameInfoRefreshWorker({ now, logger, deps })).reason, 'launch_failed');

    let warned = 0;
    for (const [pid, expected] of [[77, true], [0, false]]) {
        const child = new EventEmitter();child.pid = pid;let unref = 0;child.unref = () => { unref++; };
        const result = await worker.startGameInfoRefreshWorker({ now, user_ids: [8, 9], task_dir: tmp, logger: { warn() { warned++; } }, deps: {
            loadPolicy: async () => ({ ...policy, user_ids: null }), existsSync: () => true,
            fork(script, args, options) {
                assert.strictEqual(script, path.join(tmp, 'order/game_info_refresh_worker.js'));
                assert.deepStrictEqual(args, []);assert.strictEqual(options.detached, true);assert.strictEqual(options.stdio, 'ignore');
                assert.strictEqual(options.cwd, tmp);assert.strictEqual(options.env.GAME_INFO_REFRESH_WORKER_TRIGGER_TS, String(now.getTime()));
                return child;
            }
        } });
        assert.strictEqual(result.triggered, expected);assert.strictEqual(result.pid, pid);assert.strictEqual(unref, 1);
        child.emit('error', new Error('fixture asynchronous spawn failure'));
    }
    assert.strictEqual(warned, 2, 'asynchronous spawn errors must have a listener');

    const makeDeps = extra => {
        const state = { acquired: 0, released: 0, processed: 0, clear: 0, heartbeat: null, owner: '' };
        const deps = {
            ensureMigrationsReady: async () => {}, loadPolicy: async () => policy,
            createRuntimeTask: async input => { state.runtimeInput = input;return { task_id: 'BATCH1' }; },
            markRuntimeTaskRunning: async id => { assert.strictEqual(id, 'BATCH1');state.runtimeRunning = true; },
            markRuntimeTaskFinished: async (id, patch) => { assert.strictEqual(id, 'BATCH1');state.runtimeFinished = patch; },
            tryAcquireLock: async (key, lease, owner) => { state.acquired++;state.owner = owner;assert.strictEqual(key, worker.LOCK_KEY);assert(lease >= 60);return { acquired: true }; },
            releaseOwnedLock: async (key, owner, desc) => { state.released++;assert.strictEqual(key, worker.LOCK_KEY);assert.strictEqual(owner, state.owner);assert(desc.includes(owner)); },
            touchLock: async (key, lease, owner) => { assert.strictEqual(owner, state.owner);return true; },
            processTasks: async options => { state.processed++;assert.strictEqual(options.limit, 100);assert.strictEqual(options.stale_after_sec, 300);assert.strictEqual(options.should_stop(), false);return { runnable: 2, success: 1, failed: 1, unknown: 0, deferred: 0, skipped: 0 }; },
            setInterval: (fn, interval) => { state.heartbeat = fn;assert(interval >= 1000);return { unref() {} }; },
            clearInterval: () => { state.clear++; }, ...extra
        };
        return { state, deps };
    };
    {
        const { state, deps } = makeDeps({ loadPolicy: async () => ({ ...policy, enabled: false }) });
        assert.strictEqual((await worker.main({ now, logger, deps })).skipped, true);assert.strictEqual(state.acquired, 0);
    }
    {
        const { state, deps } = makeDeps({ tryAcquireLock: async () => ({ acquired: false }) });
        assert.strictEqual((await worker.main({ now, logger, deps })).reason, 'locked');assert.strictEqual(state.processed, 0);assert.strictEqual(state.released, 0);
    }
    for (const field of ['ensureMigrationsReady', 'loadPolicy', 'tryAcquireLock']) {
        const { state, deps } = makeDeps({ [field]: async () => { throw new Error(`fixture ${field} failed`); } });
        await assert.rejects(() => worker.main({ now, logger, deps }), /fixture/);assert.strictEqual(state.processed, 0);assert.strictEqual(state.released, 0);
    }
    {
        const { state, deps } = makeDeps();
        const out = await worker.main({ now, logger, deps });
        assert.strictEqual(out.success, 1);assert.strictEqual(out.failed, 1);assert.strictEqual(state.released, 1);assert.strictEqual(state.clear, 1);
        assert.strictEqual(state.runtimeInput.task_type, 'order_game_info_refresh');assert.strictEqual(state.runtimeRunning, true);
        assert.strictEqual(state.runtimeFinished.status, 'partial_failed');assert.strictEqual(state.runtimeFinished.result_json.failed, 1);
        assert.strictEqual(state.runtimeFinished.result_json.results, undefined, 'runtime stores counts without sensitive per-request details');
        assert(/^pid=\d+ run=/.test(state.owner));
    }
    for (const renew of [async () => false, async () => { throw new Error('fixture heartbeat IO error'); }]) {
        const { state, deps } = makeDeps({ touchLock: renew });
        deps.processTasks = async options => {
            state.heartbeat();await new Promise(resolve => setImmediate(resolve));
            assert.strictEqual(options.should_stop(), true, 'lost lock must stop fetching more work');return {};
        };
        await worker.main({ now, logger, deps });assert.strictEqual(state.released, 1);
    }
    {
        const { state, deps } = makeDeps();
        deps.processTasks = async () => { state.heartbeat();await new Promise(resolve => setImmediate(resolve));throw new Error('fixture consumer failed'); };
        await assert.rejects(() => worker.main({ now, logger, deps }), /consumer failed/);
        assert.strictEqual(state.released, 1);assert.strictEqual(state.clear, 1);
        assert.strictEqual(state.runtimeFinished.status, 'failed');assert.deepStrictEqual(state.runtimeFinished.error_json, ['consumer_failed']);
    }
    {
        const { state, deps } = makeDeps({ releaseOwnedLock: async () => { throw new Error('fixture release failed'); } });
        await assert.rejects(() => worker.main({ now, logger, deps }), /release failed/);assert.strictEqual(state.processed, 1);assert.strictEqual(state.clear, 1);
    }
    {
        const { deps } = makeDeps({ processTasks: async options => { assert.strictEqual(options.limit, 1);assert.strictEqual(options.stale_after_sec, 300);return {}; } });
        await worker.main({ now, logger, deps, limit: 1, stale_after_sec: 'invalid', lease_sec: 1 });
    }
    for (const field of ['createRuntimeTask', 'markRuntimeTaskRunning', 'markRuntimeTaskFinished']) {
        const { state, deps } = makeDeps({ [field]: async () => { throw new Error('fixture runtime unavailable'); } });
        assert.strictEqual((await worker.main({ now, logger, deps })).success, 1, 'observability failure must not retry a business request');
        assert.strictEqual(state.processed, 1);assert.strictEqual(state.released, 1);
    }
    {
        const logDir = path.join(tmp, 'logs');const output = [];
        const saved = Object.fromEntries(['log', 'warn', 'error'].map(level => [level, console[level]]));
        for (const level of Object.keys(saved)) console[level] = (...args) => output.push([level, ...args]);
        try {
            const log = worker.createWorkerLogger(logDir);
            log.log('fixture %s', 'ok');log.warn('fixture warn');log.error('fixture error');
            const content = fs.readFileSync(path.join(logDir, 'game_info_refresh_worker.log'), 'utf8');
            assert(content.includes('[LOG] fixture ok'));assert(content.includes('[WARN] fixture warn'));assert(content.includes('[ERROR] fixture error'));
            const notDir = path.join(tmp, 'not-directory');fs.writeFileSync(notDir, 'fixture');
            worker.createWorkerLogger(notDir).log('fallback console');assert.strictEqual(output.length, 4);
        } finally { Object.assign(console, saved); }
    }
    console.log('[PASS] order_game_info_refresh_worker_test: import, launch, locking, heartbeat, failure and logger paths');
}
main().catch(error => { console.error(error);process.exitCode = 1; });
