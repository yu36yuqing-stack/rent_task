'use strict';

const { listDeviceCards } = require('../database/rental_device_db');
const { listDeviceActivityOrders } = require('../database/rental_device_order_db');
const { resolvePriceLadderCountWindow } = require('../common/price_ladder_count_mode');

async function listDevicesWithActivity(uid, mode = 'rolling_24h', now = new Date()) {
    const devices = await listDeviceCards(uid);
    if (!devices.length) return [];
    const { query_start: start, query_end: end } = resolvePriceLadderCountWindow(
        mode === 'natural_day' ? 'business_day' : mode, now);
    const orders = await listDeviceActivityOrders(uid, start, end);
    const byDevice = new Map();
    for (const order of orders) {
        const key = 'device:' + order.device_id;
        const facts = byDevice.get(key) || { count: 0, endsAt: '' };
        if (order.start_time >= start && order.start_time < end) facts.count++;
        // Future renewals extend the active session only when there is no gap.
        if (order.source_status === 3000 && order.end_time > end && order.end_time > facts.endsAt
            && (order.start_time <= end || (order.order_type === '续租' && order.start_time <= facts.endsAt))) {
            facts.endsAt = order.end_time;
        }
        byDevice.set(key, facts);
    }
    return devices.map(device => {
        const facts = byDevice.get(device.game_account);
        return { ...device, today_order_count: facts?.count || 0,
            renting_order_end_time: device.status === 5 && facts?.endsAt
                ? facts.endsAt.replace(' ', 'T') + '+08:00' : '' };
    });
}

module.exports = { listDevicesWithActivity };
