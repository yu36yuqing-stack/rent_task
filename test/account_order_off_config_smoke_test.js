#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-account-order-off-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');
process.env.ORDER_DB_FILE_PATH = path.join(tempDir, 'rent_robot_order.db');
process.env.STATS_DB_FILE_PATH = path.join(tempDir, 'rent_robot_stats.db');
process.env.PRICE_DB_FILE_PATH = path.join(tempDir, 'rent_robot_price.db');

const { createUserByAdmin } = require('../database/user_db');
const {
    upsertUserGameAccount,
    getLatestUserGameAccountByUserAndAccount,
    updateUserGameAccountSwitchByUserAndAccount
} = require('../database/user_game_account_db');

function assertTrue(cond, msg) {
    if (!cond) throw new Error(msg);
}

function assertEqual(actual, expected, msg) {
    if (actual !== expected) throw new Error(`${msg} | actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
}

async function main() {
    const user = await createUserByAdmin({
        account: 'account_order_off_user',
        password: '123456',
        name: 'Account Order Off User',
        user_type: '外部',
        status: 'enabled',
        desc: 'account order off smoke'
    });
    const uid = Number(user.id);
    await upsertUserGameAccount({
        user_id: uid,
        game_account: '2147515620',
        game_id: '1',
        game_name: 'WZRY',
        account_remark: '吴小张',
        switch: {
            prod_guard: {
                label: '在线风控',
                enabled: false
            }
        },
        desc: 'seed account row'
    });

    const savedSwitch = await updateUserGameAccountSwitchByUserAndAccount(uid, '2147515620', {
        order_n_off: {
            threshold: 2,
            mode: 'rolling_24h'
        }
    }, 'save account order off', '1', 'WZRY');
    assertEqual(Number(savedSwitch.order_n_off && savedSwitch.order_n_off.threshold || 0), 2, '账号级阈值应写入');
    assertEqual(String(savedSwitch.order_n_off && savedSwitch.order_n_off.mode || ''), 'rolling_24h', '账号级模式应写入');
    assertEqual(Boolean(savedSwitch.prod_guard && savedSwitch.prod_guard.enabled), false, '其他 switch 字段应保留');

    const stored = await getLatestUserGameAccountByUserAndAccount(uid, '2147515620', '1', 'WZRY');
    assertEqual(Number(stored.switch && stored.switch.order_n_off && stored.switch.order_n_off.threshold || 0), 2, '数据库里应持久化账号级阈值');

    const clearedSwitch = await updateUserGameAccountSwitchByUserAndAccount(uid, '2147515620', {
        order_n_off: null
    }, 'clear account order off', '1', 'WZRY');
    assertTrue(!clearedSwitch.order_n_off, '跟随全局时应移除账号级 order_n_off');
    assertEqual(Boolean(clearedSwitch.prod_guard && clearedSwitch.prod_guard.enabled), false, '移除账号级配置不应影响其他 switch');

    const cleared = await getLatestUserGameAccountByUserAndAccount(uid, '2147515620', '1', 'WZRY');
    assertTrue(!cleared.switch.order_n_off, '数据库里应移除账号级 order_n_off');

    console.log(`[PASS] account_order_off_config_smoke_test temp_dir=${tempDir}`);
}

main().catch((err) => {
    console.error(`[FAIL] account_order_off_config_smoke_test: ${err.message}`);
    process.exit(1);
});
