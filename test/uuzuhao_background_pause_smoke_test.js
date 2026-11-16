#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-auth-pause-'));
for (const name of ['MAIN', 'ORDER', 'RUNTIME', 'STATS', 'PRICE']) {
    process.env[`${name}_DB_FILE_PATH`] = path.join(tempDir, `${name}.db`);
}
const { upsertUserGameAccount, getLatestUserGameAccountByUserAndAccount } = require('../database/user_game_account_db');
const { upsertUserPlatformAuth } = require('../database/user_platform_auth_db');
const { initOrderDb, upsertOrder } = require('../database/order_db');
const { getRuntimeTaskByTaskId, updateRuntimeTask } = require('../database/runtime_task_db');
const probes = require('../product/prod_probe_cache_service');
const tasks = require('../order/auth_revoke_task_service');
const api = require('../uuzuhao/uuzuhao_api');
const { deleteBlacklistWithGuard } = require('../blacklist/blacklist_release_guard');
const { manualRemoveBlacklistMode2 } = require('../blacklist/blacklist_manual_remove_v2');
const { upsertBlacklistSource, listBlacklistSourcesByUserAndAccounts } = require('../database/user_blacklist_source_db');
const { buildDingdingMessage } = require('../report/dingding/ding_style');
const { buildPlatformStatusNorm } = require('../product/prod_channel_status');
const { detectConflictsAndBuildSnapshot: buildActions } = require('../action_engine/action_engine');
const auth = { app_key: 'fixture', app_secret: 'fixture', api_base: 'https://fixture.invalid' };
const calls = [];
let fail = false;
let onRevoke = null;
const originalFetch = global.fetch;
global.fetch = async (url, options) => {
    assert.ok(String(url).startsWith(auth.api_base), 'all requests must be intercepted');
    const body = JSON.parse(options.body);
    calls.push({ url, body });
    if (String(url).endsWith('/revoke') && onRevoke) await onRevoke();
    const data = String(url).endsWith('/product/v1/list')
        ? { productPublishList: [{ accountNo: 'BAD', productId: 'p1', gameId: 1, offType: 'ACCOUNT_ERROR' }] }
        : { gameOnline: true, enabled: true };
    return { ok: true, status: 200, text: async () => JSON.stringify(fail
        ? { code: 500, msg: 'offType=ACCOUNT_ERROR' } : { code: 0, data }) };
};

async function account(acc = 'BAD', offType = 'ACCOUNT_ERROR', uid = 8, gid = '1') {
    await upsertUserGameAccount({ user_id: uid, game_account: acc, game_id: gid,
        game_name: gid === '3' ? 'CFM' : gid === '2' ? 'HPJY' : 'WZRY',
        channel_status: { uuzuhao: '下架' },
        channel_prd_info: { uuzuhao: { off_type: offType, reason: '' } } });
}
function finished(acc, no = acc, gid = '1') {
    return { channel: 'zuhaowang', order_no: no, order_status: '已完成',
        game_id: gid, game_account: acc, game_name: gid === '3' ? 'CFM' : 'WZRY' };
}
async function manual(acc = 'BAD') {
    return tasks.enqueueManualAuthRevokeTask(8, { game_account: acc, game_id: '1', game_name: 'WZRY' }, { start_worker: false });
}
async function main() {
    await initOrderDb();
    await upsertUserPlatformAuth({ user_id: 8, platform: 'uuzuhao', auth_type: 'token', auth_status: 'valid', auth_payload: auth });
    for (const type of ['ACCOUNT_ERROR', 'AUTHORIZE_ERROR', 'REAUTHORIZE_ERROR']) {
        await account('BAD', type);
        const before = calls.length;
        for (const operation of [
            () => probes.queryOnlineStatusCached(8, 'BAD', { auth }),
            () => probes.queryForbiddenStatusCached(8, 'BAD', { auth }),
            () => probes.setForbiddenPlayWithSnapshot(8, 'BAD', true, { auth }),
            () => probes.setForbiddenPlayWithSnapshot(8, 'BAD', false, { auth })
        ]) await assert.rejects(operation, { code: 'UUZUHAO_AUTHORIZATION_PAUSED' });
        assert.strictEqual(calls.length, before, 'background requests must be zero');
    }
    const key = { game_account: 'BAD', game_id: '1', game_name: 'WZRY' };
    await upsertBlacklistSource(8, key, 'guard_forbidden', { active: true, reason: '禁玩中', priority: 700 });
    const blocked = await deleteBlacklistWithGuard(8, key);
    assert.strictEqual(blocked.blocked_reason, '等待授权恢复');
    assert.strictEqual(blocked.guard_checked, false);
    assert.ok((await listBlacklistSourcesByUserAndAccounts(8, [key])).some((row) => row.source === 'guard_forbidden' && row.active));
    fail = true;
    const hand = { manual: true, force_refresh: true, auth };
    const beforeManual = calls.length;
    await assert.rejects(() => probes.queryOnlineStatusCached(8, 'BAD', hand), /ACCOUNT_ERROR/);
    await assert.rejects(() => probes.queryForbiddenStatusCached(8, 'BAD', hand), /ACCOUNT_ERROR/);
    await assert.rejects(() => probes.setForbiddenPlayWithSnapshot(8, 'BAD', false, hand), /ACCOUNT_ERROR/);
    assert.strictEqual(calls.length - beforeManual, 3);
    const manualRelease = await deleteBlacklistWithGuard(8, 'BAD', { manual: true });
    assert.strictEqual(manualRelease.blocked_reason, '状态查询失败');
    fail = false;
    const beforeRemove = calls.length;
    await manualRemoveBlacklistMode2(8, 'BAD');
    assert.strictEqual(calls.length, beforeRemove + 2, '手工移出黑名单照常查询在线和禁玩');
    await account('BAD', '', 9);
    await account('BAD', '', 8, '2');
    await probes.queryOnlineStatusCached(9, 'BAD', { auth });
    await probes.queryOnlineStatusCached(8, 'BAD', { game_id: '2', game_name: 'HPJY', auth });
    await probes.queryOnlineStatusCached(8, 'BAD', hand);
    await assert.rejects(() => probes.queryOnlineStatusCached(8, 'BAD', { auth }), { code: 'UUZUHAO_AUTHORIZATION_PAUSED' });

    const queued = await tasks.enqueueAuthRevokeTasks(8, [finished('BAD')]);
    let taskId = queued.task_ids[0];
    const beforePause = calls.length;
    const automatic = await tasks.processAuthRevokeTasks();
    assert.strictEqual(automatic.success, 1, '商品授权异常不应阻止腾讯退出租客登录');
    assert.strictEqual((await tasks.processAuthRevokeTasks()).claimed, 0, '成功任务不重复退出');
    let row = await getRuntimeTaskByTaskId(taskId);
    assert.strictEqual(row.stage, 'done');
    assert.strictEqual(JSON.parse(row.result_json).attempt_count, 1);
    assert.strictEqual(calls.length, beforePause + 1);
    assert.strictEqual((await tasks.getAuthRevokeTaskViewByUser(8, taskId)).status_text, '成功');
    const afterExit = await getLatestUserGameAccountByUserAndAccount(8, 'BAD', '1', 'WZRY');
    assert.strictEqual(afterExit.channel_prd_info.uuzuhao.off_type, 'REAUTHORIZE_ERROR',
        '腾讯退出成功不能清理悠悠平台的授权异常');
    await assert.rejects(() => probes.queryOnlineStatusCached(8, 'BAD', { auth }), { code: 'UUZUHAO_AUTHORIZATION_PAUSED' });

    await updateRuntimeTask(taskId, { finished_at: '2000-01-01 00:00:00' });
    fail = true;
    const nextManual = await manual();
    assert.notStrictEqual(nextManual.task.task_id, taskId, '成功复用窗口过后创建下一轮退出任务');
    taskId = nextManual.task.task_id;
    const attempted = await tasks.processAuthRevokeTasks();
    assert.strictEqual(attempted.failed, 1);
    assert.strictEqual(calls.length, beforePause + 2);
    const retry = await tasks.processAuthRevokeTasks();
    assert.strictEqual(retry.failed, 1, '退出失败仍沿用下一轮重试，不依赖商品授权恢复');
    assert.strictEqual(calls.length, beforePause + 3);
    assert.strictEqual(JSON.parse((await getRuntimeTaskByTaskId(taskId)).result_json).attempt_count, 2);

    // Click and a different channel's order attach while the same request is in flight.
    await manual();
    onRevoke = async () => {
        onRevoke = null;
        await manual();
        await tasks.enqueueAuthRevokeTasks(8, [finished('BAD', 'SECOND_ORDER')]);
        assert.strictEqual((await tasks.processAuthRevokeTasks()).claimed, 0,
            '接口在途时新的手工/订单触发只合并，不重复领取同一任务');
    };
    await tasks.processAuthRevokeTasks();
    row = await getRuntimeTaskByTaskId(taskId);
    const state = JSON.parse(row.result_json);
    assert.ok(state.triggers.some((trigger) => trigger.order_no === 'SECOND_ORDER'));
    assert.strictEqual(state.manual_consumed_count, row.attached_manual_count);
    assert.strictEqual(calls.length, beforePause + 4, '在途点击和订单触发没有增加本轮请求次数');

    fail = false;
    await upsertOrder({ user_id: 8, ...finished('BAD', 'NEW_RENT'), order_status: '租赁中' });
    await manual();
    const whileRenting = await tasks.processAuthRevokeTasks();
    assert.strictEqual(whileRenting.success, 1, '无需等其他在租订单结束、租客下线或冷却期');
    assert.strictEqual(calls.length, beforePause + 5);
    assert.strictEqual((await getRuntimeTaskByTaskId(taskId)).status, 'success');

    // Product pause does not apply to login revocation, including bounded batches and game 3.
    await account('PAUSED');
    const paused = await tasks.enqueueAuthRevokeTasks(8, [finished('PAUSED')]);
    await updateRuntimeTask(paused.task_ids[0], { started_at: '2000-01-01 00:00:00' });
    await tasks.enqueueAuthRevokeTasks(8, [finished('CFM', 'CFM', '3')]);
    const successes = [];
    for (let i = 0; i < 3; i++) successes.push((await tasks.processAuthRevokeTasks({ limit: 1 })).success);
    assert.ok(successes.includes(1), 'gameId=3 remains supported and is not starved');
    assert.ok(calls.some((call) => call.body.gameId === 3 && call.body.accountNo === 'CFM'));

    await account('BAD');
    assert.strictEqual(await api.youpinOffShelf(null, 'BAD', { auth, game_id: '1' }), true);
    assert.strictEqual(await api.youpinOnShelf(null, 'BAD', { auth, game_id: '1' }), true);
    await api.listOrders({ orderStatus: 3 }, { auth });
    await api.getOrderDetail({ orderNo: 'fixture' }, { auth });
    const info = { uuzuhao: { off_type: 'ACCOUNT_ERROR' } };
    const norm = buildPlatformStatusNorm({ uuzuhao: '下架' }, info);
    const plan = buildActions({ youpinData: [{ account: 'BAD', game_id: '1', status: '下架' }], uhaozuData: [], zhwData: [],
        platformStatusNormMap: { '1::BAD': norm }, blacklistAccounts: new Set() });
    assert.ok(plan.actions.some((action) => action.type === 'on_y'), 'authorization pause must not disable on-shelf scheduling');
    const payload = { ok: true, allNormal: true, accounts: [{ account: 'BAD', remark: 'Fixture', channel_prd_info: info }] };
    const notice = buildDingdingMessage(payload);
    assert.ok(notice.includes('请号主在悠悠重新授权'));
    assert.ok(!notice.includes('所有状态正常'));
    assert.ok(!buildDingdingMessage({ ...payload, accounts: [] }).includes('请号主'));
    const accountDb = require('../database/user_game_account_db');
    const originalLookup = accountDb.getLatestUserGameAccountByUserAndAccount;
    const servicePath = require.resolve('../product/prod_probe_cache_service');
    accountDb.getLatestUserGameAccountByUserAndAccount = async () => { throw new Error('SQLITE_BUSY fixture'); };
    delete require.cache[servicePath];
    try {
        const beforeReadError = calls.length;
        await assert.rejects(() => require(servicePath).queryOnlineStatusCached(8, 'BAD', { auth }), /SQLITE_BUSY/);
        assert.strictEqual(calls.length, beforeReadError, '查库失败不能默认放行后台请求');
    } finally {
        accountDb.getLatestUserGameAccountByUserAndAccount = originalLookup;
        delete require.cache[servicePath];
    }
    console.log('[PASS] uuzuhao_background_pause_smoke_test');
}
main().catch((error) => { console.error(error); process.exitCode = 1; }).finally(() => { global.fetch = originalFetch; });
