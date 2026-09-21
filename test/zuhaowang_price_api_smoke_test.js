#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
    getPriceTemplate,
    changePriceTemplate,
    _internals
} = require('../zuhaowang/zuhaowang_price_api');

const auth = {
    token_yuanbao: 'fixture-token',
    device_id: 'fixture-device',
    package_name: 'com.duodian.merchant',
    rsa_public_key: ''
};

async function main() {
    const calls = [];
    const request = async (url, method, body, token, cfg) => {
        calls.push({ url, method, body, token, cfg });
        return { code: '0', desc: 'ok', data: { accountInfo: { dataId: '90779045' } } };
    };
    const template = await getPriceTemplate('90779045', auth, { request });
    assert.strictEqual(template.accountInfo.dataId, '90779045');
    assert(calls[0].url.endsWith('/api/ybzs/accountManage/getPriceTemplate'));
    assert.strictEqual(calls[0].method, 'POST');
    assert.strictEqual(calls[0].token, 'fixture-token');
    assert(calls[0].body.ak && calls[0].body.data);

    const changed = await changePriceTemplate({
        dataId: '90779045',
        priceTemplateType: '1',
        selfTemplate: { shortRent: null, longRent: { isOpen: true, grades: [] } }
    }, auth, { request });
    assert.strictEqual(changed.code, '0');
    assert(calls[1].url.endsWith('/api/ybzs/accountManage/changePriceTemplate'));
    const encrypted = _internals.buildPriceTemplateEncryptedPayload({}, {});
    assert(encrypted.ak && encrypted.data);
    await assert.rejects(() => getPriceTemplate('', auth, { request }), /dataId/);
    await assert.rejects(() => changePriceTemplate({}, auth, { request }), /dataId/);
    await assert.rejects(() => getPriceTemplate('1', auth, {
        request: async () => ({ code: '500', desc: '模板不存在' })
    }), /模板不存在/);
    assert.strictEqual(_internals.priceTemplateToken(auth, {}, {}), 'fixture-token');

    console.log('[OK] zuhaowang_price_api_smoke_test passed');
}

main().catch((error) => {
    console.error('[FAIL] zuhaowang_price_api_smoke_test failed:', error);
    process.exit(1);
});
