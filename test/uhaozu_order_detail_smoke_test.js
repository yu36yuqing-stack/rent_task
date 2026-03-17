#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-uhaozu-detail-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');

const { initOrderDb, upsertOrder, listOrders, updateOrderRecAmount } = require('../database/order_db');
const { initOrderDetailDb, upsertOrderDetail, getOrderDetailByOrder } = require('../database/order_detail_db');
const { parseUhaozuOrderDetailHtml } = require('../uhaozu/uhaozu_api');

function assertEqual(actual, expected, msg) {
    if (actual !== expected) {
        throw new Error(`${msg}: expected=${expected}, actual=${actual}`);
    }
}

function assertTrue(cond, msg) {
    if (!cond) throw new Error(msg);
}

const html = `
<div class="per-center-con">
  <div class="order-detail-title">
    <p><span class="order-status"><span class="gray">已完成</span></span></p>
  </div>
  <div class="order-detail-box">
    <div class="order-detail-con">
      <div class="detail-item"><label>订单编号：</label> <span>122377087088</span></div>
      <div class="detail-item"><label>创建时间：</label> <span>2026-03-17 14:43:41</span></div>
      <div class="detail-item"><label>完成时间：</label><span>03-17 15:50:32</span></div>
      <div class="detail-item"><label>实收租金：</label> <span><em class="orange">5.59</em>元</span></div>
      <div class="detail-item"><label>订单手续费：</label><span><em class="orange">-1.12</em>元</span></div>
      <div class="detail-item"><label>结余租金：</label><span><em class="orange">4.47</em>元</span></div>
    </div>
  </div>
  <div class="wq-item-r">
    <p><span>处理结果：</span><em class="black">经核实，买家已开始游戏，予以完单押金：退还买家3.0元；租金：支付卖家5.59元，退还买家4.41元。</em></p>
  </div>
</div>
`;

async function main() {
    const parsed = parseUhaozuOrderDetailHtml(html);
    assertEqual(parsed.detail_status, '已完成', 'detail status');
    assertEqual(parsed.actual_rent_amount, 5.59, 'actual rent');
    assertEqual(parsed.service_fee_amount, -1.12, 'service fee');
    assertEqual(parsed.net_rent_amount, 4.47, 'net rent');
    assertEqual(parsed.complete_time, '2026-03-17 15:50:32', 'complete time');
    assertTrue(parsed.complaint_result_text.includes('支付卖家5.59元'), 'complaint result text');

    await initOrderDb();
    await initOrderDetailDb();

    await upsertOrder({
        user_id: 8,
        channel: 'uhaozu',
        order_no: '122377087088',
        game_id: '2',
        game_name: '和平精英',
        game_account: 'acct_1',
        role_name: '鱼悦儿',
        order_status: '已完成',
        order_amount: 5.59,
        rent_hour: 2,
        ren_way: '时租',
        rec_amount: 5.59,
        start_time: '2026-03-17 14:43:41',
        end_time: '2026-03-17 16:48:41',
        create_date: '2026-03-17 14:43:41',
        desc: 'uhaozu detail smoke'
    });

    await upsertOrderDetail({
        user_id: 8,
        channel: 'uhaozu',
        order_no: '122377087088',
        order_detail_no: '122377087088',
        detail_status: parsed.detail_status,
        actual_rent_amount: parsed.actual_rent_amount,
        service_fee_amount: parsed.service_fee_amount,
        net_rent_amount: parsed.net_rent_amount,
        complete_time: parsed.complete_time,
        complaint_result_text: parsed.complaint_result_text,
        detail_html: html,
        detail_snapshot: parsed,
        detail_query_time: '2026-03-17 16:00:00',
        desc: 'uhaozu detail smoke'
    });

    await updateOrderRecAmount(8, 'uhaozu', '122377087088', parsed.net_rent_amount, 'rewrite by smoke');

    const detailRow = await getOrderDetailByOrder(8, 'uhaozu', '122377087088');
    assertTrue(Boolean(detailRow), 'detail row exists');
    assertEqual(Number(detailRow.net_rent_amount), 4.47, 'detail net amount saved');

    const orders = await listOrders(8, 1, 10);
    assertEqual(orders.total, 1, 'order total');
    assertEqual(Number(orders.list[0].rec_amount), 4.47, 'order rec_amount rewritten');

    console.log('[PASS] uhaozu_order_detail_smoke_test');
}

main().catch((err) => {
    console.error(`[FAIL] uhaozu_order_detail_smoke_test: ${err.message}`);
    process.exit(1);
});
