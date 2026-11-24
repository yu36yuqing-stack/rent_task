'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'device-activity-'));
for (const name of ['MAIN', 'STATS', 'ORDER', 'RUNTIME', 'PRICE']) {
    process.env[name + '_DB_FILE_PATH'] = path.join(temp, name + '.db');
}

const { initRentalDeviceDb, replaceDeviceSnapshot } = require('../database/rental_device_db');
const { initAccountCostRecordDb } = require('../database/account_cost_record_db');
const { initRentalDeviceOrderDb, upsertRentalDeviceOrders } = require('../database/rental_device_order_db');
const { listDevicesWithActivity } = require('../product/rental_device_activity');
const { buildDingdingMessage, buildDingdingDeviceAccount, buildDingdingAccountLine } = require('../report/dingding/ding_style');

const day = '2026-11-24 ';
function order(no, device, start, end, status = 3000, amount = 0, type = '首租') {
    return { order_no: no, device_id: device, device_no: '', device_name: '', start_time: start, end_time: end,
        source_status: status, order_status: '', order_type: type, booked_cent: amount, rent_hour: 1, placed_at: start,
        source_game_id: '', source_game_name: '', source_game_logo: '' };
}
async function main() {
    await Promise.all([initRentalDeviceDb(), initRentalDeviceOrderDb()]);
    await initAccountCostRecordDb();
    assert.deepEqual(await listDevicesWithActivity(77), []);
    const inventory = [5, 6, 4, 7, 3, 5].map((status, i) => ({ deviceId: String(i + 1), deviceNo: '编号' + i, status }));
    await replaceDeviceSnapshot(8, inventory);
    const rows = [
        order('boundary', '1', '2026-11-23 10:00:00', day + '01:00:00', 4000, 100),
        order('early', '1', day + '05:59:59', day + '07:00:00', 4000, 50),
        order('refunded', '1', day + '07:00:00', day + '08:00:00', 4200),
        order('live', '1', day + '09:00:00', day + '11:00:00'),
        order('extra', '1', day + '11:00:00', day + '12:00:00', 3000, 0, '续租'),
        order('gap', '1', day + '12:00:01', day + '14:00:00', 3000, 0, '续租'),
        order('booking', '1', day + '12:00:00', day + '16:00:00'),
        order('too-old', '1', '2026-11-23 09:59:59', day + '01:00:00', 4000, 100),
        order('at-end', '2', day + '10:00:00', day + '11:00:00'),
        order('unlinked', '', day + '08:00:00', day + '11:00:00'),
        order('future', '6', day + '11:00:00', day + '13:00:00', 3000, 0, '续租')
    ];
    await upsertRentalDeviceOrders(8, rows);
    await upsertRentalDeviceOrders(77, [rows[3]]);
    const now = day + '10:00:00';
    for (const [mode, count] of [['rolling_24h', 3], ['natural_day', 1]]) {
        const devices = await listDevicesWithActivity(8, mode, now);
        const one = devices.find(d => d.game_account === 'device:1');
        assert.deepEqual([one.today_order_count, one.renting_order_end_time], [count, '2026-11-24T12:00:00+08:00']);
        assert(devices.filter(d => d !== one).every(d => d.today_order_count === 0 && d.renting_order_end_time === ''));
        const accounts = devices.map(buildDingdingDeviceAccount);
        const expected = ['💰', '⬇️', '✅', '⚠️', '❔'];
        for (let i = 0; i < expected.length; i++) {
            assert(buildDingdingAccountLine(accounts.find(d => d.account === 'device:' + (i+1))).startsWith(expected[i]));
        }
        const games = ['3','2','1','4','99'].map(game_id => ({ game_id, account: 'A' + game_id, today_order_count: 1 }));
        const msg = buildDingdingMessage({ ok: true, accounts: [...games, ...accounts], master_total: 11 });
        assert(msg.includes('游戏账号 5 单，主机 ' + count + ' 单'));
        const headers = msg.split('\n').filter(line => /（\d+ (个|台)）$/.test(line));
        assert.deepEqual(headers, ['主机租赁（6 台）','CS2（1 个）','王者荣耀（1 个）','和平精英（1 个）','枪战王者（1 个）','其他游戏（1 个）']);
        const noHost = buildDingdingMessage({ ok: true, accounts: [games[2]] });
        assert(!/主机租赁|CS2|其他游戏/.test(noHost));
    }
    const unknown = buildDingdingDeviceAccount({ game_account: 'device:123', status: 100 });
    assert.equal(buildDingdingAccountLine(unknown), '❔[0单] 123 · 未知');
    await assert.rejects(listDevicesWithActivity(8, 'wrong', now), /不合法/);
    console.log('[PASS] 主机计数窗口、续租边界、隔离、状态和分组');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
