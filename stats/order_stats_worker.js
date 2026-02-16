const path = require('path');
const fs = require('fs');
const util = require('util');
const { tryAcquireOrderJobLock, releaseOrderJobLock } = require('../database/order_job_lock_db');
const { setLastRunDate } = require('../database/order_stats_job_state_db');
const { refreshOrderStatsDailyForAllUsers, STATS_JOB_KEY_ALL_USERS } = require('./order_stats');

const TASK_DIR = path.join(__dirname, '..');
const LOG_DIR = path.join(TASK_DIR, 'log');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const LOG_FILE = path.join(LOG_DIR, 'order_stats_worker.log');
const LOCK_KEY = 'order_stats_daily_all_users';

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

function todayText() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

setupLogger();

(async () => {
    const lock = await tryAcquireOrderJobLock(LOCK_KEY, 3600, `pid=${process.pid}`);
    if (!lock.acquired) {
        console.log(`[OrderStatsWorker] 已有任务在执行，跳过。lease_until=${lock.lease_until}`);
        process.exit(0);
        return;
    }

    try {
        const recalcDays = Math.max(1, Number(process.env.ORDER_STATS_DAILY_RECALC_DAYS || 3));
        console.log(`[OrderStatsWorker] 启动 pid=${process.pid} recalc_days=${recalcDays}`);
        const summary = await refreshOrderStatsDailyForAllUsers({
            days: recalcDays,
            desc: 'daily by order_stats_worker'
        });
        console.log(`[OrderStatsWorker] 完成 total=${summary.total_users} ok=${summary.ok_users} failed=${summary.failed_users}`);
        await setLastRunDate(STATS_JOB_KEY_ALL_USERS, todayText(), `worker pid=${process.pid}`);
    } catch (e) {
        console.error(`[OrderStatsWorker] 执行失败: ${e.message}`);
        process.exitCode = 1;
    } finally {
        await releaseOrderJobLock(LOCK_KEY, `release by pid=${process.pid}`);
    }
})();
