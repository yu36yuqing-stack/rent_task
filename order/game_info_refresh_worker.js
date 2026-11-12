'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const util = require('util');
const { fork } = require('child_process');
const { ensureMigrationsReady } = require('../database/migration_runner');
const { tryAcquireLock, touchLock, releaseOwnedLock } = require('../database/lock_db');
const { loadGameInfoRefreshPolicy, policyAllowsUser } = require('./game_info_refresh_policy');
const { createRuntimeTask, markRuntimeTaskRunning, markRuntimeTaskFinished } = require('../database/runtime_task_db');

const LOCK_KEY = 'order_game_info_refresh_worker:uuzuhao';
const TASK_DIR = path.join(__dirname, '..');

function positiveInteger(value, fallback, max = 1000) {
    const n = Number(value);
    return Number.isSafeInteger(n) && n > 0 ? Math.min(n, max) : fallback;
}

function createWorkerLogger(logDir = path.join(TASK_DIR, 'log')) {
    const file = path.join(logDir, 'game_info_refresh_worker.log');
    const logger = {};
    for (const level of ['log', 'warn', 'error']) {
        logger[level] = (...args) => {
            const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${util.format(...args)}\n`;
            try {
                fs.mkdirSync(logDir, { recursive: true });
                fs.appendFileSync(file, line);
            } catch { /* Console remains available if file logging is unavailable. */ }
            console[level](...args);
        };
    }
    return logger;
}

function policyReady(policy, now) {
    return Boolean(policy && policy.available && policy.enabled
        && Number.isFinite(policy.activated_at_ms) && now >= policy.activated_at_ms
        && (policy.user_ids === null || policy.user_ids.length > 0));
}

async function startGameInfoRefreshWorker(options = {}) {
    const deps = options.deps || {};
    const logger = options.logger || console;
    const now = options.now instanceof Date ? options.now.getTime() : Date.now();
    try {
        const policy = await (deps.loadPolicy || loadGameInfoRefreshPolicy)({ logger });
        if (!policyReady(policy, now)) return { triggered: false, reason: 'feature_disabled_or_unavailable', pid: 0 };
        const userIds = options.user_ids || (options.user_id ? [options.user_id] : null);
        if (userIds && !userIds.some(uid => policyAllowsUser(policy, uid, now))) {
            return { triggered: false, reason: 'no_eligible_users', pid: 0 };
        }
        const taskDir = String(options.task_dir || TASK_DIR);
        const script = path.join(taskDir, 'order', 'game_info_refresh_worker.js');
        if (!(deps.existsSync || fs.existsSync)(script)) return { triggered: false, reason: 'worker_missing', pid: 0 };
        const child = (deps.fork || fork)(script, [], {
            cwd: taskDir,
            env: { ...process.env, GAME_INFO_REFRESH_WORKER_TRIGGER_TS: String(now) },
            detached: true,
            stdio: 'ignore'
        });
        child.once('error', () => logger.warn('[GameInfoRefreshWorker] spawn_error'));
        child.unref();
        return { triggered: Boolean(child.pid), reason: child.pid ? 'spawned' : 'spawn_failed', pid: Number(child.pid || 0) };
    } catch {
        logger.warn('[GameInfoRefreshWorker] launch_failed');
        return { triggered: false, reason: 'launch_failed', pid: 0 };
    }
}

async function main(options = {}) {
    const deps = options.deps || {};
    const logger = options.logger || createWorkerLogger(options.log_dir);
    await (deps.ensureMigrationsReady || ensureMigrationsReady)({ logger });
    const policy = await (deps.loadPolicy || loadGameInfoRefreshPolicy)({ logger });
    const now = options.now instanceof Date ? options.now.getTime() : Date.now();
    if (!policyReady(policy, now)) return { skipped: true, reason: 'feature_disabled_or_unavailable' };
    const limit = positiveInteger(options.limit ?? process.env.GAME_INFO_REFRESH_WORKER_LIMIT, 100);
    const leaseSec = Math.max(60, positiveInteger(options.lease_sec ?? process.env.GAME_INFO_REFRESH_WORKER_LEASE_SEC, Math.max(300, limit * 30), 86400));
    const owner = `pid=${process.pid} run=${crypto.randomUUID()}`;
    const lock = await (deps.tryAcquireLock || tryAcquireLock)(LOCK_KEY, leaseSec, owner);
    if (!lock.acquired) return { skipped: true, reason: 'locked' };
    let lostLock = false;
    const heartbeat = (deps.setInterval || setInterval)(() => {
        Promise.resolve().then(() => (deps.touchLock || touchLock)(LOCK_KEY, leaseSec, owner))
            .then(owned => { if (!owned) lostLock = true; })
            .catch(() => { lostLock = true; logger.warn('[GameInfoRefreshWorker] lock_renew_failed'); });
    }, Math.max(1000, Math.floor(leaseSec * 1000 / 3)));
    heartbeat.unref();
    let runtimeTask = null;
    const finishBatch = async (status, summary) => {
        if (!runtimeTask || !runtimeTask.task_id) return;
        try {
            await (deps.markRuntimeTaskFinished || markRuntimeTaskFinished)(runtimeTask.task_id, {
                status, stage: status === 'failed' ? 'failed' : 'done',
                progress_text: status === 'failed' ? '账号资料刷新任务失败' : '账号资料刷新任务完成',
                result_json: summary,
                error_json: status === 'failed' ? ['consumer_failed'] : []
            });
        } catch { logger.warn('[GameInfoRefreshWorker] runtime_finish_failed'); }
    };
    try {
        try {
            runtimeTask = await (deps.createRuntimeTask || createRuntimeTask)({
                user_id: 0, task_type: 'order_game_info_refresh', trigger_source: 'order_sync',
                status: 'pending', stage: 'queued', progress_text: '等待刷新账号资料', desc: owner
            });
            await (deps.markRuntimeTaskRunning || markRuntimeTaskRunning)(runtimeTask.task_id, {
                stage: 'refresh_game_info', progress_text: '正在刷新账号资料'
            });
        } catch { logger.warn('[GameInfoRefreshWorker] runtime_start_failed'); }
        const processTasks = deps.processTasks || require('./game_info_refresh_service').processGameInfoRefreshTasks;
        const result = await processTasks({
            now: options.now,
            logger,
            limit,
            stale_after_sec: positiveInteger(options.stale_after_sec ?? process.env.GAME_INFO_REFRESH_TASK_STALE_SEC, 300, 86400),
            should_stop: () => lostLock
        });
        const summary = {
            runnable: result.runnable, success: result.success, failed: result.failed,
            unknown: result.unknown, deferred: result.deferred, skipped: result.skipped
        };
        await finishBatch(Number(result.failed || 0) + Number(result.unknown || 0) > 0 ? 'partial_failed' : 'success', summary);
        logger.log('[GameInfoRefreshWorker] done %s', JSON.stringify(summary));
        return result;
    } catch (error) {
        await finishBatch('failed', {});
        throw error;
    } finally {
        (deps.clearInterval || clearInterval)(heartbeat);
        await (deps.releaseOwnedLock || releaseOwnedLock)(LOCK_KEY, owner, `release ${owner}`);
    }
}

if (require.main === module) {
    main().catch(() => {
        console.error('[GameInfoRefreshWorker] worker_failed');
        process.exitCode = 1;
    });
}

module.exports = { LOCK_KEY, startGameInfoRefreshWorker, main, createWorkerLogger };
