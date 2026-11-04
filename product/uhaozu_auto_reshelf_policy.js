'use strict';

const { getSystemConfig } = require('../database/system_config_db');
const { isUhaozuOnlineDetectReason } = require('./prod_channel_status');

const UHAOZU_AUTO_RESHELF_CONFIG_KEY = 'uhaozu.auto_reshelf_reasons';
const ONLINE_DETECT_REASON = '检测游戏在线，请确认游戏离线后手动上架';

function normalizeUhaozuReshelfReason(reason) {
    if (typeof reason !== 'string') return '';
    return reason.normalize('NFKC').trim().replace(/\s+/gu, '').replace(/，/gu, ',').replace(/:+$/u, '');
}

function validateUhaozuAutoReshelfValue(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || Object.keys(value).some((key) => key !== 'reasons')
        || !Array.isArray(value.reasons) || value.reasons.length > 100) {
        const error = new Error('U号租恢复配置必须是 {reasons: string[]}，最多100项');
        error.code = 'INVALID_UHAOZU_RESHELF_CONFIG';
        throw error;
    }
    const seen = new Set();
    const reasons = [];
    for (const reason of value.reasons) {
        if (typeof reason !== 'string' || reason.length > 1000 || !normalizeUhaozuReshelfReason(reason)) {
            const error = new Error('U号租恢复原因必须是非空字符串，长度不超过1000');
            error.code = 'INVALID_UHAOZU_RESHELF_CONFIG';
            throw error;
        }
        const normalized = normalizeUhaozuReshelfReason(reason);
        if (!seen.has(normalized)) {
            seen.add(normalized);
            reasons.push(reason.trim());
        }
    }
    return { reasons };
}

function makePolicy(row, reasons, error = '') {
    return Object.freeze({
        key: UHAOZU_AUTO_RESHELF_CONFIG_KEY,
        id: Number(row && row.id || 0),
        version: Number(row && row.version || 0),
        available: !error,
        error,
        reasons: Object.freeze([...reasons])
    });
}

async function loadUhaozuAutoReshelfPolicy(options = {}) {
    const getConfig = options.getConfig || getSystemConfig;
    let row;
    try {
        row = await getConfig(UHAOZU_AUTO_RESHELF_CONFIG_KEY);
        if (!row || !row.found) {
            const error = new Error('恢复配置不存在');
            error.code = 'SYSTEM_CONFIG_NOT_FOUND';
            throw error;
        }
        const value = validateUhaozuAutoReshelfValue(row.value);
        return makePolicy(row, value.reasons);
    } catch (error) {
        const logger = options.logger || console;
        const log = typeof logger.warn === 'function' ? logger.warn : logger.log;
        if (typeof log === 'function') {
            log.call(logger, `[UhaozuAutoReshelf] key=${UHAOZU_AUTO_RESHELF_CONFIG_KEY} available=0 error_code=${error.code || 'CONFIG_READ_FAILED'}`);
        }
        return makePolicy(row, [], String(error.code || 'CONFIG_READ_FAILED'));
    }
}

function matchUhaozuAutoReshelfReason(reason, policy) {
    if (!policy || policy.available !== true || !Array.isArray(policy.reasons)) return false;
    const normalized = normalizeUhaozuReshelfReason(reason);
    if (!normalized) return false;
    const configured = new Set(policy.reasons.map(normalizeUhaozuReshelfReason).filter(Boolean));
    if (configured.has(normalized)) return true;
    return configured.has(normalizeUhaozuReshelfReason(ONLINE_DETECT_REASON))
        && isUhaozuOnlineDetectReason(reason);
}

module.exports = {
    UHAOZU_AUTO_RESHELF_CONFIG_KEY,
    normalizeUhaozuReshelfReason,
    validateUhaozuAutoReshelfValue,
    loadUhaozuAutoReshelfPolicy,
    matchUhaozuAutoReshelfReason
};
