'use strict';

const crypto = require('crypto');
const { openMainDatabase, openRuntimeDatabase } = require('./sqlite_client');
const { initRuntimeTaskDb } = require('./runtime_task_db');
const { tryAcquireLock, releaseOwnedLock } = require('./lock_db');
const { normalizeUuzuhaoAuthState } = require('../common/uuzuhao_auth_state');
const { resolveUuzuhaoReauthorizeState } = require('../product/prod_channel_status');

const TASK_TYPE = 'uuzuhao_reauthorize';
function object(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}; }
    catch { return {}; }
}
function sql(db, query, params = [], write = false) {
    return new Promise((resolve, reject) => write
        ? db.run(query, params, function (error) { if (error) reject(error); else resolve(this.changes); })
        : db.all(query, params, (error, rows) => error ? reject(error) : resolve(rows)));
}
async function read(connection, query, params = []) {
    const db = connection();
    try { return await sql(db, query, params); } finally { db.close(); }
}
function parseAccount(row) {
    return { ...row, channel_prd_info: object(row.channel_prd_info),
        uuzuhao_auth_state: normalizeUuzuhaoAuthState(row.uuzuhao_auth_state), auth_payload: object(row.auth_payload) };
}
const ACCOUNT_QUERY = `SELECT a.id, a.user_id, a.game_id, a.game_account, a.game_name, a.is_deleted,
    a.manual_deleted, a.asset_status, a.channel_prd_info, a.uuzuhao_auth_state, a.channel_status, a.switch,
    u.status AS user_status, p.auth_status, p.expire_at, p.channel_enabled, p.auth_payload
    FROM user_game_account a JOIN user u ON u.id = a.user_id AND u.is_deleted = 0
    LEFT JOIN user_platform_auth p ON p.user_id = a.user_id AND p.platform = 'uuzuhao' AND p.is_deleted = 0`;
async function listRecoveryAccounts() {
    const rows = await read(openMainDatabase, ACCOUNT_QUERY);
    return rows.map(parseAccount);
}
async function getRecoveryAccount(id) {
    const [row] = await read(openMainDatabase, `${ACCOUNT_QUERY} WHERE a.id = ?`, [id]);
    return row ? parseAccount(row) : null;
}
function hasAuthorizationError(row) {
    return row.uuzuhao_auth_state.required || resolveUuzuhaoReauthorizeState(row).hit;
}
async function listRecoveryTasks(userId) {
    await initRuntimeTaskDb();
    const rows = await read(openRuntimeDatabase, `SELECT * FROM runtime_task WHERE task_type = ? AND is_deleted = 0
        ${userId === undefined ? '' : 'AND user_id = ?'} ORDER BY id DESC`, userId === undefined ? [TASK_TYPE] : [TASK_TYPE, userId]);
    const latest = new Map();
    for (const row of rows) {
        const state = object(row.result_json);
        if (!latest.has(state.account_id)) latest.set(state.account_id, { ...row, state });
    }
    return latest;
}
async function hasAuthorizationConflict(identity, operation) {
    await initRuntimeTaskDb();
    const rows = await read(openRuntimeDatabase, `SELECT task_type, stage, result_json FROM runtime_task
        WHERE user_id = ? AND task_type = ? AND is_deleted = 0 AND status IN ('pending','running','failed')`,
    [identity.user_id, operation === 'reauthorize' ? 'uuzuhao_auth_revoke' : TASK_TYPE]);
    return rows.some(row => {
        const state = object(row.result_json);
        const input = state.input || state;
        return String(input.game_id) === String(identity.game_id) && input.game_account === identity.game_account
            && (operation === 'reauthorize' || Boolean(state.remote_task_id) || row.stage === 'submitting');
    });
}
async function withAuthorizationLock(identity, work) {
    const digest = crypto.createHash('sha256').update(`${identity.user_id}|${identity.game_id}|${identity.game_account}`).digest('hex');
    const key = `uuzuhao_authorization_${digest}`;
    const owner = `pid=${process.pid} token=${crypto.randomUUID()}`;
    if (!(await tryAcquireLock(key, 120, owner)).acquired) return { acquired: false };
    try { return { acquired: true, value: await work() }; }
    finally { await releaseOwnedLock(key, owner); }
}

async function clearRecoveredAuthorization(expected, requestStartedAt) {
    const db = openMainDatabase();
    try {
        await sql(db, 'BEGIN IMMEDIATE', [], true);
        const [row] = await sql(db, 'SELECT * FROM user_game_account WHERE id = ? AND user_id = ? AND is_deleted = 0',
            [expected.id, expected.user_id]);
        if (!row || row.manual_deleted || row.asset_status === 'sold') {
            await sql(db, 'COMMIT', [], true);
            return false;
        }
        const current = normalizeUuzuhaoAuthState(row.uuzuhao_auth_state);
        const previous = expected.uuzuhao_auth_state;
        const prd = object(row.channel_prd_info);
        const oldPrd = expected.channel_prd_info.uuzuhao || {};
        const currentPrd = prd.uuzuhao || {};
        const authorizationFacts = value => JSON.stringify([value.prd_id, value.off_type, value.reason]);
        // Do not let an older remote task erase a newer local observation or product identity.
        if (current.version !== previous.version || Number(current.request_started_at || 0) > requestStartedAt
            || authorizationFacts(currentPrd) !== authorizationFacts(oldPrd)) {
            await sql(db, 'COMMIT', [], true);
            return false;
        }
        if (resolveUuzuhaoReauthorizeState(currentPrd).hit) {
            prd.uuzuhao = { ...currentPrd };
            if (resolveUuzuhaoReauthorizeState({ off_type: currentPrd.off_type }).hit) prd.uuzuhao.off_type = '';
            if (resolveUuzuhaoReauthorizeState({ reason: currentPrd.reason }).hit) prd.uuzuhao.reason = '';
        }
        const state = { required: false, version: Number(current.version || 0) + 1,
            request_started_at: requestStartedAt, recovered_at: new Date().toISOString(), recovery_source: 'hosting_status' };
        await sql(db, `UPDATE user_game_account SET uuzuhao_auth_state = ?, channel_prd_info = ?,
            online_probe_snapshot = '{}', modify_date = datetime('now', '+8 hours') WHERE id = ?`,
        [JSON.stringify(state), JSON.stringify(prd), row.id], true);
        await sql(db, 'COMMIT', [], true);
        return true;
    } catch (error) {
        await sql(db, 'ROLLBACK', [], true);
        throw error;
    } finally { db.close(); }
}

module.exports = { TASK_TYPE, object, listRecoveryAccounts, getRecoveryAccount, hasAuthorizationError,
    listRecoveryTasks, hasAuthorizationConflict, withAuthorizationLock, clearRecoveredAuthorization };
