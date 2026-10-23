'use strict';

const { openDatabase } = require('./sqlite_client');
const { initUserGameAccountDb } = require('./user_game_account_db');
const { canonicalGameId } = require('../common/game_profile');
const { normalizeUuzuhaoAuthState } = require('../common/uuzuhao_auth_state');

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => db.run(sql, params, function (error) {
        if (error) reject(error); else resolve(this);
    }));
}

function get(db, sql, params) {
    return new Promise((resolve, reject) => db.get(sql, params, (error, row) => {
        if (error) reject(error); else resolve(row);
    }));
}

function identityParams(userId, identity = {}) {
    const uid = Number(userId);
    const account = String(identity.game_account || identity.account || '').trim();
    if (!Number.isInteger(uid) || uid <= 0) throw new Error('user_id 不合法');
    if (!account) throw new Error('game_account 不能为空');
    return [uid, canonicalGameId(identity.game_id, identity.game_name || 'WZRY'), account];
}

const ACCOUNT_SQL = `SELECT id, uuzuhao_auth_state FROM user_game_account
    WHERE user_id = ? AND game_id = ? AND game_account = ? AND is_deleted = 0
    ORDER BY id DESC LIMIT 1`;

async function getUuzuhaoAuthState(userId, identity) {
    const params = identityParams(userId, identity);
    await initUserGameAccountDb();
    const db = openDatabase();
    try {
        const row = await get(db, ACCOUNT_SQL, params);
        return normalizeUuzuhaoAuthState(row && row.uuzuhao_auth_state);
    } finally {
        db.close();
    }
}

async function recordUuzuhaoAuthObservation(userId, identity, observation) {
    const params = identityParams(userId, identity);
    const requestedAt = Number(observation.request_started_at);
    if (!Number.isFinite(requestedAt) || requestedAt <= 0) throw new Error('request_started_at 不合法');
    await initUserGameAccountDb();
    const db = openDatabase();
    try {
        await run(db, 'BEGIN IMMEDIATE');
        const row = await get(db, ACCOUNT_SQL, params);
        if (!row) throw new Error('找不到账号');
        const previous = normalizeUuzuhaoAuthState(row.uuzuhao_auth_state);
        const previousCode = String(previous.error_code || '').trim();
        const preserved = previous.required && (observation.preserve_error_codes || []).includes(previousCode);
        const unexpected = Array.isArray(observation.if_error_codes)
            && (!previous.required || !observation.if_error_codes.includes(previousCode));
        // Keep a success watermark so an older in-flight failure cannot re-block recovery.
        if (Number(previous.request_started_at || 0) > requestedAt || preserved || unexpected) {
            await run(db, 'COMMIT');
            return previous;
        }
        const now = new Date().toISOString();
        const required = observation.required === true;
        const state = {
            required,
            request_started_at: requestedAt,
            version: Math.max(0, Number(previous.version) || 0) + 1,
            first_failed_at: required ? (previous.required && previous.first_failed_at || now) : '',
            last_failed_at: required ? now : '',
            error_code: required ? String(observation.error_code || '') : '',
            reason: required ? String(observation.reason || '') : '',
            recovered_at: required ? '' : now
        };
        await run(db, `UPDATE user_game_account SET uuzuhao_auth_state = ?, modify_date = datetime('now', '+8 hours')
            WHERE id = ?`, [JSON.stringify(state), row.id]);
        await run(db, 'COMMIT');
        return state;
    } catch (error) {
        await run(db, 'ROLLBACK').catch(() => {});
        throw error;
    } finally {
        db.close();
    }
}

module.exports = { getUuzuhaoAuthState, recordUuzuhaoAuthObservation };
