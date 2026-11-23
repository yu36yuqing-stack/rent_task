'use strict';

const { promisify } = require('node:util');
const { openOrderDatabase } = require('../../database/sqlite_client');
const { initOrderDb } = require('../../database/order_db');
const { initOrderDetailDb } = require('../../database/order_detail_db');
const { initOrderComplaintDb } = require('../../database/order_complaint_db');
const { initRentalDeviceOrderDb } = require('../../database/rental_device_order_db');

// Read the bounded order interval, including saved evidence of early returns.
// A detail from an earlier, nonterminal version of an order cannot confirm settlement.
async function readDashboardOrders(uid, game, start, end) {
    const accounts = game !== 'GTA6';
    const devices = game === '全部' || game === 'GTA6';
    if (accounts) {
        await initOrderDb();
        await initOrderDetailDb();
        await initOrderComplaintDb();
    }
    if (devices) await initRentalDeviceOrderDb();
    const db = openOrderDatabase();
    const all = promisify(db.all).bind(db);
    try {
        const rows = accounts ? await all(`SELECT o.game_name,o.game_account,o.channel,o.order_status,o.start_time,o.end_time,
            o.rent_hour,o.rec_amount,o.desc,o.ren_way,d.complete_time,
            CASE WHEN json_extract(d.detail_snapshot,'$.net_rent_confirmed')=1 THEN d.net_rent_amount END AS detail_net,
            c.rent_duration, json_extract(c.raw_payload,'$.settlementAmount') AS source_amount
            FROM "order" o
            LEFT JOIN order_detail d ON d.user_id=o.user_id AND d.channel=o.channel AND d.order_no=o.order_no AND d.is_deleted=0
            LEFT JOIN order_complaint c ON c.user_id=o.user_id AND c.channel=o.channel AND c.order_no=o.order_no
                AND c.is_deleted=0 AND json_valid(c.raw_payload)
                AND json_extract(c.raw_payload,'$.settlementStatus')=2
                AND ((o.order_status='已退款' AND json_extract(c.raw_payload,'$.orderStatus')=4200)
                    OR (o.order_status='已完成' AND json_extract(c.raw_payload,'$.orderStatus')=4000)
                    OR (o.order_status='投诉/撤单' AND json_extract(c.raw_payload,'$.orderStatus')=9900))
            WHERE o.user_id=? AND o.is_deleted=0 AND o.end_time>=? AND o.end_time<=?
            AND o.order_status IN ('已完成','部分完成','已退款','已撤单','投诉/撤单')
            ${game === '全部' ? '' : 'AND o.game_name=?'}`,
            game === '全部' ? [uid,start,end] : [uid,start,end,game]) : [];
        if (devices) {
            rows.push(...await all(`SELECT 'GTA6' AS game_name, 'device:'||coalesce(nullif(device_id,''),'unlinked') AS game_account,
                'device' AS channel, order_status,start_time,end_time,rent_hour,
                CASE WHEN settlement_cent>=0 AND (receivable_cent IS NULL OR settlement_cent+coalesce(refund_cent,0)=receivable_cent)
                    THEN settlement_cent/100.0 END AS source_amount
                FROM rental_device_order WHERE user_id=? AND is_deleted=0 AND source_status IN (4000,4200,9900)
                AND end_time>=? AND end_time<=?`, [uid,start,end]));
        }
        return rows;
    } finally {
        await promisify(db.close).call(db);
    }
}
module.exports = { readDashboardOrders };
