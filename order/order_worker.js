const path = require('path');
const fs = require('fs');
const util = require('util');
const { syncOrdersForAllUsers } = require('./order');
const { tryAcquireLock, releaseLock } = require('../database/lock_db');

const TASK_DIR = path.join(__dirname, '..');
const LOG_DIR = path.join(TASK_DIR, 'log');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, 'order_worker.log');
const LOCK_KEY = 'order_sync_all_users';

function setupLogger() {
    const original = {
        log: console.log.bind(console),
        info: console.info.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console)
    };
    const writeLine = (level, args) => {
        const msg = util.format(...args);
        try {
            fs.appendFileSync(LOG_FILE, `[${new Date().toISOString()}] [${level}] ${msg}\n`);
        } catch (_) {}
    };
    console.log = (...args) => { writeLine('LOG', args); original.log(...args); };
    console.info = (...args) => { writeLine('INFO', args); original.info(...args); };
    console.warn = (...args) => { writeLine('WARN', args); original.warn(...args); };
    console.error = (...args) => { writeLine('ERROR', args); original.error(...args); };
}

setupLogger();

(async () => {
    const leaseSec = Math.max(300, Number(process.env.ORDER_WORKER_LOCK_LEASE_SEC || 1800));
    const lock = await tryAcquireLock(LOCK_KEY, leaseSec, `pid=${process.pid}`);
    if (!lock.acquired) {
        console.log(`[OrderWorker] 已有任务在执行，跳过。lease_until=${lock.lease_until}`);
        process.exit(0);
        return;
    }

    try {
        console.log(`[OrderWorker] 启动 pid=${process.pid}`);
        const result = await syncOrdersForAllUsers({});
        console.log(`[OrderWorker] 完成 users=${result.total_users} ok=${result.ok_users} failed=${result.failed_users}`);
    } catch (e) {
        console.error(`[OrderWorker] 执行失败: ${e.message}`);
        process.exitCode = 1;
    } finally {
        await releaseLock(LOCK_KEY, `release by pid=${process.pid}`);
    }
})();
