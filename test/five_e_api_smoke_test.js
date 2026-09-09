#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
    FiveEApiError,
    listRentAccounts,
    listAllRentAccounts,
    listRentOrders,
    listAllRentOrders,
    updateRentAccountShelf,
    unshelfRentAccount,
    shelfRentAccount
} = require('../5e_platfrom/5e_api');

async function main() {
    let captured = null;
    const fetchOk = async (url, options) => {
        captured = { url, options };
        return {
            ok: true,
            status: 200,
            async text() {
                return JSON.stringify({
                    status: true,
                    code: 0,
                    data: {
                        total: '1',
                        list: [{
                            id: 8086,
                            accountNo: 'CS5819323392',
                            channelDivide: 30,
                            steam64Id: '76561199407966750',
                            steamAccount: 'steam_user',
                            steamEmail: 'mail@example.com',
                            value: '21347',
                            rentStatus: 0,
                            shelfStatus: 1,
                            expireTime: '1786460028',
                            createdAt: '2026-07-23 19:39:09',
                            remark: 'test account',
                            rentFinishCount: 4,
                            rentFinishAmount: '7.8',
                            mafileExpireTime: '0',
                            loginType: 3,
                            useCoupon: 0
                        }]
                    },
                    traceId: 'trace-test',
                    success: true,
                    errcode: 0
                });
            }
        };
    };

    const out = await listRentAccounts(
        { page: 2, size: 25 },
        { token: 'Bearer token-for-test' },
        { fetch_impl: fetchOk }
    );
    assert.ok(captured.url.endsWith('/rentinterface/http/v1/rent/merchant/account/list'));
    assert.strictEqual(captured.options.headers.authorization, 'Bearer token-for-test');
    assert.deepStrictEqual(JSON.parse(captured.options.body), { page: 2, size: 25 });
    assert.strictEqual(out.total, 1);
    assert.strictEqual(out.list[0].account_id, 'CS5819323392');
    assert.strictEqual(out.list[0].shelf_status, 'on_shelf');
    assert.strictEqual(out.list[0].rent_status, 'idle');
    assert.strictEqual(out.list[0].steam_id, '76561199407966750');
    assert.strictEqual(out.list[0].channel_divide, 30);
    assert.strictEqual(out.list[0].finished_order_count, 4);
    assert.strictEqual(out.list[0].income_amount, '7.8');

    const requestedPages = [];
    const fetchPaged = async (_url, options) => {
        const body = JSON.parse(options.body);
        requestedPages.push(body.page);
        const offset = (body.page - 1) * body.size;
        const list = Array.from({ length: Math.max(0, Math.min(body.size, 3 - offset)) }, (_, index) => ({
            id: 9000 + offset + index,
            accountNo: `CS${offset + index}`,
            steamAccount: `steam_${offset + index}`,
            steam64Id: `7656119${offset + index}`,
            rentStatus: 0,
            shelfStatus: 1
        }));
        return {
            ok: true,
            status: 200,
            async text() {
                return JSON.stringify({ status: true, code: 0, data: { total: '3', list }, success: true });
            }
        };
    };
    const all = await listAllRentAccounts(
        { token: 'page-token' },
        { page_size: 2, fetch_impl: fetchPaged }
    );
    assert.deepStrictEqual(requestedPages, [1, 2]);
    assert.strictEqual(all.list.length, 3);
    assert.strictEqual(all.pages, 2);

    let capturedOrder = null;
    const fetchOrders = async (url, options) => {
        capturedOrder = { url, options };
        return {
            ok: true,
            status: 200,
            async text() {
                return JSON.stringify({
                    status: true,
                    code: 0,
                    data: {
                        totalSize: 1,
                        nextPageToken: '1',
                        realTotalIncome: '',
                        freezeTotalAmount: '',
                        totalChannelRevenue: '1.5',
                        isGetTotalChannelRevenue: true,
                        items: [{
                            orderNo: '120260811464220001',
                            orderChildNo: '120260811464220002',
                            paySuccessTime: '1786452828',
                            accountNo: 'CS5819323392',
                            totalTimeLength: '7200',
                            buyTimeType: 1,
                            buyCount: 2,
                            buyUnitPrice: '2.5',
                            rentCount: 1,
                            orderAmount: '5',
                            discountAmount: '0',
                            realAmount: '5',
                            channelDivide: 30,
                            channelRevenue: '1.5',
                            orderStatus: 2,
                            isRefund: 0,
                            refundReason: '',
                            isOperate: 0,
                            rentExpireTime: '1786460028',
                            orderCreateTime: '1786452822',
                            cashStatus: 1,
                            isAccountOwner: true
                        }]
                    },
                    timestamp: 1787059700,
                    traceId: 'order-trace-test',
                    success: true
                });
            }
        };
    };
    const orders = await listRentOrders(
        {
            page: 1,
            page_size: 25,
            account_no: 'CS5819323392',
            pay_start_at: 1786982400,
            pay_end_at: 1787155200
        },
        { token: 'order-token' },
        { fetch_impl: fetchOrders }
    );
    assert.ok(capturedOrder.url.endsWith('/rentinterface/http/v1/rent/merchant/order/list'));
    assert.deepStrictEqual(JSON.parse(capturedOrder.options.body), {
        page: 1,
        pageSize: 25,
        accountNo: 'CS5819323392',
        payStartAt: 1786982400,
        payEndAt: 1787155200
    });
    assert.strictEqual(orders.total, 1);
    assert.strictEqual(orders.total_channel_revenue, '1.5');
    assert.strictEqual(orders.list[0].order_id, '120260811464220002');
    assert.strictEqual(orders.list[0].duration_seconds, 7200);
    assert.strictEqual(orders.list[0].duration_hours, 2);
    assert.strictEqual(orders.list[0].original_amount, '5');
    assert.strictEqual(orders.list[0].paid_amount, '5');
    assert.strictEqual(orders.list[0].income_amount, '1.5');
    assert.strictEqual(orders.list[0].order_status, 2);
    assert.strictEqual(orders.list[0].cash_status, 1);
    assert.strictEqual(orders.list[0].is_refund, false);

    const orderPages = [];
    const orderPageBodies = [];
    const fetchOrderPages = async (_url, options) => {
        const body = JSON.parse(options.body);
        orderPages.push(body.page);
        orderPageBodies.push(body);
        const start = (body.page - 1) * body.pageSize;
        const items = Array.from({ length: Math.max(0, Math.min(body.pageSize, 3 - start)) }, (_, index) => ({
            orderNo: 'PARENT-1',
            orderChildNo: `CHILD-${start + index + 1}`,
            accountNo: 'CS5819323392',
            realAmount: '5',
            channelRevenue: '1.5',
            orderStatus: 2,
            rentExpireTime: '1786460028',
            orderCreateTime: '1786452822'
        }));
        return {
            ok: true,
            status: 200,
            async text() {
                return JSON.stringify({
                    status: true,
                    code: 0,
                    data: { totalSize: 3, items },
                    success: true
                });
            }
        };
    };
    const allOrders = await listAllRentOrders(
        {
            account_no: 'CS5819323392',
            page_size: 2,
            pay_start_at: 1786982400,
            pay_end_at: 1787155200
        },
        { token: 'order-page-token' },
        { fetch_impl: fetchOrderPages }
    );
    assert.deepStrictEqual(orderPages, [1, 2]);
    assert.ok(orderPageBodies.every((body) => body.payStartAt === 1786982400 && body.payEndAt === 1787155200));
    assert.strictEqual(allOrders.list.length, 3);
    assert.strictEqual(allOrders.pages, 2);
    assert.strictEqual(allOrders.list[2].order_id, 'CHILD-3');

    await assert.rejects(
        () => listRentOrders(
            { account_no: 'CS5819323392', pay_start_at: 1786982400 },
            { token: 'order-token' }
        ),
        /must be configured together/
    );
    await assert.rejects(
        () => listRentOrders(
            { account_no: 'CS5819323392', pay_start_at: 1787155200, pay_end_at: 1786982400 },
            { token: 'order-token' }
        ),
        /must be greater than/
    );

    const shelfRequests = [];
    const fetchShelfUpdate = async (url, options) => {
        shelfRequests.push({ url, options });
        return {
            ok: true,
            status: 200,
            async text() {
                return JSON.stringify({
                    status: true,
                    code: 0,
                    message: '',
                    data: {},
                    timestamp: 1787061909,
                    traceId: 'shelf-trace-test',
                    success: true,
                    errcode: 0
                });
            }
        };
    };
    const offShelf = await unshelfRentAccount(
        { account_no: 'CS5819323392', steam_id: '76561199407966750' },
        { token: 'shelf-token' },
        { fetch_impl: fetchShelfUpdate }
    );
    const onShelf = await shelfRentAccount(
        { accountNo: 'CS5819323392', steam64Id: '76561199407966750' },
        { token: 'shelf-token' },
        { fetch_impl: fetchShelfUpdate }
    );
    assert.strictEqual(shelfRequests.length, 2);
    assert.ok(shelfRequests.every((request) => request.url.endsWith('/rentinterface/http/v1/rent/merchant/account/shelf/update')));
    assert.ok(shelfRequests.every((request) => request.options.headers.authorization === 'Bearer shelf-token'));
    assert.deepStrictEqual(JSON.parse(shelfRequests[0].options.body), {
        accountNo: 'CS5819323392',
        shelfStatus: 0,
        steam64Id: '76561199407966750'
    });
    assert.deepStrictEqual(JSON.parse(shelfRequests[1].options.body), {
        accountNo: 'CS5819323392',
        shelfStatus: 1,
        steam64Id: '76561199407966750'
    });
    assert.strictEqual(offShelf.ok, true);
    assert.strictEqual(offShelf.shelf_status, 0);
    assert.strictEqual(offShelf.trace_id, 'shelf-trace-test');
    assert.strictEqual(onShelf.ok, true);
    assert.strictEqual(onShelf.shelf_status, 1);

    await assert.rejects(
        () => updateRentAccountShelf({ steam_id: '76561199407966750', shelf_status: 0 }, { token: 'shelf-token' }),
        /accountNo not configured/
    );
    await assert.rejects(
        () => updateRentAccountShelf({ account_no: 'CS5819323392', shelf_status: 0 }, { token: 'shelf-token' }),
        /steam64Id not configured/
    );
    await assert.rejects(
        () => updateRentAccountShelf({ account_no: 'CS5819323392', steam_id: '76561199407966750', shelf_status: 2 }, { token: 'shelf-token' }),
        /only supports 0\(off shelf\) or 1\(on shelf\)/
    );

    const fetchUnauthorized = async () => ({
        ok: false,
        status: 401,
        async text() {
            return JSON.stringify({ status: false, code: 401, message: 'token expired' });
        }
    });
    await assert.rejects(
        () => listRentAccounts({}, { token: 'expired-token' }, { fetch_impl: fetchUnauthorized }),
        (error) => error instanceof FiveEApiError
            && error.http_status === 401
            && error.code === '401'
            && error.message.includes('token expired')
    );

    console.log('[PASS] five_e_api_smoke_test');
}

main().catch((error) => {
    console.error(`[FAIL] five_e_api_smoke_test: ${error.message}`);
    process.exit(1);
});
