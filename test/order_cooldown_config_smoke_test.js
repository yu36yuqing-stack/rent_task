#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-cooldown-config-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');

const { initOrderDb, upsertOrder } = require('../database/order_db');
const { initUserRuleDb, upsertUserRuleByName } = require('../database/user_rule_db');
const { initUserGameAccountDb, upsertUserGameAccount } = require('../database/user_game_account_db');
const { initUserBlacklistDb } = require('../database/user_blacklist_db');
const { initUserBlacklistSourceDb, listBlacklistSourcesByUser } = require('../database/user_blacklist_source_db');
const {
    reconcileOrderCooldownEntryByUser
} = require('../order/order_cooldown');
const {
    COOLDOWN_RELEASE_RULE_NAME
} = require('../order/order_cooldown_config');

function assertEqual(actual, expected, msg) {
    if (actual !== expected) {
        throw new Error(`${msg}: expected=${expected}, actual=${actual}`);
    }
}

function assertTrue(cond, msg) {
    if (!cond) throw new Error(msg);
}

function formatDateTime(sec) {
    const d = new Date(Number(sec || 0) * 1000);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

async function seedActiveOrder(userId, orderNo, gameAccount, nowSec, endOffsetSec) {
    const endSec = nowSec + endOffsetSec;
    await upsertOrder({
        user_id: userId,
        channel: 'uuzuhao',
        order_no: orderNo,
        game_id: '1',
        game_name: 'WZRY',
        game_account: gameAccount,
        role_name: `role_${gameAccount}`,
        order_status: '租赁中',
        order_amount: 12,
        rent_hour: 1,
        ren_way: '时租',
        rec_amount: 10,
        start_time: formatDateTime(nowSec - 1800),
        end_time: formatDateTime(endSec),
        create_date: formatDateTime(nowSec - 1800),
        desc: 'cooldown config smoke'
    });
    return endSec;
}

async function main() {
    const nowSec = Math.floor(Date.now() / 1000);

    await initOrderDb();
    await initUserRuleDb();
    await initUserGameAccountDb();
    await initUserBlacklistDb();
    await initUserBlacklistSourceDb();

    const defaultUserId = 101;
    const defaultEndSec = await seedActiveOrder(defaultUserId, 'ORDER_DEFAULT', 'acct_default', nowSec, 20);
    const defaultRet = await reconcileOrderCooldownEntryByUser(defaultUserId);
    assertEqual(defaultRet.hit_accounts, 1, '默认配置应命中 1 个账号');
    assertEqual(defaultRet.release_delay_min, 10, '默认释放时长应为 10 分钟');

    const defaultRows = await listBlacklistSourcesByUser(defaultUserId);
    assertEqual(defaultRows.length, 1, '默认配置应写入 1 条冷却 source');
    assertEqual(Number((defaultRows[0].detail || {}).cooldown_until), defaultEndSec + 10 * 60, '默认配置 cooldown_until 应为结束后 10 分钟');

    const customUserId = 102;
    await upsertUserRuleByName(customUserId, {
        rule_name: COOLDOWN_RELEASE_RULE_NAME,
        rule_detail: {
            release_delay_min: 30
        }
    }, {
        desc: 'cooldown config smoke'
    });
    const customEndSec = await seedActiveOrder(customUserId, 'ORDER_CUSTOM', 'acct_custom', nowSec, 20);
    const customRet = await reconcileOrderCooldownEntryByUser(customUserId);
    assertEqual(customRet.hit_accounts, 1, '自定义配置应命中 1 个账号');
    assertEqual(customRet.release_delay_min, 30, '自定义释放时长应为 30 分钟');

    const customRows = await listBlacklistSourcesByUser(customUserId);
    assertEqual(customRows.length, 1, '自定义配置应写入 1 条冷却 source');
    assertEqual(Number((customRows[0].detail || {}).cooldown_until), customEndSec + 30 * 60, '自定义 cooldown_until 应为结束后 30 分钟');
    assertTrue(String(customRows[0].reason || '') === '冷却期下架', 'reason 应为冷却期下架');

    const accountUserId = 103;
    await upsertUserRuleByName(accountUserId, {
        rule_name: COOLDOWN_RELEASE_RULE_NAME,
        rule_detail: {
            release_delay_min: 20
        }
    }, {
        desc: 'cooldown account config smoke'
    });
    await upsertUserGameAccount({
        user_id: accountUserId,
        game_account: 'acct_account',
        game_id: '1',
        game_name: 'WZRY',
        account_remark: 'account cooldown',
        switch: {
            order_cooldown: {
                release_delay_min: 10
            }
        },
        desc: 'cooldown account config smoke'
    });
    const accountEndSec = await seedActiveOrder(accountUserId, 'ORDER_ACCOUNT', 'acct_account', nowSec, 20);
    const accountRet = await reconcileOrderCooldownEntryByUser(accountUserId);
    assertEqual(accountRet.hit_accounts, 1, '账号级配置应命中 1 个账号');
    assertEqual(accountRet.release_delay_min, 10, '账号级释放时长应优先于全局');

    const accountRows = await listBlacklistSourcesByUser(accountUserId);
    assertEqual(accountRows.length, 1, '账号级配置应写入 1 条冷却 source');
    assertEqual(Number((accountRows[0].detail || {}).cooldown_until), accountEndSec + 10 * 60, '账号级 cooldown_until 应为结束后 10 分钟');
    assertEqual(Number((accountRows[0].detail || {}).release_delay_min), 10, 'source detail 应记录账号级 release_delay_min');
    assertEqual(String((accountRows[0].detail || {}).release_delay_source || ''), 'account', 'source detail 应记录账号级来源');

    const earlyUserId = 104;
    await seedActiveOrder(earlyUserId, 'ORDER_EARLY', 'acct_early', nowSec, 120);
    const earlyRet = await reconcileOrderCooldownEntryByUser(earlyUserId);
    assertEqual(earlyRet.hit_accounts, 0, '距离结束超过 30 秒时不应提前进入冷却期');

    const missedUserId = 105;
    const missedEndSec = await seedActiveOrder(missedUserId, 'ORDER_MISSED', 'acct_missed', nowSec, -120);
    const missedRet = await reconcileOrderCooldownEntryByUser(missedUserId);
    assertEqual(missedRet.hit_accounts, 1, '订单结束后但未到释放时间时应补建冷却期');

    const missedRows = await listBlacklistSourcesByUser(missedUserId);
    assertEqual(missedRows.length, 1, '补建冷却期应写入 1 条 source');
    assertEqual(Number((missedRows[0].detail || {}).cooldown_until), missedEndSec + 10 * 60, '补建冷却期不应按当前执行时间顺延');

    const expiredUserId = 106;
    await seedActiveOrder(expiredUserId, 'ORDER_EXPIRED', 'acct_expired', nowSec, -700);
    const expiredRet = await reconcileOrderCooldownEntryByUser(expiredUserId);
    assertEqual(expiredRet.hit_accounts, 0, '超过释放时间的历史订单不应补建冷却期');

    console.log('[PASS] order_cooldown_config_smoke_test');
}

main().catch((err) => {
    console.error(`[FAIL] order_cooldown_config_smoke_test: ${err.message}`);
    process.exit(1);
});
