#!/usr/bin/env node
'use strict';

const assert = require('assert');
const api = require('../uuzuhao/uuzuhao_api');
const { modifyProductPrice, _internals } = api;

const auth = {
    app_key: 'fixture-key',
    app_secret: 'fixture-secret',
    api_base: 'https://fixture.invalid'
};

async function main() {
    assert.deepStrictEqual(_internals.buildModifyPricePayload('product-1', {
        hourPrice: 2,
        minRentHour: 2
    }), {
        productId: 'product-1',
        hourPrice: 2,
        p2Price: 3.6,
        p3Price: 4.8,
        p5Price: 7,
        p7Price: 9.8,
        p9Price: 12.6,
        p10Price: 14,
        p24Price: 28.8,
        p168Price: 201.6,
        minRentHour: 2
    });
    assert.strictEqual(_internals.roundPrice(2.675), 2.68);
    assert.throws(() => _internals.buildModifyPricePayload('', { hourPrice: 2 }), /productId/);
    assert.throws(() => _internals.buildModifyPricePayload('p1', {}), /hourPrice/);
    assert.throws(() => _internals.buildModifyPricePayload('p1', { hourPrice: 0 }), /hourPrice/);
    assert.throws(() => _internals.buildModifyPricePayload('p1', { hourPrice: 2, minRentHour: 1.5 }), /minRentHour/);
    assert.strictEqual(_internals.createSign({ values: ['a', 'b'], meta: { b: 2 }, empty: '', nil: null }, 's').length, 32);
    await assert.rejects(() => _internals.postSigned('/fixture', {}, {}), /app_key/);
    await assert.rejects(() => _internals.postSigned('/fixture', {}, { app_key: 'k' }), /app_secret/);

    const originalFetch = global.fetch;
    const calls = [];
    global.fetch = async (url, options = {}) => {
        calls.push({ url: String(url || ''), options });
        return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ code: 0, msg: '成功', timestamp: 1775064833921 })
        };
    };
    try {
        const result = await modifyProductPrice('product-1', { hourPrice: 2, minRentHour: 2 }, { auth });
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].url, `${auth.api_base}/api/youpin/rent-connector/product/v1/modifyPrice`);
        assert.strictEqual(calls[0].options.method, 'POST');
        const body = JSON.parse(calls[0].options.body);
        assert.strictEqual(body.appKey, auth.app_key);
        assert(Number.isInteger(body.timestamp));
        assert.strictEqual(body.p2Price, 3.6);
        assert.strictEqual(body.p168Price, 201.6);
        assert.strictEqual(body.sign, _internals.createSign(body, auth.app_secret, { exclude_keys: ['p2Price'] }));
        assert.notStrictEqual(body.sign, _internals.createSign(body, auth.app_secret));
        assert.strictEqual(result.product_id, 'product-1');
        assert.strictEqual(result.package_prices.p24Price, 28.8);
        assert.strictEqual(result.raw.code, 0);
    } finally {
        global.fetch = originalFetch;
    }

    const failedFetch = global.fetch;
    global.fetch = async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 4001, msg: '价格不符合折扣限制' })
    });
    try {
        await assert.rejects(
            () => modifyProductPrice('product-1', { hourPrice: 2 }, { auth }),
            /code=4001, msg=价格不符合折扣限制/
        );
    } finally {
        global.fetch = failedFetch;
    }

    const originalFetchForRegression = global.fetch;
    const listPageCalls = new Map();
    global.fetch = async (url, options = {}) => {
        const requestUrl = String(url || '');
        const body = JSON.parse(String(options.body || '{}'));
        if (requestUrl.endsWith('/product/v1/list')) {
            if (Array.isArray(body.productIds)) {
                return response({ code: 0, data: { productPublishList: [
                    { productId: body.productIds[0], accountNo: 'A', productHourRentPrice: 2, minRentHour: 2 }
                ] } });
            }
            const tab = String(body.tabKey || '');
            const callNo = (listPageCalls.get(tab) || 0) + 1;
            listPageCalls.set(tab, callNo);
            if (tab === 'SALE' && callNo === 1) {
                return response({
                    code: 0,
                    data: {
                        productPublishList: [
                            { productId: 'dup', accountNo: 'A', productStatus: 1000, saleStatus: 1000, gameId: 1 },
                            { productId: 'sale', accountNo: 'B', productStatus: 1000, saleStatus: 1000, gameId: 2 }
                        ],
                        lastId: 'next'
                    }
                });
            }
            if (tab === 'RENT') {
                return response({ code: 0, data: { productPublishList: [
                    { productId: 'dup', accountNo: 'A', saleStatus: 2000, gameId: 1 }
                ] } });
            }
            if (tab === 'OFF') {
                return response({ code: 0, data: { productPublishList: [
                    { productId: 'off', accountNo: 'OFF', productStatus: 2300, offType: 'SELLER', gameId: 1 }
                ] } });
            }
            return response({ code: 0, data: { productPublishList: [] } });
        }
        if (requestUrl.endsWith('/product/v1/game/online')) {
            return response({ code: 0, data: { gameOnline: true } });
        }
        if (requestUrl.endsWith('/product/v1/forbidden/play')) {
            return response({ code: 0, data: { enabled: body.enabled === 'true' } });
        }
        if (requestUrl.endsWith('/product/v1/steamGuardCode')) {
            return response({ code: 0, data: { guardCode: '123456', secondsRemaining: 18 } });
        }
        if (requestUrl.endsWith('/product/v1/interconnect/auth/revoke')) {
            return response({ code: 0, data: {} });
        }
        if (requestUrl.endsWith('/order/v1/list')) {
            const rows = body.page === 1 ? [{ orderNo: '1' }, { orderNo: '2' }] : [{ orderNo: '3' }];
            return response({ code: 0, data: { orderList: rows, totalCount: 3 } });
        }
        if (requestUrl.endsWith('/order/v1/detail')) {
            return response({ code: 0, data: { purchaseOrderNo: body.purchaseOrderNo } });
        }
        if (requestUrl.endsWith('/product/v1/on') || requestUrl.endsWith('/product/v1/off')) {
            return response({ code: 0, data: {} });
        }
        throw new Error(`unexpected url: ${requestUrl}`);
    };
    try {
        const rows = await _internals.listProductsByTab('SALE', auth);
        assert.strictEqual(rows.length, 2);
        assert.strictEqual(listPageCalls.get('SALE'), 2);
        listPageCalls.clear();
        const all = await _internals.listAllProducts(auth);
        assert.strictEqual(all.length, 3);
        assert.strictEqual(all.find((item) => item.productId === 'dup').saleStatus, 2000);

        assert.strictEqual((await _internals.findProductByAccount('A', auth, { product_id: 'dup' })).productId, 'dup');
        assert.strictEqual((await api.queryProductByAccount('A', { auth, product_id: 'direct' })).productId, 'direct');
        assert.strictEqual(await api.queryProductByAccount('B', { auth, product_id: 'direct' }), null);
        assert.strictEqual(await _internals.findProductByAccount('missing', auth), null);
        const collected = await api.collectYoupinData(null, '', { auth });
        assert.strictEqual(collected.page, null);
        assert(collected.data.some((item) => item.account === 'OFF' && item.reason === '商家下架'));

        assert.strictEqual((await api.queryAccountOnlineStatus('A', 'WZRY', { auth })).online, true);
        assert.strictEqual((await api.queryForbiddenPlay('A', { auth })).type, 1);
        assert.strictEqual((await api.enableForbiddenPlay('A', { auth })).enabled, true);
        assert.strictEqual((await api.disableForbiddenPlay('A', { auth })).enabled, false);
        assert.strictEqual((await api.getSteamGuardCode('steam', { auth })).guard_code, '123456');
        assert.strictEqual((await api.revokeAccountAuth('A', { auth, game_id: 1 })).revoked, true);
        assert.strictEqual(await api.youpinOffShelf(null, 'A', { auth, product_id: 'dup' }), true);
        assert.strictEqual(await api.youpinOnShelf(null, 'missing', { auth }), false);

        const onePage = await api.listOrders({
            orderStatus: 3,
            page: 1,
            pageSize: 2,
            updateStartTime: 1,
            updateEndTime: 2,
            userId: 8
        }, { auth });
        assert.strictEqual(onePage.order_list.length, 2);
        const allOrders = await api.listAllOrders({ orderStatus: 3, pageSize: 2 }, { auth });
        assert.strictEqual(allOrders.order_list.length, 3);
        assert.strictEqual((await api.getOrderDetail({ orderNo: 'order-1' }, { auth })).detail.purchaseOrderNo, 'order-1');

        assert.throws(() => _internals.sanitizeOrderListParams({}), /orderStatus/);
        assert.throws(() => _internals.sanitizeOrderDetailParams({}), /purchaseOrderNo/);
        assert.throws(() => _internals.normalizeForbiddenEnabled('invalid'), /true\/false/);
        await assert.rejects(() => api.queryAccountOnlineStatus('', 'WZRY', { auth }), /accountId/);
        await assert.rejects(() => api.setForbiddenPlay('A', true, { auth, type: 3 }), /type/);
        await assert.rejects(() => api.getSteamGuardCode('A', { auth, game_id: 1 }), /CS2/);
        await assert.rejects(() => api.revokeAccountAuth('', { auth, game_id: 1 }), /accountNo/);
        await assert.rejects(() => api.revokeAccountAuth('A', { auth }), /game_id/);

        const statusFixtures = [
            [{ _tabKey: 'SALE' }, '上架', ''],
            [{ saleStatus: 2000 }, '租赁中', ''],
            [{ productStatus: 2100, offType: 'SELLER_BLACK' }, '下架', '系统下架'],
            [{ productStatus: 2200, offType: 'CUSTOMER' }, '下架', '客服下架'],
            [{ productStatus: 2300, offType: 'SELLER' }, '下架', '商家下架'],
            [{ productStatus: 2300, productOffReasonDesc: 'reason' }, '下架', '商家下架'],
            [{ productStatus: 2300, productOffDesc: 'desc' }, '下架', '商家下架'],
            [{ productStatus: 2300, offType: 'REAUTHORIZE_ERROR' }, '下架', '重新授权失败'],
            [{ productStatus: 2300, offType: 'AUTHORIZE_ERROR' }, '下架', '授权失效']
        ];
        for (const [fixture, status, reason] of statusFixtures) {
            const mapped = _internals.mapProductToRobotItem(fixture);
            assert.strictEqual(mapped.status, status);
            assert.strictEqual(mapped.reason, reason);
        }
        assert.deepStrictEqual(_internals.normalizeGameIdentity('', ''), { game_id: '', game_name: '' });
        assert.strictEqual(_internals.buildProductGameIdentity({ gameName: '和平精英' }).game_id, '2');
    } finally {
        global.fetch = originalFetchForRegression;
    }

    const originalFetchForErrors = global.fetch;
    global.fetch = async () => ({ ok: true, status: 200, text: async () => 'not-json' });
    await assert.rejects(() => _internals.postSigned('/fixture', {}, auth), /非JSON/);
    global.fetch = async () => response({ code: 500, msg: 'server error' }, false, 500);
    await assert.rejects(() => _internals.postSigned('/fixture', {}, auth), /HTTP 500/);
    global.fetch = originalFetchForErrors;

    console.log('[PASS] uuzuhao_modify_price_api_smoke_test');
}

function response(body, ok = true, status = 200) {
    return { ok, status, text: async () => JSON.stringify(body) };
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
