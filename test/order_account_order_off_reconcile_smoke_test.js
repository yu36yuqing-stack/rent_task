#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-order-account-off-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');
process.env.ORDER_DB_FILE_PATH = path.join(tempDir, 'rent_robot_order.db');
process.env.ORDER_COUNT_TRACE = 'false';

const { createUserByAdmin } = require('../database/user_db');
const { upsertUserRuleByName } = require('../database/user_rule_db');
const { upsertUserGameAccount } = require('../database/user_game_account_db');
const { upsertOrder } = require('../database/order_db');
const { listUserBlacklistByUserWithMeta } = require('../database/user_blacklist_db');
const { reconcileOrder3OffBlacklistByUser } = require('../order/order');

function assertTrue(cond, msg) {
    if (!cond) throw new Error(msg);
}

function assertEqual(actual, expected, msg) {
    if (actual !== expected) throw new Error(`${msg} | actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

function pad(n) {
    return String(n).padStart(2, '0');
}

function toDateTimeText(d) {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function addHours(base, offset) {
    return new Date(base.getTime() + offset * 3600 * 1000);
}

async function seedOrder(userId, row) {
    await upsertOrder({
        user_id: userId,
        channel: 'uuzuhao',
        game_id: '1',
        game_name: 'WZRY',
        role_name: 'RoleA',
        order_amount: 10,
        rent_hour: 2,
        ren_way: 'hour',
        rec_amount: 0,
        start_time: '2026-04-21 07:00:00',
        end_time: '2026-04-21 08:00:00',
        create_date: '2026-04-21 06:59:00',
        desc: 'account order off reconcile smoke',
        ...row
    });
}

async function main() {
    const user = await createUserByAdmin({
        account: 'order_account_off_user',
        password: '123456',
        name: 'Order Account Off User',
        user_type: '外部',
        status: 'enabled',
        desc: 'order account off smoke'
    });
    const uid = Number(user.id);

    await upsertUserRuleByName(uid, {
        rule_name: 'X单下架阈值',
        rule_detail: {
            threshold: 4,
            mode: 'natural_day'
        }
    }, { desc: 'seed global order off rule' });

    await upsertUserGameAccount({
        user_id: uid,
        game_account: 'acc_account_cfg',
        game_id: '1',
        game_name: 'WZRY',
        account_remark: '账号级覆盖',
        switch: {
            order_n_off: {
                threshold: 2,
                mode: 'rolling_24h'
            }
        },
        desc: 'seed account override'
    });
    await upsertUserGameAccount({
        user_id: uid,
        game_account: 'acc_global_cfg',
        game_id: '1',
        game_name: 'WZRY',
        account_remark: '全局兜底',
        desc: 'seed global fallback account'
    });

    const now = new Date();
    await seedOrder(uid, {
        order_no: 'ACC_CFG_1',
        game_account: 'acc_account_cfg',
        order_status: '已完成',
        rec_amount: 5,
        start_time: toDateTimeText(addHours(now, -3)),
        end_time: toDateTimeText(addHours(now, -2))
    });
    await seedOrder(uid, {
        order_no: 'ACC_CFG_2',
        game_account: 'acc_account_cfg',
        order_status: '租赁中',
        start_time: toDateTimeText(addHours(now, -1)),
        end_time: toDateTimeText(addHours(now, 1))
    });
    await seedOrder(uid, {
        order_no: 'GLOBAL_CFG_1',
        game_account: 'acc_global_cfg',
        order_status: '已完成',
        rec_amount: 6,
        start_time: toDateTimeText(addHours(now, -4)),
        end_time: toDateTimeText(addHours(now, -3))
    });
    await seedOrder(uid, {
        order_no: 'GLOBAL_CFG_2',
        game_account: 'acc_global_cfg',
        order_status: '已完成',
        rec_amount: 7,
        start_time: toDateTimeText(addHours(now, -2)),
        end_time: toDateTimeText(addHours(now, -1))
    });
    await seedOrder(uid, {
        order_no: 'GLOBAL_CFG_3',
        game_account: 'acc_global_cfg',
        order_status: '结算中',
        start_time: toDateTimeText(addHours(now, -1)),
        end_time: toDateTimeText(addHours(now, 2))
    });

    const out = await reconcileOrder3OffBlacklistByUser({ id: uid, switch: {} });
    assertEqual(Number(out.added || 0), 1, '仅账号级覆盖账号应命中新增黑名单');
    assertEqual(Number(out.hit_accounts || 0), 1, '命中账号数应为 1');
    const detail = Array.isArray(out.count_details)
        ? out.count_details.find((row) => String(row.game_account || '') === 'acc_account_cfg')
        : null;
    assertTrue(Boolean(detail), 'count_details 应包含账号级配置账号');
    assertEqual(Number(detail.threshold || 0), 2, '账号级配置应使用自身阈值');
    assertEqual(String(detail.mode || ''), 'rolling_24h', '账号级配置应使用自身模式');
    assertEqual(String(detail.config_source || ''), 'account', '账号级配置来源应为 account');

    const blacklistRows = await listUserBlacklistByUserWithMeta(uid);
    const hit = blacklistRows.find((row) => String(row.game_account || '') === 'acc_account_cfg');
    const miss = blacklistRows.find((row) => String(row.game_account || '') === 'acc_global_cfg');
    assertTrue(Boolean(hit), '账号级覆盖账号应进入黑名单');
    assertTrue(!miss, '仅达到 3 单的全局账号不应命中 4 单全局阈值');
    assertEqual(String(hit.reason || ''), '2单下架', '黑名单原因应按账号级阈值生成');

    console.log(`[PASS] order_account_order_off_reconcile_smoke_test temp_dir=${tempDir}`);
}

main().catch((err) => {
    console.error(`[FAIL] order_account_order_off_reconcile_smoke_test: ${err.message}`);
    process.exit(1);
});
