#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'order-detail-retention-'));
process.env.ORDER_DB_FILE_PATH = path.join(tempDir, 'order.db');

const { openOrderDatabase } = require('../database/sqlite_client');
const {
    initOrderDetailDb,
    upsertOrderDetail,
    getOrderDetailByOrder,
    pruneOrderDetailHtml
} = require('../database/order_detail_db');

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
}

function daysAgo(days) {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

(async () => {
    await initOrderDetailDb();
    await upsertOrderDetail({
        user_id: 8,
        channel: 'uhaozu',
        order_no: 'old_order',
        detail_html: '<html>old raw response</html>',
        detail_snapshot: { net_rent_amount: 12.34 },
        net_rent_amount: 12.34,
        detail_query_time: daysAgo(40)
    });
    await upsertOrderDetail({
        user_id: 8,
        channel: 'uhaozu',
        order_no: 'new_order',
        detail_html: '<html>new raw response</html>',
        detail_snapshot: { net_rent_amount: 56.78 },
        net_rent_amount: 56.78,
        detail_query_time: daysAgo(2)
    });
    await upsertOrderDetail({
        user_id: 8,
        channel: 'uhaozu',
        order_no: 'new_order',
        detail_status: '已完成',
        detail_html: '<html>new raw response updated</html>',
        detail_snapshot: { net_rent_amount: 56.79 },
        actual_rent_amount: 'not-a-number',
        net_rent_amount: 56.79,
        detail_query_time: daysAgo(1)
    });

    await assert.rejects(() => upsertOrderDetail({ channel: 'uhaozu', order_no: 'bad' }), /user_id/);
    await assert.rejects(() => upsertOrderDetail({ user_id: 8, order_no: 'bad' }), /channel/);
    await assert.rejects(() => upsertOrderDetail({ user_id: 8, channel: 'uhaozu' }), /order_no/);

    const db = openOrderDatabase();
    try {
        await run(db, `UPDATE order_detail SET modify_date = ?, create_date = ? WHERE order_no = 'old_order'`, [daysAgo(40), daysAgo(40)]);
    } finally {
        db.close();
    }

    const result = await pruneOrderDetailHtml({ retain_days: 30 });
    assert.strictEqual(result.cleared_rows, 1);
    assert(result.estimated_deleted_bytes > 0);

    const oldDetail = await getOrderDetailByOrder(8, 'uhaozu', 'old_order');
    const newDetail = await getOrderDetailByOrder(8, 'uhaozu', 'new_order');
    assert(oldDetail, '旧订单详情记录必须保留');
    assert.strictEqual(oldDetail.detail_html, '');
    assert.strictEqual(oldDetail.net_rent_amount, 12.34);
    assert.strictEqual(oldDetail.detail_snapshot.net_rent_amount, 12.34);
    assert.strictEqual(newDetail.detail_html, '<html>new raw response updated</html>');
    assert.strictEqual(newDetail.net_rent_amount, 56.79);

    const second = await pruneOrderDetailHtml({ retain_days: 30 });
    assert.strictEqual(second.cleared_rows, 0);
    assert.strictEqual(second.estimated_deleted_bytes, 0);

    console.log(`[PASS] order_detail_retention_smoke_test temp_dir=${tempDir}`);
})().catch((err) => {
    console.error(`[FAIL] order_detail_retention_smoke_test: ${err.stack || err.message}`);
    process.exit(1);
});
