#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-product-order-service-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');

const { upsertOrder } = require('../database/order_db');
const { initUserGameAccountDb, listUserGameAccounts } = require('../database/user_game_account_db');
const { ensureLinkedGameAccountsByOrders } = require('../product/product');

function fail(msg) {
    console.error(`[FAIL] ${msg}`);
    process.exit(1);
}

function pass(msg) {
    console.log(`[PASS] ${msg}`);
}

function assertEqual(actual, expected, msg) {
    if (actual !== expected) {
        fail(`${msg} | expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
    }
    pass(msg);
}

function assertTrue(cond, msg) {
    if (!cond) fail(msg);
    pass(msg);
}

async function main() {
    await initUserGameAccountDb();

    await upsertOrder({
        user_id: 401,
        channel: 'uuzuhao',
        order_no: 'PROD_LINK_1',
        game_id: '3',
        game_name: 'CFM',
        game_account: 'prod_link_acc',
        role_name: 'LinkedRole',
        order_status: '已完成',
        order_amount: 30,
        rent_hour: 3,
        rec_amount: 15,
        start_time: '2026-04-10 09:00:00',
        end_time: '2026-04-10 12:00:00',
        create_date: '2026-04-10 08:50:00',
        desc: 'product order service regression'
    });

    const ret = await ensureLinkedGameAccountsByOrders(401);
    assertEqual(Number(ret.mirrored || 0), 1, '商品模块可通过订单服务补齐账号');
    assertEqual(Number(ret.skipped || 0), 0, '未命中跳过分支');

    const rows = await listUserGameAccounts(401, 1, 20);
    assertEqual(Number(rows.total || 0), 1, '补齐后账号表中存在记录');
    const account = (rows.list || [])[0] || {};
    assertEqual(String(account.game_account || ''), 'prod_link_acc', '补齐账号保留订单账号');
    assertEqual(String(account.game_name || ''), 'CFM', '补齐账号保留订单游戏名');
    assertEqual(String(account.account_remark || ''), 'LinkedRole', '补齐账号使用订单角色名作为备注');
    assertTrue(typeof account.channel_status === 'object', '补齐账号保留 JSON 字段结构');

    console.log(`[ProductOrderServiceRegressionSmoke] ok temp_dir=${tempDir}`);
}

main().catch((err) => {
    console.error(`[ProductOrderServiceRegressionSmoke] failed: ${err.message}`);
    process.exit(1);
});
