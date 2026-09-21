'use strict';

const { buildEncryptedBody } = require('./toEncryptBody');
const { _internals: commonInternal } = require('./zuhaowang_api');

function buildPriceTemplateEncryptedPayload(payload = {}, auth = {}) {
    const bizParams = payload.biz_params && typeof payload.biz_params === 'object'
        ? payload.biz_params
        : {};
    return buildEncryptedBody(bizParams, {
        public_key: auth.rsa_public_key
    });
}

function priceTemplateToken(cfg = {}, payload = {}, options = {}) {
    return String(
        options.token
        || payload.token
        || cfg.token_yuanbao
        || cfg.token_post
        || cfg.token_get
        || ''
    ).trim();
}

async function requestPriceTemplateEndpoint(path, payload = {}, auth = {}, options = {}) {
    const cfg = commonInternal.resolveAuth(auth);
    const url = String(options.url || `https://api-game.duodian.cn${path}`).trim();
    const body = buildPriceTemplateEncryptedPayload(payload, cfg);
    if (!body.ak || !body.data) throw new Error('zuhaowang 价格模板请求缺少 ak/data');
    const token = priceTemplateToken(cfg, payload, options);
    if (!token) throw new Error('zuhaowang 价格模板请求缺少 token');
    const request = options.request || commonInternal.curlRequest;
    const res = await request(url, 'POST', body, token, cfg);
    if (!res || String(res.code) !== '0') {
        const error = new Error(res ? String(res.desc || 'API Error') : 'API Error');
        error.code = String(res && res.code || '');
        error.zuhaowang_response = res || null;
        throw error;
    }
    return res;
}

async function getPriceTemplate(dataId, auth = {}, options = {}) {
    const id = String(dataId || '').trim();
    if (!id) throw new Error('getPriceTemplate 缺少 dataId');
    const res = await requestPriceTemplateEndpoint(
        '/api/ybzs/accountManage/getPriceTemplate',
        { biz_params: { dataId: id } },
        auth,
        options
    );
    return res.data && typeof res.data === 'object' ? res.data : {};
}

async function changePriceTemplate(bizParams = {}, auth = {}, options = {}) {
    if (!bizParams || typeof bizParams !== 'object' || Array.isArray(bizParams)) {
        throw new Error('changePriceTemplate 业务参数不合法');
    }
    if (!String(bizParams.dataId || '').trim()) throw new Error('changePriceTemplate 缺少 dataId');
    return requestPriceTemplateEndpoint(
        '/api/ybzs/accountManage/changePriceTemplate',
        { biz_params: bizParams },
        auth,
        options
    );
}

module.exports = {
    getPriceTemplate,
    changePriceTemplate,
    _internals: {
        buildPriceTemplateEncryptedPayload,
        requestPriceTemplateEndpoint,
        priceTemplateToken
    }
};
