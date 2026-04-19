#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { _internals: youpinInternals } = require('../uuzuhao/uuzuhao_api');
const { _internals: productInternals } = require('../product/product');

function main() {
    const mappedAuth = youpinInternals.mapProductToRobotItem({
        _tabKey: 'OFF',
        productStatus: 2100,
        offType: 'AUTHORIZE_ERROR',
        accountNo: 'acc_auth',
        productId: 'p1'
    });
    assert.strictEqual(mappedAuth.status, '下架');
    assert.strictEqual(mappedAuth.reason, '授权失效');

    const mappedReauth = youpinInternals.mapProductToRobotItem({
        _tabKey: 'OFF',
        productStatus: 2100,
        offType: 'REAUTHORIZE_ERROR',
        accountNo: 'acc_reauth',
        productId: 'p2'
    });
    assert.strictEqual(mappedReauth.reason, '重新授权失败');

    const prdInfo = productInternals.buildPlatformPrdInfo('uuzuhao', {
        id: 'p3',
        reason: '授权失效',
        raw: {
            gameId: '1',
            roleName: '悠悠账号',
            offType: 'AUTHORIZE_ERROR',
            saleStatus: 1000,
            productStatus: 2100,
            _tabKey: 'OFF'
        }
    });
    assert.strictEqual(prdInfo.off_type, 'AUTHORIZE_ERROR');
    assert.strictEqual(prdInfo.reason, '授权失效');

    console.log('[PASS] uuzuhao_auth_abnormal_mapping_smoke_test');
}

main();
