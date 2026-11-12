'use strict';

const { openOrderDatabase } = require('./sqlite_client');

const TABLE = 'order_game_info_refresh';
const BUSINESS_SCENE = 'order_game_info_refresh';
const TARGET_CHANNEL = 'uuzuhao';
const COLUMNS = `id,business_scene,target_channel,user_id,source_channel,order_no,
    game_id,game_name,game_account,target_product_id,source_order_status,start_time,end_time,
    observed_active_at,sync_token,sync_ready,status,attempted_at,finished_at,next_check_at,result_code,result_message,
    result_summary,create_date,modify_date,is_deleted,desc`;
const SOURCE_COLUMNS = `o.id,o.user_id,o.channel,o.order_no,o.game_id,o.game_name,o.game_account,
    o.role_name,o.order_status,o.start_time,o.end_time,o.is_deleted`;
const run = (db, sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function done(error) {
    if (error) return reject(error);
    resolve(this);
}));
const get = (db, sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (error, row) => error ? reject(error) : resolve(row || null)));
const all = (db, sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (error, rows) => error ? reject(error) : resolve(rows)));
const close = db => new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));

function text(value, field) {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
    return value.trim();
}

function positiveId(value, field = 'id') {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer`);
    return value;
}

function dateText(value = new Date()) {
    const date = value instanceof Date ? value : new Date(typeof value === 'string' ? value.replace(' ', 'T') : value);
    if (!Number.isFinite(date.getTime())) throw new Error('Invalid refresh timestamp');
    const pad = number => String(number).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function identity(input) {
    return [
        text(input.business_scene === undefined ? BUSINESS_SCENE : input.business_scene, 'business_scene'),
        text(input.target_channel === undefined ? TARGET_CHANNEL : input.target_channel, 'target_channel'),
        positiveId(input.user_id, 'user_id'),
        text(input.source_channel === undefined ? input.channel : input.source_channel, 'source_channel'),
        text(input.order_no, 'order_no')
    ];
}

function scope(options) {
    return [text(options.business_scene === undefined ? BUSINESS_SCENE : options.business_scene, 'business_scene'),
        text(options.target_channel === undefined ? TARGET_CHANNEL : options.target_channel, 'target_channel')];
}

function sourceFields(input, targetRequired) {
    return [text(String(input.game_id || ''), 'game_id'), String(input.game_name || ''), text(input.game_account, 'game_account'),
        targetRequired ? text(input.target_product_id, 'target_product_id') : String(input.target_product_id || ''),
        String(input.order_status || input.source_order_status || ''), String(input.start_time || ''), String(input.end_time || '')];
}

function taskRow(row) {
    if (!row) return null;
    return { ...row, result_summary: JSON.parse(row.result_summary) };
}

function outcomeSummary(input) {
    const out = {};
    if (!input || typeof input !== 'object' || Array.isArray(input)) return '{}';
    for (const key of ['http_status', 'data_type', 'game_account_info_count', 'product_item_num', 'error_name', 'cause_code']) {
        const value = input[key];
        if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) out[key] = value;
        else if (typeof value === 'string') out[key] = value.slice(0, 100);
    }
    if (Array.isArray(input.data_keys)) out.data_keys = input.data_keys.filter(key => typeof key === 'string').slice(0, 50).map(key => key.slice(0, 100));
    return JSON.stringify(out);
}

let transactionTail = Promise.resolve();
async function withDb(action, transaction = false) {
    // A waiting BEGIN occupies a sqlite3 worker thread. Serialize this module's short transactions
    // within one process so waiters cannot starve the thread needed by the current owner to COMMIT.
    let release;
    if (transaction) {
        const previous = transactionTail;
        transactionTail = new Promise(resolve => { release = resolve; });
        await previous;
    }
    let db;
    try {
        db = openOrderDatabase();
        if (transaction) await run(db, 'BEGIN IMMEDIATE');
        const result = await action(db);
        if (transaction) await run(db, 'COMMIT');
        return result;
    } catch (error) {
        if (transaction && db) await run(db, 'ROLLBACK').catch(() => {});
        throw error;
    } finally {
        try { if (db) await close(db); } finally { if (release) release(); }
    }
}

async function initOrderGameInfoRefreshDb() {
    await withDb(async db => {
        await run(db, `CREATE TABLE IF NOT EXISTS ${TABLE} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            business_scene TEXT NOT NULL, target_channel TEXT NOT NULL,
            user_id INTEGER NOT NULL, source_channel TEXT NOT NULL, order_no TEXT NOT NULL,
            game_id TEXT NOT NULL DEFAULT '', game_name TEXT NOT NULL DEFAULT '', game_account TEXT NOT NULL DEFAULT '',
            target_product_id TEXT NOT NULL DEFAULT '', source_order_status TEXT NOT NULL DEFAULT '',
            start_time TEXT NOT NULL DEFAULT '', end_time TEXT NOT NULL DEFAULT '',
            observed_active_at TEXT NOT NULL DEFAULT '',
            sync_token TEXT NOT NULL DEFAULT '', sync_ready INTEGER NOT NULL DEFAULT 0 CHECK(sync_ready IN (0,1)),
            status TEXT NOT NULL DEFAULT 'watching' CHECK(status IN ('watching','pending','sending','success','failed','unknown','skipped')),
            attempted_at TEXT NOT NULL DEFAULT '', finished_at TEXT NOT NULL DEFAULT '', next_check_at TEXT NOT NULL DEFAULT '',
            result_code TEXT NOT NULL DEFAULT '', result_message TEXT NOT NULL DEFAULT '',
            result_summary TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(result_summary)),
            create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            is_deleted INTEGER NOT NULL DEFAULT 0, desc TEXT NOT NULL DEFAULT ''
        )`);
        // Deliberately includes deleted rows: deleting an audit record must never reset an automatic attempt.
        await run(db, `CREATE UNIQUE INDEX IF NOT EXISTS uq_order_game_info_refresh_identity
            ON ${TABLE}(business_scene,target_channel,user_id,source_channel,order_no)`);
        await run(db, `CREATE INDEX IF NOT EXISTS idx_order_game_info_refresh_pending
            ON ${TABLE}(business_scene,target_channel,status,sync_ready,next_check_at,id) WHERE is_deleted=0`);
    }, true);
}

async function getRefreshTaskByIdentity(input) {
    const params = identity(input);
    return withDb(async db => taskRow(await get(db, `SELECT ${COLUMNS} FROM ${TABLE}
        WHERE business_scene=? AND target_channel=? AND user_id=? AND source_channel=? AND order_no=?`, params)));
}

async function getRefreshTaskById(id) {
    positiveId(id);
    return withDb(async db => taskRow(await get(db, `SELECT ${COLUMNS} FROM ${TABLE} WHERE id=?`, [id])));
}

async function beginRefreshOrderSync(userId, options = {}) {
    positiveId(userId, 'user_id');
    const token = text(options.token, 'token'), now = dateText(options.now), scoped = scope(options);
    return withDb(async db => ({ changes: (await run(db, `UPDATE ${TABLE} SET sync_token=?,sync_ready=0,modify_date=?
        WHERE business_scene=? AND target_channel=? AND user_id=? AND is_deleted=0
          AND attempted_at='' AND status IN ('watching','pending')`, [token, now, ...scoped, userId])).changes }), true);
}

async function completeRefreshOrderSync(userId, options = {}) {
    positiveId(userId, 'user_id');
    const token = text(options.token, 'token'), now = dateText(options.now), scoped = scope(options);
    return withDb(async db => ({ changes: (await run(db, `UPDATE ${TABLE} SET sync_ready=1,modify_date=?
        WHERE business_scene=? AND target_channel=? AND user_id=? AND sync_token=? AND is_deleted=0
          AND attempted_at='' AND status IN ('watching','pending')`, [now, ...scoped, userId, token])).changes }), true);
}

async function observeActiveOrder(input, options = {}) {
    const key = identity(input), fields = sourceFields(input, false), now = dateText(options.now);
    const token = options.sync_token === undefined ? '' : text(options.sync_token, 'sync_token');
    return withDb(async db => {
        await run(db, `INSERT OR IGNORE INTO ${TABLE}
            (business_scene,target_channel,user_id,source_channel,order_no,game_id,game_name,game_account,
             target_product_id,source_order_status,start_time,end_time,observed_active_at,sync_token,status,create_date,modify_date)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'watching',?,?)`, [...key, ...fields, now, token, now, now]);
        await run(db, `UPDATE ${TABLE} SET game_id=?,game_name=?,game_account=?,source_order_status=?,start_time=?,end_time=?,
            observed_active_at=CASE WHEN observed_active_at>? THEN observed_active_at ELSE ? END,
            status='watching',next_check_at='',modify_date=?,sync_token=CASE WHEN sync_token='' THEN ? ELSE sync_token END
            WHERE business_scene=? AND target_channel=? AND user_id=? AND source_channel=? AND order_no=?
              AND is_deleted=0 AND attempted_at='' AND status IN ('watching','pending')
              AND (?='' OR sync_token='' OR sync_token=?)`,
        [fields[0], fields[1], fields[2], fields[4], fields[5], fields[6], now, now, now, token, ...key, token, token]);
        return taskRow(await get(db, `SELECT ${COLUMNS} FROM ${TABLE}
            WHERE business_scene=? AND target_channel=? AND user_id=? AND source_channel=? AND order_no=?`, key));
    }, true);
}

async function enqueueRefreshOrder(input, options = {}) {
    const key = identity(input), fields = sourceFields(input, true), now = dateText(options.now);
    const token = options.sync_token === undefined ? '' : text(options.sync_token, 'sync_token');
    return withDb(async db => {
        const inserted = await run(db, `INSERT OR IGNORE INTO ${TABLE}
            (business_scene,target_channel,user_id,source_channel,order_no,game_id,game_name,game_account,
             target_product_id,source_order_status,start_time,end_time,observed_active_at,sync_token,status,create_date,modify_date)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)`, [...key, ...fields, String(input.observed_active_at || ''), token, now, now]);
        const changed = await run(db, `UPDATE ${TABLE} SET game_id=?,game_name=?,game_account=?,target_product_id=?,
            source_order_status=?,start_time=?,end_time=?,status='pending',next_check_at='',modify_date=?,
            sync_token=CASE WHEN sync_token='' THEN ? ELSE sync_token END
            WHERE business_scene=? AND target_channel=? AND user_id=? AND source_channel=? AND order_no=?
              AND is_deleted=0 AND attempted_at='' AND status='watching'
              AND (sync_token='' OR sync_token=?)`, [...fields, now, token, ...key, token]);
        const row = taskRow(await get(db, `SELECT ${COLUMNS} FROM ${TABLE}
            WHERE business_scene=? AND target_channel=? AND user_id=? AND source_channel=? AND order_no=?`, key));
        return { created: inserted.changes === 1, queued: inserted.changes === 1 || changed.changes === 1, row };
    }, true);
}

function pageOptions(options, defaultLimit = 200) {
    const limit = options.limit === undefined ? defaultLimit : options.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error('limit must be an integer from 1 to 1000');
    return limit;
}

async function listSourceOrdersForRefresh(userId, options = {}) {
    positiveId(userId, 'user_id');
    const limit = pageOptions(options), after = options.after_id === undefined ? 0 : options.after_id;
    if (!Number.isSafeInteger(after) || after < 0) throw new Error('after_id must be a non-negative integer');
    const activation = dateText(options.activated_at);
    const scene = options.business_scene === undefined ? BUSINESS_SCENE : text(options.business_scene, 'business_scene');
    const target = options.target_channel === undefined ? TARGET_CHANNEL : text(options.target_channel, 'target_channel');
    return withDb(db => all(db, `SELECT ${SOURCE_COLUMNS},COALESCE(r.observed_active_at,'') AS observed_active_at,
        COALESCE(r.status,'') AS task_status
        FROM "order" o LEFT JOIN ${TABLE} r ON r.business_scene=? AND r.target_channel=?
          AND r.user_id=o.user_id AND r.source_channel=o.channel AND r.order_no=o.order_no
        WHERE o.user_id=? AND o.is_deleted=0 AND o.id>?
          AND (o.start_time>=? OR o.order_status IN ('租赁中','出租中') OR r.status IN ('watching','pending'))
          AND (r.id IS NULL OR (r.is_deleted=0 AND r.attempted_at='' AND r.status IN ('watching','pending')))
        ORDER BY o.id LIMIT ?`, [scene, target, userId, after, activation, limit]));
}

async function getSourceOrder(userId, channel, orderNo) {
    positiveId(userId, 'user_id');
    const params = [userId, text(channel, 'channel'), text(orderNo, 'order_no')];
    return withDb(db => get(db, `SELECT ${SOURCE_COLUMNS} FROM "order" o
        WHERE o.user_id=? AND o.channel=? AND o.order_no=? ORDER BY o.is_deleted,o.id DESC LIMIT 1`, params));
}

async function listPendingRefreshTasks(options = {}) {
    const now = dateText(options.now), limit = pageOptions(options, 100), params = [...scope(options), now];
    let userSql = '';
    if (options.user_ids !== undefined && options.user_ids !== null) {
        if (!Array.isArray(options.user_ids) || options.user_ids.length > 1000) throw new Error('user_ids must be an array of at most 1000 positive integers');
        const ids = [...new Set(options.user_ids.map(id => positiveId(id, 'user_id')))];
        if (!ids.length) return [];
        userSql = ` AND user_id IN (${ids.map(() => '?').join(',')})`;
        params.push(...ids);
    }
    return withDb(async db => (await all(db, `SELECT ${COLUMNS} FROM ${TABLE}
        WHERE business_scene=? AND target_channel=? AND status='pending' AND attempted_at='' AND is_deleted=0
          AND sync_ready=1 AND sync_token<>'' AND (next_check_at='' OR next_check_at<=?)
          ${userSql} ORDER BY next_check_at,id LIMIT ?`, [...params, limit])).map(taskRow));
}

async function claimRefreshAttempt(id, options = {}) {
    positiveId(id);const now = dateText(options.now), scoped = scope(options);
    if (typeof options.sync_token !== 'string' || !options.sync_token.trim()) return null;
    return withDb(async db => {
        const result = await run(db, `UPDATE ${TABLE} SET status='sending',attempted_at=?,modify_date=?,next_check_at=''
            WHERE id=? AND business_scene=? AND target_channel=? AND status='pending' AND attempted_at='' AND is_deleted=0
              AND sync_ready=1 AND sync_token=? AND (next_check_at='' OR next_check_at<=?)`,
        [now, now, id, ...scoped, options.sync_token.trim(), now]);
        return result.changes === 1 ? taskRow(await get(db, `SELECT ${COLUMNS} FROM ${TABLE} WHERE id=?`, [id])) : null;
    });
}

async function finishRefreshAttempt(id, options = {}) {
    positiveId(id);
    if (!['success', 'failed', 'unknown'].includes(options.status)) throw new Error('Invalid refresh completion status');
    const now = dateText(options.now), summary = outcomeSummary(options.summary), scoped = scope(options);
    return withDb(async db => (await run(db, `UPDATE ${TABLE} SET status=?,finished_at=?,modify_date=?,result_code=?,
        result_message=?,result_summary=? WHERE id=? AND business_scene=? AND target_channel=? AND status='sending' AND attempted_at<>'' AND is_deleted=0`,
    [options.status, now, now, String(options.code ?? '').slice(0, 100), String(options.message || '').slice(0, 300), summary, id, ...scoped])).changes === 1);
}

async function deferRefreshTask(id, options = {}) {
    positiveId(id);const now = dateText(options.now), next = dateText(options.next_check_at), scoped = scope(options);
    return withDb(async db => (await run(db, `UPDATE ${TABLE} SET next_check_at=?,modify_date=?,desc=?
        WHERE id=? AND business_scene=? AND target_channel=? AND status='pending' AND attempted_at='' AND is_deleted=0`, [next, now, String(options.reason || '').slice(0, 300), id, ...scoped])).changes === 1);
}

async function skipRefreshTask(id, options = {}) {
    positiveId(id);const now = dateText(options.now), scoped = scope(options);
    return withDb(async db => (await run(db, `UPDATE ${TABLE} SET status='skipped',finished_at=?,modify_date=?,desc=?
        WHERE id=? AND business_scene=? AND target_channel=? AND status IN ('watching','pending') AND attempted_at='' AND is_deleted=0`,
    [now, now, String(options.reason || '').slice(0, 300), id, ...scoped])).changes === 1);
}

async function recoverStaleRefreshAttempts(options = {}) {
    const now = dateText(options.now), before = dateText(options.before), scoped = scope(options);
    return withDb(async db => {
        const result = await run(db, `UPDATE ${TABLE} SET status='unknown',finished_at=?,modify_date=?,result_code='PROCESS_INTERRUPTED',
            result_message='请求结果未知，不自动重发' WHERE business_scene=? AND target_channel=? AND status='sending' AND attempted_at<>'' AND attempted_at<=? AND is_deleted=0`, [now, now, ...scoped, before]);
        return { changes: result.changes };
    });
}

module.exports = {
    BUSINESS_SCENE, TARGET_CHANNEL, initOrderGameInfoRefreshDb, beginRefreshOrderSync, completeRefreshOrderSync,
    observeActiveOrder, enqueueRefreshOrder,
    listSourceOrdersForRefresh, getSourceOrder, listPendingRefreshTasks, claimRefreshAttempt,
    finishRefreshAttempt, deferRefreshTask, skipRefreshTask, recoverStaleRefreshAttempts,
    getRefreshTaskByIdentity, getRefreshTaskById
};
