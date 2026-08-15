const fs = require('fs');
const path = require('path');
const util = require('util');
const { tryAcquireLock, releaseLock, touchLock } = require('../database/lock_db');
const { processAuthRevokeTasks } = require('./auth_revoke_task_service');

const TASK_DIR = path.join(__dirname, '..');
const LOG_DIR = path.join(TASK_DIR, 'log');
const LOG_FILE = path.join(LOG_DIR, 'auth_revoke_worker.log');
const LOCK_KEY = 'uuzuhao_auth_revoke_worker';

function setupLogger() {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const original = {
        log: console.log.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console)
    };
    const writeLine = (level, args) => {
        try {
            fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [${level}] ${util.format(...args)}\n`);
        } catch (_) {}
    };
    console.log = (...args) => { writeLine('LOG', args); original.log(...args); };
    console.warn = (...args) => { writeLine('WARN', args); original.warn(...args); };
    console.error = (...args) => { writeLine('ERROR', args); original.error(...args); };
}

setupLogger();

async function main(options = {}) {
    const leaseSec = Math.max(60, Number(options.lease_sec || process.env.AUTH_REVOKE_WORKER_LOCK_LEASE_SEC || 300));
    const owner = `pid=${process.pid}`;
    const lock = await tryAcquireLock(LOCK_KEY, leaseSec, owner);
    if (!lock.acquired) {
        console.log(`[AuthRevokeWorker] 已有任务消费者运行，跳过 lease_until=${lock.lease_until}`);
        return { skipped: true, reason: 'locked' };
    }
    try {
        const result = await processAuthRevokeTasks({
            limit: Number(options.limit || process.env.AUTH_REVOKE_WORKER_LIMIT || 100),
            stale_after_sec: Number(options.stale_after_sec || process.env.AUTH_REVOKE_TASK_STALE_SEC || 300),
            stale_before: options.stale_before
        });
        await touchLock(LOCK_KEY, leaseSec, owner);
        console.log(`[AuthRevokeWorker] 完成 runnable=${result.runnable} claimed=${result.claimed} success=${result.success} failed=${result.failed} deferred=${result.deferred}`);
        return result;
    } finally {
        await releaseLock(LOCK_KEY, `release by ${owner}`);
    }
}

if (require.main === module) {
    main().catch((error) => {
        console.error(`[AuthRevokeWorker] 执行失败: ${error.stack || error.message}`);
        process.exitCode = 1;
    });
}

module.exports = { main };
