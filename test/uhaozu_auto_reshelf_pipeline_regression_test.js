'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-uhaozu-pipeline-regression-'));
for (const name of ['MAIN', 'RUNTIME', 'ORDER', 'STATS', 'PRICE']) {
    process.env[`${name}_DB_FILE_PATH`] = path.join(dir, `${name}.db`);
}
let externalRequests = 0;
global.fetch = async () => { externalRequests++; throw new Error('unexpected real network request'); };

const product = require('../product/product');
const guard = require('../product/prod_status_guard');
const orderRules = require('../order/service/order_rule_service');
const userDb = require('../user/user');
const engine = require('../action_engine/action_engine');
const report = require('../report/report_rent_status');
const sourceDb = require('../database/user_blacklist_source_db');
const policyModule = require('../product/uhaozu_auto_reshelf_policy');
const replacements = [];
function replace(object, key, value) {
    replacements.push([object, key, object[key]]);
    object[key] = value;
}

const policy = Object.freeze({ key: 'uhaozu.auto_reshelf_reasons', id: 15, version: 3,
    available: true, reasons: Object.freeze(['账号人脸识别']) });
const fixtureUser = { id: 8008, account: 'pipeline-fixture' };
const syncValue = { ok: true, platforms: ['uhaozu'], upserted: 4 };
const templateRows = [
    { game_account: 'shared', game_id: '1', game_name: 'WZRY', channel_status: { uuzuhao: '上架', uhaozu: '上架', zuhaowang: '上架' }, channel_prd_info: {} },
    { game_account: 'other', game_id: '1', game_name: 'WZRY', channel_status: { uuzuhao: '下架', uhaozu: '下架', zuhaowang: '下架' }, channel_prd_info: {} },
    { game_account: 'shared', game_id: '2', game_name: '和平精英', channel_status: { uuzuhao: '上架', uhaozu: '下架', zuhaowang: '上架' }, channel_prd_info: {} },
    { game_account: 'no-old-status', game_id: '1', game_name: 'WZRY', channel_status: null, channel_prd_info: {} },
    { game_account: '', game_id: '1', game_name: 'WZRY', channel_status: { uhaozu: '下架' }, channel_prd_info: {} }
];
const actions = [
    { type: 'off_y', item: { account: 'shared', game_id: '1' }, success: true },
    { type: 'off_u', item: { account: 'shared', game_id: '1' }, success: true },
    { type: 'off_z', item: { account: 'shared', game_id: '1' }, success: true },
    { type: 'on_y', item: { account: 'other', game_id: '1' }, success: true },
    { type: 'on_u', item: { account: 'other', game_id: '1' }, success: true },
    { type: 'on_z', item: { account: 'other', game_id: '1' }, success: true },
    { type: 'on_u_modify', item: { account: 'shared', game_id: '2' }, success: true },
    { type: 'on_u', item: { account: 'no-old-status' }, success: true },
    { type: '', item: { account: 'shared' } },
    { type: 'off_y', item: {} },
    { type: 'off_y', item: { account: 'absent-row' } },
    { type: 'noop', item: { account: 'other' } }
];
let syncFailure = null;
let listFailure = null;
let orderFailure = null;
let faceFailure = null;
let notifyFailure = null;
let syncCalls = 0;
let listCalls = 0;
let actionCalls = 0;
let notifications = 0;
let policyLoads = 0;
let finalPayload = null;
const warnings = [];
const errors = [];
const logger = { log() {}, warn(value) { warnings.push(String(value)); }, error(value) { errors.push(String(value)); } };

replace(product, 'syncUserAccountsByAuth', async uid => {
    assert.strictEqual(uid, fixtureUser.id);
    syncCalls++;
    if (syncFailure) throw syncFailure;
    return syncValue;
});
replace(product, 'listAllUserGameAccountsByUser', async uid => {
    assert.strictEqual(uid, fixtureUser.id);
    listCalls++;
    if (listFailure) throw listFailure;
    return structuredClone(templateRows);
});
replace(orderRules, 'reconcileOrderNOffByUser', async () => {
    if (orderFailure) throw orderFailure;
    return { ok: true };
});
replace(sourceDb, 'listBlacklistSourcesByUserAndAccounts', async () => {
    if (faceFailure) throw faceFailure;
    return [];
});
replace(userDb, 'loadUserBlacklistSet', async () => new Set());
replace(userDb, 'loadUserBlacklistReasonMap', async () => ({}));
replace(policyModule, 'loadUhaozuAutoReshelfPolicy', async () => { policyLoads++; return policy; });
replace(engine, 'executeUserActionsIfNeeded', async input => {
    actionCalls++;
    assert.strictEqual(input.uhaozuAutoReshelfPolicy, policy);
    return { actions: structuredClone(actions), errors: [], planned: 8, timing: { executed: 8 } };
});

function assertRefreshedStatus(accounts) {
    const byKey = new Map(accounts.map(row => [`${row.game_id}::${row.account}`, row]));
    const statuses = row => [row.youpin, row.uhaozu, row.zuhaowan];
    assert.deepStrictEqual(statuses(byKey.get('1::shared')), ['下架', '下架', '下架']);
    assert.deepStrictEqual(statuses(byKey.get('1::other')), ['上架', '上架', '上架']);
    assert.deepStrictEqual(statuses(byKey.get('2::shared')), ['上架', '上架', '上架'], '同账号的另一游戏只应用自身动作');
    assert.strictEqual(byKey.get('1::no-old-status').uhaozu, '上架', '缺失原状态时应建立成功动作的渠道状态');
    assert.strictEqual(byKey.get('1::').uhaozu, '下架', '无账号行不能误匹配其他动作');
}

replace(report, 'fillTodayOrderCounts', async (_uid, accounts) => {
    assertRefreshedStatus(accounts);
    for (const row of accounts) row.today_order_count = 2;
});
replace(report, 'fillRentingOrderFacts', async (_uid, accounts) => {
    assertRefreshedStatus(accounts);
    for (const row of accounts) row.active_order_present = false;
});
replace(guard, 'probeProdOnlineStatus', async (_user, accounts) => {
    assertRefreshedStatus(accounts);
    return { probe_rows: [{ account: '', online_tag: 'ON' }, { account: 'other', online_tag: 'OFF' }] };
});
replace(guard, 'triggerProdStatusGuard', (_user, accounts) => { assertRefreshedStatus(accounts); });
replace(report, 'buildRecentActionsForUser', async (_uid, options) => {
    assert.deepStrictEqual([...options.include_account_keys].sort(), ['1::no-old-status', '1::other', '1::shared', '2::shared']);
    return ['fixture recent action'];
});
replace(report, 'listUserSyncAnomaliesForReport', async () => []);
replace(report, 'buildPayloadForOneUser', (accounts, extra) => {
    assertRefreshedStatus(accounts);
    return { ok: true, accounts: structuredClone(accounts), extra };
});
replace(report, 'notifyUserByPayload', async (_user, payload) => {
    notifications++;
    finalPayload = payload;
    if (notifyFailure) throw notifyFailure;
    return { ok: true, channels: { fixture: { status: 'sent' } } };
});

delete require.cache[require.resolve('../pipeline/user_pipeline')];
const pipeline = require('../pipeline/user_pipeline');
const options = { logger, actionEnabled: true, readOnly: false };

async function main() {
    const good = await pipeline.runFullUserPipeline(fixtureUser, options);
    assert.strictEqual(good.ok, true);
    assert.strictEqual(good.accounts_count, templateRows.length);
    assert.strictEqual(good.sync, syncValue);
    assert.strictEqual(good.action_result.planned, 8);
    assert.strictEqual(good.action_result.actions.length, actions.length);
    assert.strictEqual(policyLoads, 1);
    assertRefreshedStatus(finalPayload.accounts);
    assert.strictEqual(finalPayload.accounts.find(x => x.account === 'other').online_tag, 'OFF');
    assert(finalPayload.accounts.every(x => x.today_order_count === 2 && x.active_order_present === false));
    assert.strictEqual(finalPayload.extra.master_total, templateRows.length);

    const callsBeforeInvalid = [syncCalls, listCalls, actionCalls, notifications, policyLoads];
    const invalidSync = await pipeline.runUserPipelineSyncAccounts(null, options);
    assert.strictEqual(invalidSync.ok, false);
    assert.strictEqual(invalidSync.stage, 'validate');
    assert.strictEqual(invalidSync.sync, null);
    assert.deepStrictEqual(invalidSync.errors, ['invalid_user']);
    const invalidFull = await pipeline.runFullUserPipeline({}, options);
    assert.strictEqual(invalidFull.stage, 'validate');
    const invalidAfter = await pipeline.runUserPipelineAfterSync({ id: 0 }, syncValue, options);
    assert.strictEqual(invalidAfter.stage, 'validate');
    assert.deepStrictEqual(invalidAfter.errors, ['invalid_user']);
    assert.deepStrictEqual([syncCalls, listCalls, actionCalls, notifications, policyLoads], callsBeforeInvalid,
        '无效用户不能进入同步、动作或通知阶段');

    syncFailure = new Error('fixture sync rejected');
    const afterBeforeSyncFailure = [listCalls, actionCalls, notifications];
    const rejected = await pipeline.runFullUserPipeline(fixtureUser, options);
    assert.strictEqual(rejected.ok, false);
    assert.strictEqual(rejected.stage, 'sync_accounts');
    assert.strictEqual(rejected.sync, null);
    assert.strictEqual(rejected.accounts_count, 0);
    assert.deepStrictEqual(rejected.errors, ['sync_failed: fixture sync rejected']);
    assert.deepStrictEqual([listCalls, actionCalls, notifications], afterBeforeSyncFailure,
        '商品同步失败不能继续执行上架或发送成功通知');
    assert(Number(rejected.pipeline_timing.sync_accounts_ms) >= 0);
    syncFailure = null;

    orderFailure = new Error('fixture order reconcile busy');
    faceFailure = new Error('fixture face source busy');
    const nonFatal = await pipeline.runUserPipelineAfterSync(fixtureUser, syncValue, options);
    assert.strictEqual(nonFatal.ok, true, '局部收敛失败应保留主流程结果并明确报告异常');
    assert.deepStrictEqual(nonFatal.non_fatal_errors, [
        'order3off_reconcile_failed:fixture order reconcile busy',
        'face_verify_reconcile_failed:fixture face source busy'
    ]);
    assert.strictEqual(nonFatal.action_result.planned, 8);
    assertRefreshedStatus(finalPayload.accounts);
    assert(warnings.some(x => x.includes('Order3Off') && x.includes('fixture order reconcile busy')));
    assert(warnings.some(x => x.includes('FaceVerifyBL') && x.includes('fixture face source busy')));
    orderFailure = null;
    faceFailure = null;

    listFailure = new Error('fixture account read failed');
    const callsBeforeReadFailure = [actionCalls, notifications];
    const readFailure = await pipeline.runUserPipelineAfterSync(fixtureUser, syncValue, options);
    assert.strictEqual(readFailure.ok, false);
    assert.strictEqual(readFailure.stage, 'pipeline');
    assert.strictEqual(readFailure.sync, syncValue);
    assert.strictEqual(readFailure.accounts_count, 0);
    assert.deepStrictEqual(readFailure.errors, ['sync_failed: fixture account read failed']);
    assert.deepStrictEqual([actionCalls, notifications], callsBeforeReadFailure);
    listFailure = null;

    notifyFailure = new Error('fixture notification transport rejected');
    const transportFailure = await pipeline.runUserPipelineAfterSync(fixtureUser, syncValue, options);
    assert.strictEqual(transportFailure.ok, false);
    assert.strictEqual(transportFailure.stage, 'pipeline');
    assert.strictEqual(transportFailure.sync, syncValue);
    assert.strictEqual(transportFailure.accounts_count, templateRows.length);
    assert.deepStrictEqual(transportFailure.errors, ['sync_failed: fixture notification transport rejected']);
    assert.strictEqual(transportFailure.action_result.planned, 8,
        '通知异常应保留已经完成的业务动作结果，避免误认为上架未执行');
    assertRefreshedStatus(finalPayload.accounts);
    assert(errors.some(x => x.includes('fixture account read failed')));
    assert(errors.some(x => x.includes('fixture notification transport rejected')));
    assert.strictEqual(externalRequests, 0);
    console.log('[PASS] Uhaozu pipeline regression: refreshed action facts in reports; invalid identities, failed sync, nonfatal reconciliation and transport failures');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
    for (const [object, key, original] of replacements.reverse()) object[key] = original;
    delete require.cache[require.resolve('../pipeline/user_pipeline')];
});
