'use strict';

const { listGta6DeviceOrders } = require('../uuzuhao/uuzuhao_api');
const { getSystemConfig } = require('../database/system_config_db');
const { listUserPlatformAuth } = require('../database/user_platform_auth_db');
const { upsertRentalDeviceOrders } = require('../database/rental_device_order_db');

const STATUS = { 3000: '租赁中', 4000: '已完成', 4200: '已取消', 9900: '已取消' };

function parseCents(value) {
    if (value == null || value === '') return null;
    const text = String(value);
    const [whole, fraction = ''] = text.split('.');
    const cents = Number(whole) * 100 + Number(fraction.padEnd(2,'0'));
    if (!/^\d+(?:\.\d{1,2})?$/.test(text) || !Number.isSafeInteger(cents)) throw new Error('主机订单金额无效');
    return cents;
}

function timeText(ms) {
    if (!/^\d{13}$/.test(String(ms))) return '';
    const d = new Date(Number(ms));
    const p = x => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function mapDeviceOrder(raw) {
    const status = Number(raw.orderStatus);
    const end = timeText(raw.rentEndTime);
    const refund = parseCents(raw.returnAmount);
    const settlement = parseCents(raw.settlementAmount);
    const receivable = parseCents(raw.receivableAmount);
    const auditable = settlement !== null && (receivable === null || settlement + (refund ?? 0) === receivable);
    const booked = status === 4000 && end && auditable ? settlement : 0;
    const statusText = (status === 4200 || status === 9900) && refund > 0 && settlement === 0
        ? '已退款' : STATUS[status] || '未知状态';
    const device = String(raw.deviceId ?? '').trim();
    const hours = Number(raw.rentHour || 0);
    return {
        order_no: raw.purchaseOrderNo.trim(),
        device_id: /^[1-9]\d*$/.test(device) ? device : '',
        device_no: String(raw.deviceNo || '').trim(), device_name: String(raw.deviceName || '').trim(),
        source_status: Number.isSafeInteger(status) ? status : -1, order_status: statusText,
        order_type: ({ 1: '首租', 2: '续租' })[Number(raw.orderType)] || '',
        placed_at: timeText(raw.createTime), start_time: timeText(raw.rentStartTime), end_time: end,
        rent_hour: Number.isFinite(hours) && hours > 0 ? hours : 0,
        receivable_cent: receivable, settlement_cent: settlement, refund_cent: refund, booked_cent: booked
    };
}

async function importRentalDeviceOrders(uid, auth) {
    const orders = (await listGta6DeviceOrders(auth)).map(mapDeviceOrder);
    const changed = await upsertRentalDeviceOrders(uid, orders);
    const review = orders.filter(o => !STATUS[o.source_status] ||
        (o.source_status === 4000 && (!o.end_time || o.settlement_cent == null || (o.settlement_cent > 0 && o.booked_cent === 0))) ||
        ([4200,9900].includes(o.source_status) && o.settlement_cent > 0)).length;
    return { count: orders.length, changed, review };
}

async function syncConfiguredRentalDeviceOrders(uid) {
    let phase = 'config';
    try {
        const { value } = await getSystemConfig('uuzuhao.rental_device_order_sync');
        if (!Array.isArray(value?.user_ids) || !value.user_ids.includes(uid)) return { ok: true, skipped: true, reason: 'disabled' };
        const rows = await listUserPlatformAuth(uid, { with_payload: true });
        const usable = rows.find(r => r.platform === 'uuzuhao' && r.channel_enabled !== false
            && r.auth_status === 'valid' && (!r.expire_at || Date.parse(r.expire_at) > Date.now()));
        if (!usable) return { ok: false, reason: 'missing_auth' };
        phase = 'import';
        const imported = await importRentalDeviceOrders(uid, usable.auth_payload);
        phase = 'statistics';
        const { refreshRentalDeviceStats } = require('../stats/order_stats');
        return { ok: true, ...imported, statistics: await refreshRentalDeviceStats(uid) };
    } catch (err) {
        if (phase === 'config' && err.code === 'SQLITE_ERROR' && /no such table: system_config\b/.test(err.message)) {
            return { ok: true, skipped: true, reason: 'disabled' };
        }
        const code = /^[a-zA-Z0-9_]{1,48}$/.test(String(err.code || '')) ? err.code : 'DEVICE_ORDER_SYNC_FAILED';
        console.warn('[DeviceOrderSync] uid=%s phase=%s code=%s',uid,phase,code);
        return { ok: false, phase, code };
    }
}

module.exports = { importRentalDeviceOrders, syncConfiguredRentalDeviceOrders };
