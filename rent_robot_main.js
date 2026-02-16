const fs = require('fs');
const path = require('path');
const util = require('util');
const {
    sendTelegram,
    toReportAccountFromUserGameRow,
    fillTodayOrderCounts,
    buildRecentActionsForUser,
    buildPayloadForOneUser,
    notifyUserByPayload
} = require('./report/report_rent_status.js');
const { listActiveUsers, USER_TYPE_ADMIN, USER_STATUS_ENABLED } = require('./database/user_db.js');
const { syncUserAccountsByAuth, listAllUserGameAccountsByUser, fillOnlineTagsByYouyou } = require('./product/product');
const { startOrderSyncWorkerIfNeeded, reconcileOrder3OffBlacklistByUser } = require('./order/order');
const { loadUserBlacklistSet, loadUserBlacklistReasonMap } = require('./user/user');
const { executeUserActionsIfNeeded } = require('./action_engine/action_engine.js');

// ===== 基础目录与运行开关 =====
const TASK_DIR = __dirname;
if (!fs.existsSync(TASK_DIR)) fs.mkdirSync(TASK_DIR, { recursive: true });
const LOG_DIR = path.join(TASK_DIR, 'log');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
const MAIN_LOG_FILE = path.join(LOG_DIR, 'rent_robot_main.log');

const ACTION_READ_ONLY = ['1', 'true', 'yes', 'on'].includes(String(process.env.ACTION_READ_ONLY || 'false').toLowerCase());
const ACTION_ENABLED = !['0', 'false', 'no', 'off'].includes(String(process.env.ACTION_ENABLE || 'true').toLowerCase());
const ORDER_ASYNC_ENABLED = !['0', 'false', 'no', 'off'].includes(String(process.env.ORDER_ASYNC_ENABLE || 'true').toLowerCase());
const ORDER_SYNC_INTERVAL_MIN = Math.max(1, Number(process.env.ORDER_SYNC_INTERVAL_MIN || 30));
const ORDER_SYNC_WINDOW_SEC = Math.max(0, Number(process.env.ORDER_SYNC_WINDOW_SEC || 90));
const ORDER_SYNC_FORCE = ['1', 'true', 'yes', 'on'].includes(String(process.env.ORDER_SYNC_FORCE || 'false').toLowerCase());

// 主日志: 保留控制台输出，同时落盘到 log/rent_robot_main.log
function setupMainLogger() {
    const original = {
        log: console.log.bind(console),
        info: console.info.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console)
    };

    const writeLine = (level, args) => {
        const msg = util.format(...args);
        try {
            fs.appendFileSync(MAIN_LOG_FILE, `[${new Date().toISOString()}] [${level}] ${msg}\n`);
        } catch (e) {
            original.error('[Logger] 写日志失败:', e.message);
        }
    };

    console.log = (...args) => { writeLine('LOG', args); original.log(...args); };
    console.info = (...args) => { writeLine('INFO', args); original.info(...args); };
    console.warn = (...args) => { writeLine('WARN', args); original.warn(...args); };
    console.error = (...args) => { writeLine('ERROR', args); original.error(...args); };
}

setupMainLogger();
console.log(`[Boot] rent_robot_main.js 启动 pid=${process.pid} args=${process.argv.slice(2).join(' ') || '(none)'}`);
console.log(`[Config] ACTION_ENABLE=${ACTION_ENABLED} ACTION_READ_ONLY=${ACTION_READ_ONLY}`);
console.log(`[Config] ORDER_ASYNC_ENABLE=${ORDER_ASYNC_ENABLED} ORDER_SYNC_INTERVAL_MIN=${ORDER_SYNC_INTERVAL_MIN} ORDER_SYNC_WINDOW_SEC=${ORDER_SYNC_WINDOW_SEC} ORDER_SYNC_FORCE=${ORDER_SYNC_FORCE}`);

process.on('unhandledRejection', (reason) => {
    console.error('[UnhandledRejection]', reason);
});

process.on('uncaughtException', (err) => {
    console.error('[UncaughtException]', err);
});

const LOCK_FILE = path.join(TASK_DIR, 'rent_robot.lock');
const MAX_LOCK_AGE_MS = 10 * 60 * 1000;

// 进程锁: 防止并发执行导致重复上下架
function checkLock() {
    console.log(`[Lock] 检查锁文件: ${LOCK_FILE}`);
    if (fs.existsSync(LOCK_FILE)) {
        const stats = fs.statSync(LOCK_FILE);
        const age = Date.now() - stats.mtimeMs;
        if (age < MAX_LOCK_AGE_MS) {
            console.log(`[Skip] 任务锁定中 (持续 ${Math.round(age / 1000)}s)，跳过本次执行。`);
            console.log('ALERT_OVERLAP');
            return false;
        }
        console.log('[Info] 锁文件超时，强制覆盖。');
    }
    fs.writeFileSync(LOCK_FILE, process.pid.toString());
    console.log('[Lock] 已创建执行锁');
    return true;
}

function releaseLock() {
    if (fs.existsSync(LOCK_FILE)) {
        fs.unlinkSync(LOCK_FILE);
        console.log('[Lock] 已释放执行锁');
    }
}

const HISTORY_FILE = path.join(TASK_DIR, 'rent_robot_history.jsonl');

async function runPipeline(runRecord) {
    // 用户范围: 非管理员 + 启用状态
    const users = await listActiveUsers();
    const targets = users
        .filter((u) => String(u.user_type || '') !== USER_TYPE_ADMIN)
        .filter((u) => String(u.status || '') === USER_STATUS_ENABLED);

    if (targets.length === 0) {
        return {
            routed: false,
            reason: 'no_non_admin_users',
            routed_users: [],
            routed_user_count: 0,
            processed_user_count: 0,
            errors: []
        };
    }

    const routed = [];
    const errors = [];

    // 用户级主流程（拉取 -> 策略/执行 -> 通知）
    for (const user of targets) {
        let rows = [];
        let blacklistSet = new Set();
        let blacklistReasonMap = {};

        try {
            console.log(`[User] 开始处理 user_id=${user.id} account=${user.account}`);
            // Step 1: 拉取三平台最新数据并落到 user_game_account
            await syncUserAccountsByAuth(user.id);
            rows = await listAllUserGameAccountsByUser(user.id);

            // Step 1.5: 每次主流程都基于当前订单表执行一次 3 单黑名单收敛，
            // 保障“移出黑名单”先发生，再进入上下架决策，避免仅靠异步订单任务导致时序不一致。
            try {
                const reconcile = await reconcileOrder3OffBlacklistByUser(user);
                console.log(`[Order3Off] user_id=${user.id} reconcile=${JSON.stringify(reconcile)}`);
            } catch (e) {
                console.warn(`[Order3Off] 收敛失败 user_id=${user.id}: ${e.message}`);
            }

            blacklistSet = await loadUserBlacklistSet(user.id);
            blacklistReasonMap = await loadUserBlacklistReasonMap(user.id);

            // Step 2: 策略计算并执行（ACTION_ENABLE/ACTION_READ_ONLY 控制）
            const actionResult = await executeUserActionsIfNeeded({
                user,
                rows,
                blacklistSet,
                actionEnabled: ACTION_ENABLED,
                readOnly: ACTION_READ_ONLY
            });
            if (actionResult.actions.length > 0) {
                runRecord.actions.push(...actionResult.actions.map((a) => ({ ...a, user_id: user.id, user_account: user.account })));
            }
            if (actionResult.errors.length > 0) {
                const actionErrs = actionResult.errors.map((e) => `action_error user=${user.id} ${e}`);
                runRecord.errors.push(...actionErrs);
                errors.push({ user_id: user.id, account: user.account, errors: actionResult.errors });
            }

            // Step 3: 暂时关闭“执行后再次拉取”逻辑，降低平台请求频次，避免触发风控。
            // TODO: 后续补充更稳健方案（例如仅成功动作增量校验/延迟抽样回拉），兼顾准确性与风控。
            // if (actionResult.planned > 0 && !ACTION_READ_ONLY) {
            //     await syncUserAccountsByAuth(user.id);
            //     rows = await listAllUserGameAccountsByUser(user.id);
            // }

            // Step 4: 组装并发送用户通知（Telegram/Dingding）
            const accounts = rows.map((r) => toReportAccountFromUserGameRow(r, blacklistSet, blacklistReasonMap));
            await fillTodayOrderCounts(user.id, accounts);
            await fillOnlineTagsByYouyou(user, accounts);
            const recentActions = await buildRecentActionsForUser(user.id, { limit: 8 });
            const payload = buildPayloadForOneUser(accounts, {
                report_owner: String(user.name || user.account || '').trim(),
                recentActions
            });

            const notifyResult = await notifyUserByPayload(user, payload);
            if (!notifyResult.ok) {
                const notifyErrs = Array.isArray(notifyResult.errors) ? notifyResult.errors : [notifyResult.reason || 'notify_failed'];
                errors.push({ user_id: user.id, account: user.account, errors: notifyErrs });
                runRecord.errors.push(...notifyErrs.map((e) => `notify_error user=${user.id} ${e}`));
                continue;
            }

            routed.push({ user_id: user.id, account: user.account, accounts: accounts.length });
            runRecord.actions.push({
                type: 'notify_user',
                item: { user_id: user.id, account: user.account },
                reason: `notify ${accounts.length} accounts`,
                time: Date.now(),
                success: true
            });
            console.log(`[User] 处理完成 user_id=${user.id} accounts=${accounts.length}`);
        } catch (e) {
            const msg = `sync_failed: ${e.message}`;
            errors.push({ user_id: user.id, account: user.account, errors: [msg] });
            runRecord.errors.push(`pipeline_error user=${user.id} ${msg}`);
            console.error(`[User] 处理失败 user_id=${user.id}: ${e.message}`);
        }
    }

    return {
        routed: routed.length > 0,
        routed_users: routed,
        routed_user_count: routed.length,
        processed_user_count: targets.length,
        errors
    };
}

(async () => {
    if (!checkLock()) {
        console.log('[Exit] 锁存在，结束本次执行');
        return;
    }

    const runRecord = {
        timestamp: Date.now(),
        actions: [],
        errors: [],
        status: 'success'
    };

    try {
        // 顶层编排入口：执行完整链路
        startOrderSyncWorkerIfNeeded({
            enabled: ORDER_ASYNC_ENABLED,
            interval_min: ORDER_SYNC_INTERVAL_MIN,
            window_sec: ORDER_SYNC_WINDOW_SEC,
            force: ORDER_SYNC_FORCE,
            task_dir: TASK_DIR,
            run_record: runRecord,
            logger: console
        });
        console.log('[Step] 启动用户清单主干（拉取/策略/执行/通知）');
        const route = await runPipeline(runRecord);
        console.log(`[Step] 主流程完成 routed=${route.routed} users=${route.routed_user_count || 0} processed=${route.processed_user_count || 0}`);
        if (Array.isArray(route.errors) && route.errors.length > 0) {
            console.warn(`[Step] 存在错误条目=${route.errors.length}`);
        }
    } catch (e) {
        console.error('[Error]', e);
        runRecord.status = 'error';
        runRecord.errors.push(e.message);
        try {
            const errText = `⚠️ 租号任务执行异常\n时间: ${new Date().toLocaleString('zh-CN')}\n错误: ${e.message}`;
            await sendTelegram(errText, '');
            console.log('[Step] 异常通知已发送');
        } catch (notifyErr) {
            console.error('[Error] 异常通知发送失败:', notifyErr.message);
        }
    } finally {
        try {
            const line = JSON.stringify(runRecord);
            fs.appendFileSync(HISTORY_FILE, `${line}\n`);
            console.log(`[Step] 运行历史已追加: ${HISTORY_FILE} status=${runRecord.status} actions=${runRecord.actions.length} errors=${runRecord.errors.length}`);
        } catch (err) {
            console.error('History write fail', err);
        }
        releaseLock();
        console.log('[Exit] 本次执行结束');
    }
})();
