'use strict';

const { performance } = require('perf_hooks');
const { getUuzuhaoAuthState, recordUuzuhaoAuthObservation } = require('../database/uuzuhao_auth_state_db');
const { classifyOnlineAuthFailure, pausedOnlineError, SHELF_AUTH_ERROR_CODES } = require('../common/uuzuhao_auth_state');

function onlineRequestStartedAt() {
    return performance.timeOrigin + performance.now();
}

async function assertOnlineAuthAllowed(userId, identity, options = {}) {
    const state = await getUuzuhaoAuthState(userId, identity);
    if (state.required && options.manual !== true) throw pausedOnlineError(state);
    return state;
}

async function recordOnlineAuthFailure(userId, identity, error, requestStartedAt) {
    const failure = classifyOnlineAuthFailure(error);
    if (!failure) return null;
    const state = await recordUuzuhaoAuthObservation(userId, identity, {
        ...failure, required: true, request_started_at: requestStartedAt,
        preserve_error_codes: SHELF_AUTH_ERROR_CODES
    });
    error.uuzuhao_auth_state = state;
    return state;
}

async function recordManualOnlineSuccess(userId, identity, requestStartedAt) {
    return recordUuzuhaoAuthObservation(userId, identity, {
        required: false, request_started_at: requestStartedAt,
        preserve_error_codes: SHELF_AUTH_ERROR_CODES
    });
}

module.exports = {
    onlineRequestStartedAt,
    assertOnlineAuthAllowed,
    recordOnlineAuthFailure,
    recordManualOnlineSuccess
};
