const { openDatabase } = require('../database/sqlite_client');
const { initOrderDb } = require('../database/order_db');
const { upsertUserBlacklistEntry } = require('../database/user_blacklist_db');
const {
    initProdRiskEventDb,
    upsertOpenRiskEvent,
    resolveRiskEventById
} = require('../database/prod_risk_event_db');
const {
    TASK_STATUS_PENDING,
    TASK_STATUS_WATCHING,
    TASK_STATUS_DONE,
    TASK_STATUS_FAILED,
    initProdGuardTaskDb,
    upsertGuardTask,
    listDueGuardTasks,
    getGuardTaskByEventId,
    updateGuardTaskStatus
} = require('../database/prod_guard_task_db');
const { tryAcquireLock, releaseLock } = require('../database/lock_db');
const {
    resolveUuzuhaoAuthByUser,
    queryOnlineStatusCached,
    setForbiddenPlayWithSnapshot
} = require('./prod_probe_cache_service');
const { sendDingdingMessage } = require('../report/dingding/ding_notify');
const { deleteBlacklistWithGuard, REASON_ONLINE } = require('../blacklist/blacklist_release_guard');

const ONLINE_PROBE_WINDOW_SEC = 90;
const ONLINE_PROBE_INTERVAL_SEC = Math.max(60, Number(process.env.ONLINE_PROBE_INTERVAL_SEC || 600));
const ONLINE_PROBE_FORCE = ['1', 'true', 'yes', 'on'].includes(String(process.env.ONLINE_PROBE_FORCE || 'false').toLowerCase());
const RECENT_ORDER_END_SUPPRESS_SEC = Math.max(60, Number(process.env.ONLINE_ALERT_RECENT_END_SUPPRESS_SEC || 1200));

const RISK_TYPE_ONLINE_NON_RENTING = 'online_non_renting';
const TASK_TYPE_SHEEP_FIX = 'sheep_fix';
const SHEEP_FIX_ENABLE = !['0', 'false', 'no', 'off'].includes(String(process.env.SHEEP_FIX_ENABLE || 'true').toLowerCase());
const SHEEP_FIX_SCAN_INTERVAL_SEC = Math.max(60, Number(process.env.SHEEP_FIX_SCAN_INTERVAL_SEC || 120));
const SHEEP_FIX_MAX_RETRY = Math.max(1, Number(process.env.SHEEP_FIX_MAX_RETRY || 5));
const SHEEP_FIX_WORKER_LOCK_KEY = String(process.env.SHEEP_FIX_WORKER_LOCK_KEY || 'prod_guard_sheep_fix_worker');
const SHEEP_FIX_WORKER_LOCK_LEASE_SEC = Math.max(60, Number(process.env.SHEEP_FIX_WORKER_LOCK_LEASE_SEC || 240));
const SHEEP_FIX_TASK_BOOTSTRAP_DELAY_SEC = 5;

let sheepFixWorkerTimer = null;
let sheepFixWorkerRunning = false;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function nowSec() {
    return Math.floor(Date.now() / 1000);
}

function dbAll(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

async function listLatestEndedOrderSnapshotByUser(userId, accounts = []) {
    const uid = Number(userId || 0);
    if (!uid) return {};
    const uniq = Array.from(new Set((Array.isArray(accounts) ? accounts : [])
        .map((x) => String(x || '').trim())
        .filter(Boolean)));
    if (uniq.length === 0) return {};

    await initOrderDb();
    const db = openDatabase();
    try {
        const marks = uniq.map(() => '?').join(',');
        const rows = await dbAll(db, `
            SELECT o.game_account, o.order_no, o.end_time, o.id
            FROM "order" o
            JOIN (
                SELECT game_account, MAX(datetime(end_time)) AS max_end_at
                FROM "order"
                WHERE user_id = ?
                  AND is_deleted = 0
                  AND TRIM(COALESCE(end_time, '')) <> ''
                  AND game_account IN (${marks})
                GROUP BY game_account
            ) x
              ON x.game_account = o.game_account
             AND datetime(o.end_time) = x.max_end_at
            WHERE o.user_id = ?
              AND o.is_deleted = 0
              AND o.game_account IN (${marks})
            ORDER BY o.id DESC
        `, [uid, ...uniq, uid, ...uniq]);
        const out = {};
        for (const row of rows) {
            const acc = String((row && row.game_account) || '').trim();
            if (!acc || out[acc]) continue;
            out[acc] = {
                order_no: String((row && row.order_no) || '').trim(),
                end_time: String((row && row.end_time) || '').trim()
            };
        }
        return out;
    } finally {
        db.close();
    }
}

function toDateTimeText(d = new Date()) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function shouldProbeOnlineNow(now = new Date()) {
    const sec = (now.getMinutes() * 60) + now.getSeconds();
    const offset = sec % ONLINE_PROBE_INTERVAL_SEC;
    return offset <= ONLINE_PROBE_WINDOW_SEC || offset >= (ONLINE_PROBE_INTERVAL_SEC - ONLINE_PROBE_WINDOW_SEC);
}

function isRentingStatus(v) {
    const s = String(v || '').trim();
    return s === '租赁中' || s === '出租中';
}

function collectOnlineButNotRenting(accounts = []) {
    const list = Array.isArray(accounts) ? accounts : [];
    return list.filter((acc) => {
        const y = String((acc && acc.youpin) || '').trim();
        const u = String((acc && acc.uhaozu) || '').trim();
        const z = String((acc && acc.zuhaowan) || '').trim();
        const online = String((acc && acc.online_tag) || '').trim().toUpperCase();
        const anyRent = isRentingStatus(y) || isRentingStatus(u) || isRentingStatus(z);
        return online === 'ON' && !anyRent;
    });
}

function buildOnlineButNotRentingAlertText(user, badAccounts = []) {
    const nowText = new Date().toLocaleString('zh-CN', { hour12: false });
    const owner = String((user && (user.name || user.account)) || '').trim() || `user_${user && user.id ? user.id : 'unknown'}`;
    const lines = [
        `⚠️ ${owner} 在线状态告警`,
        `时间: ${nowText}`,
        '命中条件: 非租赁中，但状态为在线(ON)',
        `账号数: ${badAccounts.length}`
    ];
    const limit = Math.min(20, badAccounts.length);
    for (let i = 0; i < limit; i += 1) {
        const a = badAccounts[i] || {};
        const name = String(a.remark || a.account || `账号${i + 1}`).trim();
        lines.push(`• ${name} (Y:${a.youpin || '-'} / U:${a.uhaozu || '-'} / Z:${a.zuhaowan || '-'})`);
    }
    if (badAccounts.length > limit) {
        lines.push(`… 其余 ${badAccounts.length - limit} 个账号未展开`);
    }
    return lines.join('\n');
}

async function listRecentlyEndedAccountsByUser(userId, accounts = [], suppressSec = RECENT_ORDER_END_SUPPRESS_SEC) {
    const uid = Number(userId || 0);
    if (!uid) return new Set();
    const accs = Array.isArray(accounts) ? accounts.map((x) => String(x || '').trim()).filter(Boolean) : [];
    if (accs.length === 0) return new Set();

    await initOrderDb();
    const db = openDatabase();
    try {
        const now = new Date();
        const lower = new Date(now.getTime() - Math.max(60, Number(suppressSec || RECENT_ORDER_END_SUPPRESS_SEC)) * 1000);
        const nowText = toDateTimeText(now);
        const lowerText = toDateTimeText(lower);
        const marks = accs.map(() => '?').join(',');
        const rows = await dbAll(db, `
            SELECT DISTINCT game_account
            FROM "order"
            WHERE user_id = ?
              AND is_deleted = 0
              AND TRIM(COALESCE(game_account, '')) <> ''
              AND game_account IN (${marks})
              AND end_time >= ?
              AND end_time <= ?
        `, [uid, ...accs, lowerText, nowText]);
        return new Set(rows.map((r) => String((r && r.game_account) || '').trim()).filter(Boolean));
    } finally {
        db.close();
    }
}

function buildProbeRows(accounts = []) {
    const list = Array.isArray(accounts) ? accounts : [];
    return list.map((x) => ({
        account: String(x.account || '').trim(),
        remark: String(x.remark || '').trim(),
        youpin: String(x.youpin || '').trim(),
        uhaozu: String(x.uhaozu || '').trim(),
        zuhaowan: String(x.zuhaowan || '').trim(),
        online_tag: ''
    })).filter((x) => x.account);
}

function summarizeProbeRows(probeRows = []) {
    const rows = Array.isArray(probeRows) ? probeRows : [];
    let on = 0;
    let off = 0;
    let failed = 0;
    for (const row of rows) {
        const tag = String((row && row.online_tag) || '').trim().toUpperCase();
        if (tag === 'ON') on += 1;
        else if (tag === 'OFF') off += 1;
        else failed += 1;
    }
    return {
        queried: rows.length,
        on,
        off,
        failed,
        success: on + off
    };
}

async function probeProdOnlineStatus(user, accounts = [], options = {}) {
    const logger = options.logger && typeof options.logger.log === 'function' ? options.logger : console;
    const forceProbe = Boolean(options.force_probe);
    if (!forceProbe && !ONLINE_PROBE_FORCE && !shouldProbeOnlineNow()) {
        return { ok: true, skipped: true, reason: 'out_of_probe_window' };
    }

    const list = Array.isArray(accounts) ? accounts : [];
    if (list.length === 0) return { ok: true, skipped: true, reason: 'empty_accounts' };
    let auth = null;
    try {
        auth = await resolveUuzuhaoAuthByUser(user && user.id);
    } catch {
        auth = null;
    }
    if (!auth) return { ok: true, skipped: true, reason: 'uuzuhao_auth_missing' };

    const probeRows = buildProbeRows(list);
    const probeAt = new Date();

    for (const row of probeRows) {
        try {
            const r = await queryOnlineStatusCached(user && user.id, row.account, {
                game_name: 'WZRY',
                auth,
                desc: 'update by prod_status_guard probe'
            });
            row.online_tag = r.online ? 'ON' : 'OFF';
        } catch (e) {
            row.online_tag = '';
            logger.warn(`[ProdStatusGuard] 在线查询失败 user_id=${user && user.id} account=${row.account}: ${e.message}`);
        }
        await sleep(180);
    }

    const summary = summarizeProbeRows(probeRows);
    return {
        ok: true,
        skipped: false,
        reason: '',
        probe_time: toDateTimeText(probeAt),
        total_accounts: list.length,
        queried: summary.queried,
        success: summary.success,
        failed: summary.failed,
        on: summary.on,
        off: summary.off,
        probe_rows: options.include_rows ? probeRows : []
    };
}

async function applyInitialControlForAccount(userId, account, auth, logger) {
    const uid = Number(userId || 0);
    const acc = String(account || '').trim();
    if (!uid || !acc) return { ok: false, error: 'invalid_input' };
    try {
        await upsertUserBlacklistEntry(uid, {
            game_account: acc,
            reason: REASON_ONLINE
        }, {
            source: 'prod_guard',
            operator: 'risk_auto',
            desc: JSON.stringify({ type: RISK_TYPE_ONLINE_NON_RENTING, step: 'blacklist_add' })
        });
    } catch (e) {
        return { ok: false, error: `blacklist_add_failed:${e.message}` };
    }
    try {
        await setForbiddenPlayWithSnapshot(uid, acc, true, {
            auth,
            game_name: 'WZRY',
            desc: 'update by prod_status_guard init control'
        });
    } catch (e) {
        return { ok: false, error: `forbidden_enable_failed:${e.message}` };
    }
    return { ok: true };
}

async function enqueueOnlineNonRentingRisk(user, badAccounts = [], options = {}) {
    const logger = options.logger && typeof options.logger.log === 'function' ? options.logger : console;
    if (!SHEEP_FIX_ENABLE) return { ok: true, skipped: true, reason: 'sheep_fix_disabled', queued: 0 };
    const uid = Number((user && user.id) || 0);
    if (!uid) return { ok: false, skipped: true, reason: 'invalid_user', queued: 0 };
    const list = Array.isArray(badAccounts) ? badAccounts : [];
    if (list.length === 0) return { ok: true, skipped: true, reason: 'empty_accounts', queued: 0 };
    let auth = null;
    try {
        auth = await resolveUuzuhaoAuthByUser(uid);
    } catch {
        auth = null;
    }
    if (!auth) return { ok: true, skipped: true, reason: 'uuzuhao_auth_missing', queued: 0 };

    await initProdRiskEventDb();
    await initProdGuardTaskDb();
    const latestOrderMap = await listLatestEndedOrderSnapshotByUser(uid, list.map((x) => x && x.account));
    let queued = 0;
    let activated = 0;
    let reused = 0;
    const errors = [];
    for (const one of list) {
        const acc = String((one && one.account) || '').trim();
        if (!acc) continue;
        try {
            const event = await upsertOpenRiskEvent(uid, acc, RISK_TYPE_ONLINE_NON_RENTING, {
                risk_level: 'high',
                snapshot: {
                    source: 'prod_status_guard',
                    online_tag: String((one && one.online_tag) || '').trim().toUpperCase(),
                    channel_status: {
                        youpin: String((one && one.youpin) || '').trim(),
                        uhaozu: String((one && one.uhaozu) || '').trim(),
                        zuhaowan: String((one && one.zuhaowan) || '').trim()
                    },
                    remark: String((one && one.remark) || '').trim(),
                    latest_order: latestOrderMap[acc] || { order_no: '', end_time: '' },
                    hit_at: toDateTimeText()
                },
                desc: 'auto open by online_non_renting'
            });
            // 同账号同风险在 open 周期内只允许一条事件 + 一条活动任务。
            // 若 open 事件已存在且任务仍在 pending/watching，本轮仅更新事件快照，不重复入队。
            if (!event.inserted) {
                const existTask = await getGuardTaskByEventId(event.id);
                if (existTask && (existTask.status === TASK_STATUS_PENDING || existTask.status === TASK_STATUS_WATCHING)) {
                    reused += 1;
                    continue;
                }
            }
            const task = await upsertGuardTask({
                user_id: uid,
                game_account: acc,
                risk_type: RISK_TYPE_ONLINE_NON_RENTING,
                task_type: TASK_TYPE_SHEEP_FIX,
                status: TASK_STATUS_PENDING,
                event_id: Number(event.id || 0),
                next_check_at: nowSec() + SHEEP_FIX_TASK_BOOTSTRAP_DELAY_SEC,
                max_retry: SHEEP_FIX_MAX_RETRY
            }, {
                desc: 'auto enqueue by prod_status_guard'
            });
            queued += 1;
            const initRet = await applyInitialControlForAccount(uid, acc, auth, logger);
            if (initRet.ok) {
                const patch = {
                    status: TASK_STATUS_WATCHING,
                    blacklist_applied: 1,
                    forbidden_applied: 1,
                    last_online_tag: 'ON',
                    next_check_at: nowSec() + SHEEP_FIX_SCAN_INTERVAL_SEC,
                    forbidden_on_at: toDateTimeText(),
                    last_error: ''
                };
                await updateGuardTaskStatus(task.id, patch);
                activated += 1;
            } else {
                await updateGuardTaskStatus(task.id, {
                    status: TASK_STATUS_PENDING,
                    retry_incr: 1,
                    last_error: String(initRet.error || 'init_control_failed'),
                    next_check_at: nowSec() + SHEEP_FIX_SCAN_INTERVAL_SEC
                });
                errors.push(`${acc}:${String(initRet.error || 'init_control_failed')}`);
            }
        } catch (e) {
            errors.push(`${acc}:${e.message}`);
        }
    }
    if (errors.length > 0) {
        logger.warn(`[ProdStatusGuard] risk_enqueue_partial_failed user_id=${uid} errs=${errors.join(' | ')}`);
    }
    return { ok: errors.length === 0, skipped: false, queued, activated, reused, errors };
}

async function alertOnlineConflictIfNeeded(user, probeRows = [], options = {}) {
    const dingCfg = user && user.notify_config && user.notify_config.dingding && typeof user.notify_config.dingding === 'object'
        ? user.notify_config.dingding
        : {};
    const rows = Array.isArray(probeRows) ? probeRows : [];
    if (rows.length === 0) return { ok: true, skipped: true, reason: 'empty_probe_rows' };

    const badAccountsRaw = collectOnlineButNotRenting(rows);
    if (badAccountsRaw.length === 0) return { ok: true, skipped: true, reason: 'no_conflict' };
    const recentEnded = await listRecentlyEndedAccountsByUser(
        user && user.id,
        badAccountsRaw.map((x) => x.account),
        RECENT_ORDER_END_SUPPRESS_SEC
    );
    const badAccounts = badAccountsRaw.filter((x) => !recentEnded.has(String(x.account || '').trim()));
    if (badAccounts.length === 0) {
        return {
            ok: true,
            skipped: true,
            reason: 'recent_order_ended_within_suppress_window',
            suppressed: badAccountsRaw.length
        };
    }

    const enqueueRet = await enqueueOnlineNonRentingRisk(user, badAccounts, options);

    if (dingCfg.webhook) {
        const text = buildOnlineButNotRentingAlertText(user, badAccounts);
        await sendDingdingMessage(text, {
            webhook: dingCfg.webhook,
            secret: dingCfg.secret || '',
            at_all: true
        });
    }
    return {
        ok: true,
        skipped: false,
        alerted: badAccounts.length,
        risk_enqueued: enqueueRet
    };
}

function shouldMarkTaskFailed(task = {}, nextRetry = 1) {
    const retry = Number(task.retry_count || 0) + Math.max(0, Number(nextRetry || 0));
    const maxRetry = Math.max(1, Number(task.max_retry || SHEEP_FIX_MAX_RETRY));
    return retry >= maxRetry;
}

async function processOneSheepFixTask(task, authCache, logger) {
    const uid = Number(task.user_id || 0);
    const acc = String(task.game_account || '').trim();
    if (!uid || !acc) return;

    let auth = authCache.get(uid);
    if (auth === undefined) {
        auth = await resolveUuzuhaoAuthByUser(uid);
        authCache.set(uid, auth || null);
    }
    if (!auth) {
        const failed = shouldMarkTaskFailed(task, 1);
        await updateGuardTaskStatus(task.id, {
            status: failed ? TASK_STATUS_FAILED : TASK_STATUS_PENDING,
            retry_incr: 1,
            last_error: 'uuzuhao_auth_missing',
            next_check_at: nowSec() + SHEEP_FIX_SCAN_INTERVAL_SEC
        });
        return;
    }

    if (String(task.status || '') === TASK_STATUS_PENDING) {
        const initRet = await applyInitialControlForAccount(uid, acc, auth, logger);
        if (initRet.ok) {
            const patch = {
                status: TASK_STATUS_WATCHING,
                blacklist_applied: 1,
                forbidden_applied: 1,
                last_online_tag: 'ON',
                next_check_at: nowSec() + SHEEP_FIX_SCAN_INTERVAL_SEC,
                last_error: ''
            };
            if (!String(task.forbidden_on_at || '').trim()) patch.forbidden_on_at = toDateTimeText();
            await updateGuardTaskStatus(task.id, patch);
            return;
        }
        const failed = shouldMarkTaskFailed(task, 1);
        await updateGuardTaskStatus(task.id, {
            status: failed ? TASK_STATUS_FAILED : TASK_STATUS_PENDING,
            retry_incr: 1,
            last_error: String(initRet.error || 'init_control_failed'),
            next_check_at: nowSec() + SHEEP_FIX_SCAN_INTERVAL_SEC
        });
        return;
    }

    let online = false;
    try {
        const probe = await queryOnlineStatusCached(uid, acc, {
            game_name: 'WZRY',
            auth,
            desc: 'update by prod_status_guard worker probe'
        });
        online = Boolean(probe && probe.online);
    } catch (e) {
        const failed = shouldMarkTaskFailed(task, 1);
        await updateGuardTaskStatus(task.id, {
            status: failed ? TASK_STATUS_FAILED : TASK_STATUS_WATCHING,
            retry_incr: 1,
            probe_loop_incr: 1,
            last_error: `query_online_failed:${e.message}`,
            next_check_at: nowSec() + SHEEP_FIX_SCAN_INTERVAL_SEC
        });
        return;
    }

    if (online) {
        await updateGuardTaskStatus(task.id, {
            status: TASK_STATUS_WATCHING,
            last_online_tag: 'ON',
            probe_loop_incr: 1,
            next_check_at: nowSec() + SHEEP_FIX_SCAN_INTERVAL_SEC,
            last_error: ''
        });
        return;
    }

    try {
        await setForbiddenPlayWithSnapshot(uid, acc, false, {
            auth,
            game_name: 'WZRY',
            desc: 'update by prod_status_guard worker release'
        });
    } catch (e) {
        const failed = shouldMarkTaskFailed(task, 1);
        await updateGuardTaskStatus(task.id, {
            status: failed ? TASK_STATUS_FAILED : TASK_STATUS_WATCHING,
            retry_incr: 1,
            probe_loop_incr: 1,
            last_error: `forbidden_disable_failed:${e.message}`,
            next_check_at: nowSec() + SHEEP_FIX_SCAN_INTERVAL_SEC
        });
        return;
    }

    const delRet = await deleteBlacklistWithGuard(uid, acc, {
        source: 'prod_guard',
        operator: 'risk_auto',
        desc: 'auto release by sheep_fix offline',
        reason_expected: REASON_ONLINE
    });
    if (!delRet || delRet.blocked || !delRet.done) {
        const errCode = delRet && delRet.blocked
            ? `blacklist_remove_blocked:${String(delRet.blocked_reason || '')}`
            : `blacklist_remove_pending:${String((delRet && delRet.remove_blocked_reason) || '') || 'unknown'}`;
        await updateGuardTaskStatus(task.id, {
            status: TASK_STATUS_WATCHING,
            last_online_tag: 'OFF',
            probe_loop_incr: 1,
            last_error: errCode,
            next_check_at: nowSec() + SHEEP_FIX_SCAN_INTERVAL_SEC
        });
        return;
    }

    const doneDesc = delRet && delRet.entry_absent
        ? 'auto resolved by sheep_fix worker (blacklist already absent)'
        : 'auto resolved by sheep_fix worker';
    await updateGuardTaskStatus(task.id, {
        status: TASK_STATUS_DONE,
        last_online_tag: 'OFF',
        forbidden_applied: 0,
        blacklist_applied: 0,
        forbidden_off_at: toDateTimeText(),
        probe_loop_incr: 1,
        last_error: '',
        finished_at: toDateTimeText(),
        desc: doneDesc
    });
    if (Number(task.event_id || 0) > 0) {
        await resolveRiskEventById(Number(task.event_id || 0), {
            status: 'resolved',
            desc: doneDesc
        });
    }
}

async function resolveStaleOpenEventsByFinishedTasks(limit = 80, logger = console) {
    const db = openDatabase();
    try {
        const rows = await dbAll(db, `
            SELECT
              t.event_id, t.status AS task_status, t.finished_at, t.forbidden_off_at, t.modify_date, t.desc
            FROM prod_guard_task t
            JOIN prod_risk_event e ON e.id = t.event_id
            WHERE t.is_deleted = 0
              AND e.is_deleted = 0
              AND t.event_id > 0
              AND e.status = 'open'
              AND t.status IN (?, ?)
            ORDER BY t.id DESC
            LIMIT ?
        `, [TASK_STATUS_DONE, TASK_STATUS_FAILED, Math.max(1, Math.min(500, Number(limit || 80)))]);
        let fixed = 0;
        for (const row of rows) {
            const eventId = Number((row && row.event_id) || 0);
            if (!eventId) continue;
            const taskStatus = String((row && row.task_status) || '').trim();
            const ok = await resolveRiskEventById(eventId, {
                status: taskStatus === TASK_STATUS_DONE ? 'resolved' : 'ignored',
                desc: 'auto reconciled by sheep_fix worker'
            });
            if (ok) fixed += 1;
        }
        if (fixed > 0 && logger && typeof logger.log === 'function') {
            logger.log(`[ProdStatusGuard] reconciled stale open events=${fixed}`);
        }
        return fixed;
    } finally {
        db.close();
    }
}

async function runSheepFixWorkerOnce(options = {}) {
    if (!SHEEP_FIX_ENABLE) return { ok: true, skipped: true, reason: 'sheep_fix_disabled' };
    const logger = options.logger && typeof options.logger.log === 'function' ? options.logger : console;
    await initProdRiskEventDb();
    await initProdGuardTaskDb();

    const lock = await tryAcquireLock(SHEEP_FIX_WORKER_LOCK_KEY, SHEEP_FIX_WORKER_LOCK_LEASE_SEC, `pid=${process.pid}`);
    if (!lock || !lock.acquired) {
        return { ok: true, skipped: true, reason: 'lock_not_acquired', lease_until: Number((lock && lock.lease_until) || 0) };
    }
    try {
        const tasks = await listDueGuardTasks({ limit: Number(options.limit || 80), due_sec: nowSec() });
        const authCache = new Map();
        let done = 0;
        for (const task of tasks) {
            try {
                await processOneSheepFixTask(task, authCache, logger);
                done += 1;
            } catch (e) {
                logger.error(`[ProdStatusGuard] worker task_failed id=${task.id} err=${e.message}`);
            }
        }
        const reconciled = await resolveStaleOpenEventsByFinishedTasks(120, logger);
        return { ok: true, skipped: false, scanned: tasks.length, processed: done, reconciled };
    } finally {
        await releaseLock(SHEEP_FIX_WORKER_LOCK_KEY, `release by pid=${process.pid}`);
    }
}

function startProdRiskTaskWorker(options = {}) {
    const logger = options.logger && typeof options.logger.log === 'function' ? options.logger : console;
    if (!SHEEP_FIX_ENABLE) {
        logger.log('[ProdStatusGuard] sheep fix worker disabled by config');
        return { started: false, reason: 'disabled' };
    }
    if (sheepFixWorkerTimer) {
        return { started: true, reason: 'already_started', interval_sec: SHEEP_FIX_SCAN_INTERVAL_SEC };
    }
    const run = async () => {
        if (sheepFixWorkerRunning) return;
        sheepFixWorkerRunning = true;
        try {
            const ret = await runSheepFixWorkerOnce({ logger });
            if (!ret.skipped && Number(ret.processed || 0) > 0) {
                logger.log(`[ProdStatusGuard] sheep worker processed=${ret.processed} scanned=${ret.scanned}`);
            }
        } catch (e) {
            logger.error(`[ProdStatusGuard] sheep worker error=${e.message}`);
        } finally {
            sheepFixWorkerRunning = false;
        }
    };
    sheepFixWorkerTimer = setInterval(run, SHEEP_FIX_SCAN_INTERVAL_SEC * 1000);
    void run();
    logger.log(`[ProdStatusGuard] sheep worker started interval_sec=${SHEEP_FIX_SCAN_INTERVAL_SEC}`);
    return { started: true, reason: 'started', interval_sec: SHEEP_FIX_SCAN_INTERVAL_SEC };
}

function stopProdRiskTaskWorker() {
    if (sheepFixWorkerTimer) {
        clearInterval(sheepFixWorkerTimer);
        sheepFixWorkerTimer = null;
    }
    sheepFixWorkerRunning = false;
}

async function runProdStatusGuard(user, accounts = [], options = {}) {
    const snapshot = options && options.snapshot && typeof options.snapshot === 'object'
        ? options.snapshot
        : await probeProdOnlineStatus(user, accounts, { ...options, include_rows: true });
    if (snapshot && snapshot.skipped) return snapshot;
    const probeRows = Array.isArray(snapshot.probe_rows) ? snapshot.probe_rows : [];
    return alertOnlineConflictIfNeeded(user, probeRows, options);
}

function triggerProdStatusGuard(user, accounts = [], options = {}) {
    const logger = options.logger && typeof options.logger.log === 'function' ? options.logger : console;
    const userId = Number((user && user.id) || 0);
    const rows = Array.isArray(accounts) ? accounts.map((x) => ({ ...x })) : [];
    void Promise.resolve()
        .then(() => runProdStatusGuard(user, rows, options))
        .then((ret) => {
            if (ret && ret.skipped) return;
            logger.warn(`[ProdStatusGuard] user_id=${userId} alerted=${Number((ret && ret.alerted) || 0)} queued=${Number((((ret || {}).risk_enqueued || {}).queued) || 0)}`);
        })
        .catch((e) => {
            logger.error(`[ProdStatusGuard] user_id=${userId} error=${e && e.message ? e.message : e}`);
        });
}

module.exports = {
    RISK_TYPE_ONLINE_NON_RENTING,
    TASK_TYPE_SHEEP_FIX,
    SHEEP_FIX_SCAN_INTERVAL_SEC,
    shouldProbeOnlineNow,
    probeProdOnlineStatus,
    alertOnlineConflictIfNeeded,
    runProdStatusGuard,
    triggerProdStatusGuard,
    runSheepFixWorkerOnce,
    startProdRiskTaskWorker,
    stopProdRiskTaskWorker
};
