'use strict';

const { getUuzuhaoAuthState, recordUuzuhaoAuthObservation } = require('../database/uuzuhao_auth_state_db');
const { classifyShelfAuthFailure, pausedOnlineError, SHELF_AUTH_ERROR_CODES } = require('../common/uuzuhao_auth_state');
const { onlineRequestStartedAt } = require('./uuzuhao_online_auth_service');
const { resolveUuzuhaoReauthorizeState } = require('./prod_channel_status');

async function recordShelfFailure(userId, identity, result, startedAt) {
    const failure = classifyShelfAuthFailure(result);
    if (!failure) return null;
    return recordUuzuhaoAuthObservation(userId, identity, {
        ...failure, required: true, request_started_at: startedAt
    });
}

async function executeUuzuhaoOnShelf(userId, identity, request) {
    const state = await getUuzuhaoAuthState(userId, identity);
    if (state.required) {
        return { ok: false, skipped: true, msg: pausedOnlineError(state).message, uuzuhao_auth_state: state };
    }
    const startedAt = onlineRequestStartedAt();
    let result;
    try {
        result = await request();
    } catch (error) {
        const marked = await recordShelfFailure(userId, identity, error, startedAt);
        if (marked) error.uuzuhao_auth_state = marked;
        throw error;
    }
    if (result && result.ok === false) {
        const marked = await recordShelfFailure(userId, identity, result, startedAt);
        if (marked) return { ...result, uuzuhao_auth_state: marked };
    }
    return result;
}

async function recoverShelfAuthByProduct(userId, product, requestStartedAt) {
    const info = product.prd_info || {};
    if (!String(info.prd_id || '').trim()
        || !['上架', '租赁中', '出租中'].includes(product.status)
        || resolveUuzuhaoReauthorizeState(info).hit) return null;
    const state = await getUuzuhaoAuthState(userId, product);
    if (!state.required || !SHELF_AUTH_ERROR_CODES.includes(String(state.error_code || '').trim())) return null;
    // Only a fresh successful product pull may clear shelf authorization failures.
    return recordUuzuhaoAuthObservation(userId, product, {
        required: false, request_started_at: requestStartedAt, if_error_codes: SHELF_AUTH_ERROR_CODES
    });
}

module.exports = { executeUuzuhaoOnShelf, recoverShelfAuthByProduct };
