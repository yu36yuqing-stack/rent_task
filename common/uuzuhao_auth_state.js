'use strict';

const AUTHORIZATION_PAUSED = 'UUZUHAO_AUTHORIZATION_PAUSED';
const REAUTHORIZE_MESSAGE = 'QQ鉴权失败，请号主前往悠悠租号重新授权。后台在线检测已暂停，授权后点击“状态查询”恢复。';

function normalizeUuzuhaoAuthState(input) {
    let state = input;
    if (typeof state === 'string') {
        try { state = JSON.parse(state); } catch { state = null; }
    }
    if (!state || typeof state !== 'object' || Array.isArray(state)) return { required: false };
    return { ...state, required: state.required === true };
}

function classifyOnlineAuthFailure(error = {}) {
    const response = error.uuzuhao_response || {};
    const code = String(error.code || response.code || '').trim();
    const message = String(error.message || response.msg || '').replace(/\*/g, '');
    if (code === '201010027' || (code === '-50000' && /QQ\s*鉴权失败/.test(message))) {
        return { error_code: code, reason: 'QQ鉴权失败' };
    }
    return null;
}

function pausedOnlineError(state) {
    const error = new Error(REAUTHORIZE_MESSAGE);
    error.code = AUTHORIZATION_PAUSED;
    error.uuzuhao_auth_state = normalizeUuzuhaoAuthState(state);
    return error;
}

module.exports = {
    AUTHORIZATION_PAUSED,
    REAUTHORIZE_MESSAGE,
    normalizeUuzuhaoAuthState,
    classifyOnlineAuthFailure,
    pausedOnlineError
};
