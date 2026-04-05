#!/usr/bin/env node
'use strict';

const { modifyUhaozuGoods, _internals } = require('../uhaozu/uhaozu_api');

function fail(msg) {
    console.error(`[FAIL] ${msg}`);
    process.exit(1);
}

function pass(msg) {
    console.log(`[PASS] ${msg}`);
}

function assertEqual(actual, expected, msg) {
    if (actual !== expected) fail(`${msg} | expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
    pass(msg);
}

function assertOk(cond, msg) {
    if (!cond) fail(msg);
    pass(msg);
}

async function main() {
    const sampleQueryObject = {
        goods: {
            goodsId: 1132393091,
            gameId: 'A2705',
            goodsTitle: 'old title',
            rentalByHour: 400,
            rentalByNight: 1520,
            rentalByDay: 2280,
            rentalByWeek: 15200,
            deposit: 300,
            minRentTime: 2,
            gameAccount: '2874231439',
            gamePassword: '***'
        },
        options: [{ optionId: 'OPT1', optionName: '英雄', propertyId: 'A2705YX', optionNum: 1 }],
        urls: ['//picture.example/a.png'],
        goodsDiscountOptions: [{ buy: 5, free: 1, checked: true }],
        rentDiscountOptions: [],
        authSource: 'LB',
        mode: 0,
        randStr: 'RAND',
        authVersion: 2
    };

    const normalized = _internals.normalizeModifyPayloadFromQuery(1132393091, sampleQueryObject);
    assertEqual(Number(normalized.goodsId || 0), 1132393091, 'normalize goodsId');
    assertEqual(String((normalized.info || {}).goodsTitle || ''), 'old title', 'normalize info from goods');

    const built = _internals.buildModifiedGoodsPayload(normalized, {
        info: {
            rentalByHour: '5',
            goodsTitle: 'new title'
        }
    });
    assertEqual(String((built.info || {}).rentalByHour || ''), '5', 'build payload overrides hour price');
    assertEqual(Number((built.info || {}).rentalByNight || 0), 23.75, 'build payload derives night price by fixed ratio');
    assertEqual(Number((built.info || {}).rentalByDay || 0), 33.25, 'build payload derives day price by fixed ratio');
    assertEqual(Number((built.info || {}).rentalByWeek || 0), 190, 'build payload derives week price by fixed ratio');
    assertEqual(String((built.info || {}).goodsTitle || ''), 'new title', 'build payload overrides title');
    assertEqual(Number(built.goodsId || 0), 1132393091, 'build payload keeps goodsId');

    const originalFetch = global.fetch;
    const captured = [];
    global.fetch = async (url, options = {}) => {
        captured.push({
            url: String(url || ''),
            options: {
                method: String(options.method || ''),
                headers: options.headers || {},
                body: options.body
            }
        });
        if (String(url).includes('/api/goods/modify/query/')) {
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({
                    success: true,
                    responseCode: '0000',
                    responseMsg: 'success',
                    object: sampleQueryObject
                })
            };
        }
        if (String(url).includes('/merchants/goods/modify/')) {
            return {
                ok: true,
                status: 200,
                text: async () => JSON.stringify({
                    success: true,
                    responseCode: '0000',
                    responseMsg: 'success',
                    object: { goodsId: 1132393091 }
                })
            };
        }
        throw new Error(`unexpected url: ${url}`);
    };

    try {
        const auth = {
            cookie: 'JSESSIONID=abc; uid=xyz',
            default_headers: {
                Referer: 'https://b.uhaozu.com/goods'
            }
        };

        const priceOut = await modifyUhaozuGoods(1132393091, {
            info: {
                rentalByHour: '6',
                rentalByNight: 18.8,
                deposit: 5
            }
        }, auth);
        assertEqual(Number(priceOut.goodsId || 0), 1132393091, 'price api returns goodsId');
        assertEqual(captured.length, 2, 'price api does query + modify');
        const priceReq = JSON.parse(String((captured[1] && captured[1].options && captured[1].options.body) || '{}'));
        assertEqual(String((((priceReq || {}).info || {}).rentalByHour || '')), '6', 'price api updates hourly price');
        assertEqual(Number((((priceReq || {}).info || {}).rentalByNight || 0)), 28.5, 'price api derives night price by fixed ratio');
        assertEqual(Number((((priceReq || {}).info || {}).rentalByDay || 0)), 39.9, 'price api derives day price by fixed ratio');
        assertEqual(Number((((priceReq || {}).info || {}).rentalByWeek || 0)), 228, 'price api derives week price by fixed ratio');
        assertEqual(Number((((priceReq || {}).info || {}).deposit || 0)), 5, 'price api updates deposit');
        assertEqual(String((((captured[1] || {}).options || {}).headers || {}).Referer || ''), 'https://b.uhaozu.com/release-goods?id=1132393091&gameId=A2705&from=%2Fgoods', 'price api uses modify referer');

        captured.length = 0;
        await modifyUhaozuGoods(1132393091, {
            info: {
                goodsTitle: 'patched title'
            },
            urls: ['//picture.example/b.png']
        }, auth);
        assertEqual(captured.length, 2, 'patch api does query + modify');
        const patchReq = JSON.parse(String((captured[1] && captured[1].options && captured[1].options.body) || '{}'));
        assertEqual(String((((patchReq || {}).info || {}).goodsTitle || '')), 'patched title', 'patch api updates info field');
        assertEqual(String(((patchReq || {}).urls || [])[0] || ''), '//picture.example/b.png', 'patch api replaces urls');
        assertOk(/\/merchants\/goods\/modify\/1132393091$/.test(String((captured[1] && captured[1].url) || '')), 'patch api hits modify endpoint');
    } finally {
        global.fetch = originalFetch;
    }

    console.log('uhaozu_modify_api_smoke_test passed');
}

main().catch((err) => {
    console.error(`[FAIL] ${err.message}`);
    process.exit(1);
});
