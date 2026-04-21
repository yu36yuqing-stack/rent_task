#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-platform-channel-toggle-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');
process.env.ORDER_DB_FILE_PATH = path.join(tempDir, 'rent_robot_order.db');
process.env.STATS_DB_FILE_PATH = path.join(tempDir, 'rent_robot_stats.db');
process.env.PRICE_DB_FILE_PATH = path.join(tempDir, 'rent_robot_price.db');

const { createUserByAdmin } = require('../database/user_db');
const { upsertUserPlatformAuth, listUserPlatformAuth, setPlatformChannelEnabled } = require('../database/user_platform_auth_db');
const { upsertUserGameAccount, getLatestUserGameAccountByUserAndAccount } = require('../database/user_game_account_db');
const { upsertBlacklistSource, listBlacklistSourcesByUser } = require('../database/user_blacklist_source_db');
const { listUserBlacklistByUserWithMeta } = require('../database/user_blacklist_db');
const { upsertGuardTask, listGuardTasksByUser, TASK_STATUS_PENDING } = require('../database/prod_guard_task_db');
const { upsertOpenProductSyncAnomaly, listOpenProductSyncAnomaliesByUser } = require('../database/product_sync_anomaly_db');
const { listPlatformRestrictByUserAndAccounts, upsertPlatformRestrict } = require('../database/user_platform_restrict_db');
const { togglePlatformChannelByUser } = require('../user/platform_channel_service');
const { syncUserAccountsByAuth } = require('../product/product');
const { syncOrdersByUser } = require('../order/order');

function assertTrue(cond, msg) {
    if (!cond) throw new Error(msg);
}

function assertEqual(actual, expected, msg) {
    if (actual !== expected) throw new Error(`${msg} | actual=${actual} expected=${expected}`);
}

async function main() {
    const user = await createUserByAdmin({
        account: 'channel_toggle_user',
        password: '123456',
        name: 'Channel Toggle User',
        user_type: '外部',
        status: 'enabled',
        desc: 'platform channel toggle smoke'
    });
    const uid = Number(user.id);

    await upsertUserPlatformAuth({
        user_id: uid,
        platform: 'uhaozu',
        auth_type: 'cookie',
        auth_payload: { cookie: 'foo=bar' },
        auth_status: 'valid',
        desc: 'seed uhaozu auth'
    });
    await upsertUserPlatformAuth({
        user_id: uid,
        platform: 'uuzuhao',
        auth_type: 'token',
        auth_payload: { app_key: 'app_key_demo', app_secret: 'app_secret_demo' },
        auth_status: 'valid',
        desc: 'seed uuzuhao auth'
    });

    await upsertUserGameAccount({
        user_id: uid,
        game_account: '2780393927',
        game_id: '2',
        game_name: '和平精英',
        account_remark: '秋枫知我',
        channel_status: {
            uhaozu: '审核失败',
            uuzuhao: '上架'
        },
        channel_prd_info: {
            uhaozu: {
                prd_id: '1132578375',
                reason: '账号人脸识别',
                audit_reason: '账号人脸识别'
            },
            uuzuhao: {
                prd_id: '202604081001638427',
                reason: '商家下架'
            }
        },
        desc: 'seed account row'
    });

    await upsertBlacklistSource(uid, {
        game_account: '2780393927',
        game_id: '2',
        game_name: '和平精英'
    }, 'platform_face_verify', {
        active: 1,
        reason: '人脸识别',
        priority: 800,
        detail: {
            platforms: ['uhaozu'],
            reasons: [{ platform: 'uhaozu', reason: '账号人脸识别' }]
        },
        expire_at: '2099-01-01 00:00:00'
    }, { desc: 'seed face verify source' });

    await upsertPlatformRestrict(uid, {
        game_account: '2780393927',
        game_id: '2',
        game_name: '和平精英'
    }, 'uhaozu', { from: 'seed' }, 'seed restrict');

    await upsertOpenProductSyncAnomaly(uid, 'uhaozu', {
        expected_count: 1,
        pulled_count: 0,
        missing_count: 1,
        missing_accounts: [{ game_account: '2780393927', game_id: '2', game_name: '和平精英' }],
        sample_missing_text: '和平精英/2780393927',
        desc: 'seed anomaly'
    });

    await upsertGuardTask({
        user_id: uid,
        game_account: '2780393927',
        game_id: '2',
        game_name: '和平精英',
        risk_type: 'online_non_renting',
        task_type: 'sheep_fix',
        status: TASK_STATUS_PENDING,
        next_check_at: Math.floor(Date.now() / 1000)
    }, { desc: 'seed guard task' });

    const out = await togglePlatformChannelByUser(uid, 'uhaozu', false);
    assertTrue(out && out.row && out.row.channel_enabled === false, '停用后 channel_enabled 应为 false');
    assertTrue(Number(out.cleanup.source_touched || 0) >= 1, '应处理该渠道来源');
    assertEqual(Number(out.cleanup.restrict_removed || 0), 1, '应清理平台限制');
    assertEqual(Number(out.cleanup.anomaly_resolved || 0), 1, '应关闭该平台 anomaly');
    assertEqual(Number(out.cleanup.guard_tasks_finished || 0), 0, '停用 U号租不应清理悠悠 guard task');

    const authRows = await listUserPlatformAuth(uid, { with_payload: false });
    const uhaozuAuth = authRows.find((row) => String(row.platform || '') === 'uhaozu');
    assertTrue(uhaozuAuth && uhaozuAuth.channel_enabled === false, '授权行应持久化停用状态');

    const accountRow = await getLatestUserGameAccountByUserAndAccount(uid, '2780393927', '2', '和平精英');
    const channelStatus = accountRow && accountRow.channel_status && typeof accountRow.channel_status === 'object'
        ? accountRow.channel_status
        : {};
    const channelPrdInfo = accountRow && accountRow.channel_prd_info && typeof accountRow.channel_prd_info === 'object'
        ? accountRow.channel_prd_info
        : {};
    assertTrue(!('uhaozu' in channelStatus), '当前商品快照应移除 uhaozu channel_status');
    assertTrue(!('uhaozu' in channelPrdInfo), '当前商品快照应移除 uhaozu channel_prd_info');
    assertTrue('uuzuhao' in channelStatus, '其他渠道状态不应受影响');

    const sourceRows = await listBlacklistSourcesByUser(uid, { active_only: false });
    const faceVerify = sourceRows.find((row) => String(row.source || '') === 'platform_face_verify');
    assertTrue(faceVerify && faceVerify.active === false, '平台人脸来源应失效');

    const blacklistRows = await listUserBlacklistByUserWithMeta(uid);
    assertEqual(blacklistRows.length, 0, '仅剩该渠道自动来源时，黑名单应释放');

    const restrictRows = await listPlatformRestrictByUserAndAccounts(uid, [{
        game_account: '2780393927',
        game_id: '2',
        game_name: '和平精英'
    }]);
    assertEqual(restrictRows.length, 0, '该渠道平台限制应被移除');

    const anomalyRows = await listOpenProductSyncAnomaliesByUser(uid);
    assertEqual(anomalyRows.length, 0, '该渠道 open anomaly 应被关闭');

    const guardRows = await listGuardTasksByUser(uid);
    assertEqual(guardRows.list.length, 1, '悠悠 guard task 不应受 uhaozu 停用影响');
    assertEqual(String(guardRows.list[0].status || ''), TASK_STATUS_PENDING, '悠悠 guard task 状态应保持 pending');

    await setPlatformChannelEnabled(uid, 'uuzuhao', false, 'disable uuzuhao for skipped sync assert');
    const productSync = await syncUserAccountsByAuth(uid);
    assertTrue(productSync.ok && productSync.skipped, '全部渠道停用后商品同步应 skipped');
    assertEqual(String(productSync.reason || ''), 'no_enabled_platform_auth', '全部渠道停用后应返回 no_enabled_platform_auth');

    const orderSync = await syncOrdersByUser(uid);
    assertTrue(orderSync.ok, '订单同步不应因停用渠道报错');
    assertEqual(Boolean(orderSync.platforms.uhaozu && orderSync.platforms.uhaozu.skipped), true, '订单同步应跳过停用渠道');
    assertEqual(Boolean(orderSync.platforms.uuzuhao && orderSync.platforms.uuzuhao.skipped), true, '停用后订单同步也应跳过 uuzuhao');

    console.log(`[PASS] platform_channel_toggle_smoke_test temp_dir=${tempDir}`);
}

main().catch((err) => {
    console.error(`[FAIL] platform_channel_toggle_smoke_test: ${err.message}`);
    process.exit(1);
});
