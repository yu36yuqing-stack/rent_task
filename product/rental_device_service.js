'use strict';
const { listRentalDevices } = require('../uuzuhao/uuzuhao_api');
const { getSystemConfig } = require('../database/system_config_db');
const { replaceDeviceSnapshot, listDeviceCards } = require('../database/rental_device_db');
const { upsertPurchaseCostRecord, createAccountCostRecord, softDeleteAccountCostRecordById,
    listAccountCostRecordsByUserAndAccount } = require('../database/account_cost_record_db');

async function refreshDevices(uid, auth) {
    const devices = await listRentalDevices(auth);
    await replaceDeviceSnapshot(uid, devices);
    return { ok: true, count: devices.length };
}

async function syncEnabledDevices(uid, auth) {
    try {
        const { value } = await getSystemConfig('uuzuhao.rental_device_sync');
        if (!Array.isArray(value?.user_ids) || !value.user_ids.includes(uid)) return { skipped: true };
        return await refreshDevices(uid, auth);
    } catch (e) {
        // Channel errors may echo a request payload. Keep credentials out of task history.
        const code = String(e.code || '').slice(0, 48);
        console.warn('[RentalDeviceSync] uid=%s failed code=%s', uid, code || 'invalid_response');
        return { ok: false, code: code || 'device_sync_failed' };
    }
}

async function requireDevice(uid, identity, includeInactive = false) {
    if (!/^device:[1-9]\d*$/.test(identity)) throw Object.assign(new Error('主机标识无效'), { code: 'INVALID_DEVICE' });
    const [card] = await listDeviceCards(uid, identity, { includeInactive });
    if (!card) throw Object.assign(new Error('找不到主机'), { code: 'DEVICE_NOT_FOUND' });
    return card;
}

async function deviceCosts(uid, identity) {
    const card = await requireDevice(uid, identity, true);
    return { ...card, read_only: Boolean(card.inactive), display_name: card.role_name, purchase_cost_amount: card.purchase_price || 0,
        list: await listAccountCostRecordsByUserAndAccount(uid, 'GTA6', identity) };
}

async function writeDeviceCost(uid, payload, action) {
    const { game_account: identity } = payload;
    await requireDevice(uid, identity);
    const input = { ...payload, game_account: identity, user_id: uid, game_id: 'GTA6', game_name: 'GTA6' };
    let record;
    if (action === 'delete') record = await softDeleteAccountCostRecordById(uid, payload.record_id, input);
    else if (action === 'purchase') {
        record = await upsertPurchaseCostRecord({ ...input, cost_amount: payload.purchase_price, cost_date: payload.purchase_date,
            cost_desc: payload.purchase_desc });
    } else if (action === 'create' && ['maintenance','other'].includes(payload.cost_type)) record = await createAccountCostRecord(input);
    else throw Object.assign(new Error('不支持的主机成本操作'), { code: 'INVALID_DEVICE_COST' });
    const account = await requireDevice(uid, identity);
    return { account, total_cost_amount: account.total_cost_amount, record };
}

module.exports = { refreshDevices, syncEnabledDevices, deviceCosts, writeDeviceCost, listDeviceCards };
