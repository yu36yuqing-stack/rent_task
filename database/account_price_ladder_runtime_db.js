'use strict';

const { openPriceDatabase } = require('./sqlite_client');

function nowText() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
}

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row || null);
        });
    });
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

function toRuntime(row = {}) {
    return {
        id: Number(row.id || 0),
        user_id: Number(row.user_id || 0),
        game_id: String(row.game_id || '').trim(),
        game_name: String(row.game_name || '').trim(),
        game_account: String(row.game_account || '').trim(),
        channel: String(row.channel || '').trim(),
        business_date: String(row.business_date || '').slice(0, 10),
        completed_order_count: Number(row.completed_order_count || 0),
        desired_tier: Number(row.desired_tier || 0),
        applied_tier: Number(row.applied_tier || 0),
        pending_count_delta: Number(row.pending_count_delta || 0),
        rule_version: Number(row.rule_version || 0),
        baseline_version: Number(row.baseline_version || 0),
        desired_price_signature: String(row.desired_price_signature || '').trim(),
        applied_price_signature: String(row.applied_price_signature || '').trim(),
        status: String(row.status || '').trim(),
        trigger_source: String(row.trigger_source || '').trim(),
        last_order_no: String(row.last_order_no || '').trim(),
        last_error: String(row.last_error || '').trim(),
        retry_count: Number(row.retry_count || 0),
        next_retry_at: String(row.next_retry_at || '').trim(),
        last_apply_date: String(row.last_apply_date || '').trim(),
        create_date: String(row.create_date || '').trim(),
        modify_date: String(row.modify_date || '').trim(),
        is_deleted: Number(row.is_deleted || 0),
        desc: String(row.desc || '').trim()
    };
}

async function initAccountPriceLadderRuntimeDb() {
    const db = openPriceDatabase();
    try {
        await run(db, `
            CREATE TABLE IF NOT EXISTS account_price_ladder_runtime (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                game_id TEXT NOT NULL,
                game_name TEXT NOT NULL,
                game_account TEXT NOT NULL,
                channel TEXT NOT NULL DEFAULT 'uhaozu',
                business_date TEXT NOT NULL DEFAULT '',
                completed_order_count INTEGER NOT NULL DEFAULT 0,
                desired_tier INTEGER NOT NULL DEFAULT 0,
                applied_tier INTEGER NOT NULL DEFAULT 0,
                pending_count_delta INTEGER NOT NULL DEFAULT 0,
                rule_version INTEGER NOT NULL DEFAULT 0,
                baseline_version INTEGER NOT NULL DEFAULT 0,
                desired_price_signature TEXT NOT NULL DEFAULT '',
                applied_price_signature TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'idle',
                trigger_source TEXT NOT NULL DEFAULT '',
                last_order_no TEXT NOT NULL DEFAULT '',
                last_error TEXT NOT NULL DEFAULT '',
                retry_count INTEGER NOT NULL DEFAULT 0,
                next_retry_at TEXT NOT NULL DEFAULT '',
                last_apply_date TEXT NOT NULL DEFAULT '',
                create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        await run(db, `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_account_price_ladder_runtime_alive
            ON account_price_ladder_runtime(user_id, game_id, game_account, channel)
            WHERE is_deleted = 0
        `);
        await run(db, `
            CREATE INDEX IF NOT EXISTS idx_account_price_ladder_runtime_pending
            ON account_price_ladder_runtime(user_id, status, next_retry_at, is_deleted)
        `);
    } finally {
        db.close();
    }
}

async function getAccountPriceLadderRuntime(userId, gameId, gameAccount, channel = 'uhaozu') {
    await initAccountPriceLadderRuntimeDb();
    const uid = Number(userId || 0);
    const gid = String(gameId || '').trim();
    const account = String(gameAccount || '').trim();
    const channelName = String(channel || '').trim();
    if (!uid || !gid || !account || !channelName) return null;
    const db = openPriceDatabase();
    try {
        const row = await get(db, `
            SELECT *
            FROM account_price_ladder_runtime
            WHERE user_id = ? AND game_id = ? AND game_account = ? AND channel = ? AND is_deleted = 0
            LIMIT 1
        `, [uid, gid, account, channelName]);
        return row ? toRuntime(row) : null;
    } finally {
        db.close();
    }
}

async function listAccountPriceLadderRuntimesByUser(userId, options = {}) {
    await initAccountPriceLadderRuntimeDb();
    const uid = Number(userId || 0);
    if (!uid) return [];
    const statuses = Array.from(new Set((Array.isArray(options.statuses) ? options.statuses : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean)));
    const params = [uid];
    let statusSql = '';
    if (statuses.length > 0) {
        statusSql = ` AND status IN (${statuses.map(() => '?').join(',')})`;
        params.push(...statuses);
    }
    const db = openPriceDatabase();
    try {
        const rows = await all(db, `
            SELECT *
            FROM account_price_ladder_runtime
            WHERE user_id = ? AND is_deleted = 0${statusSql}
            ORDER BY id ASC
        `, params);
        return rows.map(toRuntime);
    } finally {
        db.close();
    }
}

function pick(input, key, fallback) {
    return Object.prototype.hasOwnProperty.call(input || {}, key) ? input[key] : fallback;
}

async function upsertAccountPriceLadderRuntime(userId, input = {}, options = {}) {
    await initAccountPriceLadderRuntimeDb();
    const uid = Number(userId || 0);
    const gameId = String(input.game_id || '').trim();
    const gameAccount = String(input.game_account || '').trim();
    const channel = String(input.channel || 'uhaozu').trim();
    if (!uid) throw new Error('user_id 不合法');
    if (!gameId || !gameAccount || !channel) throw new Error('阶梯运行状态账号信息不完整');

    const current = await getAccountPriceLadderRuntime(uid, gameId, gameAccount, channel);
    const merged = {
        game_name: String(pick(input, 'game_name', current && current.game_name) || '').trim(),
        business_date: String(pick(input, 'business_date', current && current.business_date) || '').slice(0, 10),
        completed_order_count: Number(pick(input, 'completed_order_count', current && current.completed_order_count) || 0),
        desired_tier: Number(pick(input, 'desired_tier', current && current.desired_tier) || 0),
        applied_tier: Number(pick(input, 'applied_tier', current && current.applied_tier) || 0),
        pending_count_delta: Number(pick(input, 'pending_count_delta', current && current.pending_count_delta) || 0),
        rule_version: Number(pick(input, 'rule_version', current && current.rule_version) || 0),
        baseline_version: Number(pick(input, 'baseline_version', current && current.baseline_version) || 0),
        desired_price_signature: String(pick(input, 'desired_price_signature', current && current.desired_price_signature) || '').trim(),
        applied_price_signature: String(pick(input, 'applied_price_signature', current && current.applied_price_signature) || '').trim(),
        status: String(pick(input, 'status', current && current.status) || 'idle').trim() || 'idle',
        trigger_source: String(pick(input, 'trigger_source', current && current.trigger_source) || '').trim(),
        last_order_no: String(pick(input, 'last_order_no', current && current.last_order_no) || '').trim(),
        last_error: String(pick(input, 'last_error', current && current.last_error) || '').trim(),
        retry_count: Number(pick(input, 'retry_count', current && current.retry_count) || 0),
        next_retry_at: String(pick(input, 'next_retry_at', current && current.next_retry_at) || '').trim(),
        last_apply_date: String(pick(input, 'last_apply_date', current && current.last_apply_date) || '').trim(),
        desc: String(options.desc || pick(input, 'desc', current && current.desc) || '').trim()
    };
    if (!merged.game_name) throw new Error('game_name 不能为空');

    const db = openPriceDatabase();
    const now = nowText();
    try {
        if (!current) {
            await run(db, `
                INSERT INTO account_price_ladder_runtime
                (user_id, game_id, game_name, game_account, channel, business_date, completed_order_count,
                 desired_tier, applied_tier, pending_count_delta, rule_version, baseline_version,
                 desired_price_signature, applied_price_signature, status, trigger_source, last_order_no,
                 last_error, retry_count, next_retry_at, last_apply_date, create_date, modify_date, is_deleted, desc)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
            `, [
                uid, gameId, merged.game_name, gameAccount, channel, merged.business_date,
                merged.completed_order_count, merged.desired_tier, merged.applied_tier, merged.pending_count_delta,
                merged.rule_version, merged.baseline_version, merged.desired_price_signature,
                merged.applied_price_signature, merged.status, merged.trigger_source, merged.last_order_no,
                merged.last_error, merged.retry_count, merged.next_retry_at, merged.last_apply_date,
                now, now, merged.desc
            ]);
        } else {
            await run(db, `
                UPDATE account_price_ladder_runtime
                SET game_name = ?, business_date = ?, completed_order_count = ?, desired_tier = ?, applied_tier = ?,
                    pending_count_delta = ?, rule_version = ?, baseline_version = ?, desired_price_signature = ?,
                    applied_price_signature = ?, status = ?, trigger_source = ?, last_order_no = ?, last_error = ?,
                    retry_count = ?, next_retry_at = ?, last_apply_date = ?, modify_date = ?, desc = ?
                WHERE id = ?
            `, [
                merged.game_name, merged.business_date, merged.completed_order_count, merged.desired_tier,
                merged.applied_tier, merged.pending_count_delta, merged.rule_version, merged.baseline_version,
                merged.desired_price_signature, merged.applied_price_signature, merged.status,
                merged.trigger_source, merged.last_order_no, merged.last_error, merged.retry_count,
                merged.next_retry_at, merged.last_apply_date, now, merged.desc, current.id
            ]);
        }
        const row = await get(db, `
            SELECT *
            FROM account_price_ladder_runtime
            WHERE user_id = ? AND game_id = ? AND game_account = ? AND channel = ? AND is_deleted = 0
            LIMIT 1
        `, [uid, gameId, gameAccount, channel]);
        return toRuntime(row || {});
    } finally {
        db.close();
    }
}

module.exports = {
    initAccountPriceLadderRuntimeDb,
    getAccountPriceLadderRuntime,
    listAccountPriceLadderRuntimesByUser,
    upsertAccountPriceLadderRuntime,
    _internal: {
        nowText,
        toRuntime,
        pick,
        run,
        get,
        all
    }
};
