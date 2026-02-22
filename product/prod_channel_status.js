const NORM_CODE_LABEL_MAP = {
    auth_abnormal: '授权异常',
    review_fail: '审核失败',
    restricted: '平台限制',
    renting: '租赁中',
    listed: '上架',
    off_shelf: '下架',
    unknown: '未知'
};

const NORM_CODE_LEVEL_MAP = {
    auth_abnormal: 100,
    review_fail: 90,
    restricted: 80,
    renting: 70,
    listed: 60,
    off_shelf: 50,
    unknown: 0
};

const PLATFORM_STATUS_KEYS = ['uuzuhao', 'uhaozu', 'zuhaowang'];

function isUhaozuOnlineDetectReason(reason) {
    const text = String(reason || '').trim();
    if (!text) return false;
    if (text.includes('检测游戏在线，请确认游戏离线后手动上架')) return true;
    return /检测.*游戏在线/.test(text) && /离线后手动上架/.test(text);
}

function restrictedLabelByReason(reason) {
    const text = String(reason || '').trim();
    if (!text) return NORM_CODE_LABEL_MAP.restricted;
    if (text.includes('仅卖家下架状态支持直接上架')) return '平台限制上架';
    return NORM_CODE_LABEL_MAP.restricted;
}

function buildNormalizedStatus(code, reason = '') {
    const c = String(code || '').trim() || 'unknown';
    return {
        code: NORM_CODE_LABEL_MAP[c] ? c : 'unknown',
        label: NORM_CODE_LABEL_MAP[c] || NORM_CODE_LABEL_MAP.unknown,
        reason: String(reason || '').trim(),
        level: Number(NORM_CODE_LEVEL_MAP[c] || 0)
    };
}

function normalizedCodeFromChannelText(text) {
    const t = String(text || '').trim();
    if (!t) return 'unknown';
    if (t === '租赁中' || t === '出租中') return 'renting';
    if (t === '上架') return 'listed';
    if (t === '下架') return 'off_shelf';
    if (t === '审核失败') return 'review_fail';
    if (t.includes('异常') || t.includes('授权')) return 'auth_abnormal';
    return 'unknown';
}

function normalizeOnePlatformStatus(platform, channelStatus = {}, channelPrdInfo = {}, restrictReason = '') {
    const p = String(platform || '').trim();
    const statusText = String((channelStatus && channelStatus[p]) || '').trim();
    const prd = channelPrdInfo && typeof channelPrdInfo === 'object' ? (channelPrdInfo[p] || {}) : {};
    const restrictMsg = String(restrictReason || '').trim();
    const codeByText = normalizedCodeFromChannelText(statusText);

    if (p === 'uhaozu') {
        const auditReason = String(prd.audit_reason || prd.reason || '').trim();
        if (auditReason) {
            const label = isUhaozuOnlineDetectReason(auditReason) ? '检测在线' : NORM_CODE_LABEL_MAP.auth_abnormal;
            return {
                code: 'auth_abnormal',
                label,
                reason: auditReason,
                level: Number(NORM_CODE_LEVEL_MAP.auth_abnormal || 100)
            };
        }
        if (restrictMsg) {
            return {
                code: 'restricted',
                label: restrictedLabelByReason(restrictMsg),
                reason: restrictMsg,
                level: Number(NORM_CODE_LEVEL_MAP.restricted || 80)
            };
        }
        const goodsStatus = Number(prd.goods_status);
        const rentStatus = Number(prd.rent_status);
        if (goodsStatus === 4) return buildNormalizedStatus('off_shelf');
        if (goodsStatus === 3 && rentStatus === 0) return buildNormalizedStatus('renting');
        if (goodsStatus === 3 && rentStatus === 1) return buildNormalizedStatus('listed');
        return buildNormalizedStatus(codeByText);
    }

    if (p === 'zuhaowang') {
        const exceptionMsg = String(prd.exception_msg || '').trim();
        if (exceptionMsg) return buildNormalizedStatus('auth_abnormal', exceptionMsg);
        if (restrictMsg) {
            return {
                code: 'restricted',
                label: restrictedLabelByReason(restrictMsg),
                reason: restrictMsg,
                level: Number(NORM_CODE_LEVEL_MAP.restricted || 80)
            };
        }
        const rawStatus = Number(prd.raw_status);
        if (rawStatus === 2) return buildNormalizedStatus('renting');
        if (rawStatus === 1) return buildNormalizedStatus('listed');
        if (rawStatus === -1) return buildNormalizedStatus('off_shelf');
        return buildNormalizedStatus(codeByText);
    }

    if (restrictMsg) {
        return {
            code: 'restricted',
            label: restrictedLabelByReason(restrictMsg),
            reason: restrictMsg,
            level: Number(NORM_CODE_LEVEL_MAP.restricted || 80)
        };
    }
    return buildNormalizedStatus(codeByText, String(prd.reason || '').trim());
}

function buildPlatformStatusNorm(channelStatus = {}, channelPrdInfo = {}, restrictByPlatform = {}) {
    const out = {};
    for (const key of PLATFORM_STATUS_KEYS) {
        const reason = String((restrictByPlatform && restrictByPlatform[key]) || '').trim();
        out[key] = normalizeOnePlatformStatus(key, channelStatus, channelPrdInfo, reason);
    }
    return out;
}

function pickOverallStatusNorm(platformStatusNorm = {}) {
    const all = PLATFORM_STATUS_KEYS.map((k) => platformStatusNorm[k]).filter((x) => x && typeof x === 'object');
    if (all.length === 0) return buildNormalizedStatus('unknown');
    all.sort((a, b) => Number(b.level || 0) - Number(a.level || 0));
    return all[0];
}

function isRestrictedLikeStatus(code) {
    const c = String(code || '').trim();
    return c === 'auth_abnormal' || c === 'review_fail' || c === 'restricted';
}

function isOnAllowedByCode(code) {
    return !isRestrictedLikeStatus(code);
}

module.exports = {
    NORM_CODE_LABEL_MAP,
    NORM_CODE_LEVEL_MAP,
    PLATFORM_STATUS_KEYS,
    buildNormalizedStatus,
    normalizedCodeFromChannelText,
    normalizeOnePlatformStatus,
    buildPlatformStatusNorm,
    pickOverallStatusNorm,
    isRestrictedLikeStatus,
    isOnAllowedByCode,
    isUhaozuOnlineDetectReason,
    restrictedLabelByReason
};
