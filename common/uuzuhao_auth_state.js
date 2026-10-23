'use strict';

const AUTHORIZATION_PAUSED = 'UUZUHAO_AUTHORIZATION_PAUSED';
const REAUTHORIZE_MESSAGE = 'QQ鉴权失败，请号主前往悠悠租号重新授权。后台在线检测已暂停，授权后点击“状态查询”恢复。';
const PRODUCT_NOT_FOUND_MESSAGE = '悠悠商品不存在，请号主前往悠悠租号检查并恢复商品，必要时重新授权。后台在线检测已暂停，处理后点击“状态查询”恢复。';

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
    if (code === '12101001') {
        return { error_code: code, reason: '悠悠商品不存在' };
    }
    if (code === '201010027' || (code === '-50000' && /QQ\s*鉴权失败/.test(message))) {
        return { error_code: code, reason: 'QQ鉴权失败' };
    }
    return null;
}

function pausedOnlineError(state) {
    const normalized = normalizeUuzuhaoAuthState(state);
    const message = String(normalized.error_code || '').trim() === '12101001'
        ? PRODUCT_NOT_FOUND_MESSAGE
        : REAUTHORIZE_MESSAGE;
    const error = new Error(message);
    error.code = AUTHORIZATION_PAUSED;
    error.uuzuhao_auth_state = normalized;
    return error;
}

module.exports = {
    AUTHORIZATION_PAUSED,
    REAUTHORIZE_MESSAGE,
    PRODUCT_NOT_FOUND_MESSAGE,
    normalizeUuzuhaoAuthState,
    classifyOnlineAuthFailure,
    pausedOnlineError
};
