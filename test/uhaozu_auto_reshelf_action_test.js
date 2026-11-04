'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-uhaozu-reshelf-actions-'));
for (const name of ['MAIN', 'RUNTIME', 'ORDER', 'STATS', 'PRICE']) {
    process.env[`${name}_DB_FILE_PATH`] = path.join(dir, `${name}.db`);
}
let externalCalls = 0;
global.fetch = async () => { externalCalls++; throw new Error('unexpected real request'); };

const KEY = 'uhaozu.auto_reshelf_reasons';
const ONLINE = '检测游戏在线，请确认游戏离线后手动上架';
const FACE = '账号人脸识别';
const FORBIDDEN = '商品开启禁玩,已自动下架';
const policy = { key: KEY, id: 31, version: 7, available: true, reasons: [ONLINE, FACE, FORBIDDEN] };
let configReads = 0;
let configRow = { found: true, id: 31, key: KEY, version: 7, value: { reasons: policy.reasons } };
let configError = null;
require('../database/system_config_db').getSystemConfig = async key => {
    assert.strictEqual(key, KEY);
    configReads++;
    if (configError) throw configError;
    return configRow;
};

const authDb = require('../database/user_platform_auth_db');
authDb.listUserPlatformAuth = async () => [
    { platform: 'uuzuhao', auth_status: 'valid', channel_enabled: true, auth_payload: { app_key: 'fixture', app_secret: 'fixture' } },
    { platform: 'uhaozu', auth_status: 'valid', channel_enabled: true, auth_payload: { cookie: 'fixture-cookie' } },
    { platform: 'zuhaowang', auth_status: 'valid', channel_enabled: true, auth_payload: { yuanbao: { token: 'fixture', deviceId: 'fixture' } } }
];
const restriction = require('../database/user_platform_restrict_db');
restriction.listPlatformRestrictByUserAndAccounts = async () => [];
restriction.removePlatformRestrict = async () => true;
const history = [];
require('../database/product_onoff_history_db').appendProductOnoffHistory = async entry => { history.push(entry); };
const calls = [];
let onModify = null;
let apiResult = true;
const uhaozu = require('../uhaozu/uhaozu_api');
uhaozu.uhaozuOnShelf = async (_page, account, options) => {
    assert.strictEqual(options.auth.cookie, 'fixture-cookie');
    calls.push({ type: 'on_u', account, options });
    return apiResult;
};
uhaozu.uhaozuReshelfByModify = async (_page, account, options) => {
    assert.strictEqual(options.auth.cookie, 'fixture-cookie');
    calls.push({ type: 'on_u_modify', account, options });
    if (onModify) await onModify();
    return apiResult;
};

const { normalizeOnePlatformStatus } = require('../product/prod_channel_status');
const engine = require('../action_engine/action_engine');
const identity = { account: 'fixture-3387324805', game_id: '1', game_name: 'WZRY' };

function input(reason, options = {}) {
    const { y = '上架', z = '上架', u = '审核失败', gameId = '1', account = identity.account } = options;
    const item = { ...identity, account, game_id: gameId };
    const out = {
        youpinData: y === null ? [] : [{ ...item, status: y }],
        uhaozuData: [{ ...item, status: u, prd_id: 'fixture-u-goods', platform_game_id: 'A2705' }],
        zhwData: z === null ? [] : [{ ...item, status: z, gameId: 1104466820, dataId: 'fixture-z' }],
        platformStatusNormMap: {
            [`${gameId}::${account}`]: {
                uuzuhao: { code: y === '上架' ? 'listed' : 'off_shelf' },
                uhaozu: normalizeOnePlatformStatus('uhaozu', { uhaozu: u }, { uhaozu: { audit_reason: reason } }),
                zuhaowang: { code: z === '上架' ? 'listed' : 'off_shelf' }
            }
        },
        uhaozuAutoReshelfPolicy: policy
    };
    return out;
}

const uActions = value => engine.detectConflictsAndBuildSnapshot(value).actions
    .filter(action => action.type === 'on_u' || action.type === 'on_u_modify');

function wrapperRow(reason, suffix = '') {
    return {
        game_account: identity.account + suffix, game_id: '1', game_name: 'WZRY',
        channel_status: { uuzuhao: '上架', uhaozu: '审核失败', zuhaowang: '上架' },
        channel_prd_info: { uuzuhao: { prd_id: 'fixture-y' },
            uhaozu: { prd_id: 'fixture-u-goods', game_id: 'A2705', audit_reason: reason },
            zuhaowang: { prd_id: 'fixture-z', game_id: 1104466820 } }
    };
}

async function main() {
    for (const reason of [ONLINE, FACE, '账号人脸识别：', FORBIDDEN, '商品开启禁玩，已自动下架', `  ${FACE}  `]) {
        const actions = uActions(input(reason));
        assert.deepStrictEqual(actions.map(x => x.type), ['on_u_modify']);
        assert.strictEqual(actions[0].item.goods_id, 'fixture-u-goods');
        assert.deepStrictEqual(actions[0].uhaozu_recovery, {
            config_key: KEY, config_id: 31, config_version: 7, reason: reason.trim()
        });
        assert(actions[0].reason.includes(reason.trim()));
    }
    for (const reason of ['账号被冻结：', '账号人脸识别，且封号', '获取区服角色失败', '当前商品被设置禁止上架']) {
        assert.deepStrictEqual(uActions(input(reason)), []);
    }
    for (const value of [undefined, null, { ...policy, reasons: [] }, { ...policy, available: false }]) {
        for (const reason of [ONLINE, FACE, FORBIDDEN]) {
            assert.deepStrictEqual(uActions({ ...input(reason), uhaozuAutoReshelfPolicy: value }), []);
        }
    }
    assert.strictEqual(configReads, 0, 'the planner must not read the database');
    const enabledOnlineOnly = { ...policy, reasons: [ONLINE] };
    assert.strictEqual(uActions({ ...input('系统检测到游戏在线，请确认离线后手动上架'), uhaozuAutoReshelfPolicy: enabledOnlineOnly }).length, 1);
    assert.deepStrictEqual(uActions({ ...input(ONLINE), uhaozuAutoReshelfPolicy: { ...policy, reasons: [FACE] } }), []);
    for (const opts of [{ y: '上架', z: '下架' }, { y: '下架', z: '上架' }, { y: null, z: null }]) {
        assert.deepStrictEqual(uActions(input(FACE, opts)).map(x => x.type), ['on_u']);
    }
    for (const opts of [{ y: '上架', z: null }, { y: null, z: '上架' }]) {
        assert.deepStrictEqual(uActions(input(FACE, opts)).map(x => x.type), ['on_u_modify']);
    }
    for (const opts of [{ y: '租赁中' }, { z: '租赁中' }, { u: '上架' }, { u: '租赁中' }]) {
        assert.deepStrictEqual(uActions(input(FACE, opts)), []);
    }
    const blocked = input(FACE);
    blocked.blacklistAccounts = new Set([`1::${identity.account}`]);
    const blacklistActions = engine.detectConflictsAndBuildSnapshot(blocked).actions;
    assert.deepStrictEqual(blacklistActions.map(x => x.type), ['off_y', 'off_z']);
    blocked.blacklistAccounts.clear();
    blocked.platformRestrictSet = new Set([`1::${identity.account}::uhaozu`]);
    assert.deepStrictEqual(uActions(blocked), []);
    const normal = uActions({ ...input('', { u: '下架' }), uhaozuAutoReshelfPolicy: undefined });
    assert.deepStrictEqual(normal.map(x => x.type), ['on_u']);
    assert.strictEqual(normal[0].uhaozu_recovery, undefined, 'normal on-shelf is independent of the recovery list');

    const one = input(FACE), two = input(FACE, { gameId: '2' });
    const twoGames = engine.detectConflictsAndBuildSnapshot({
        ...one, youpinData: [...one.youpinData, ...two.youpinData],
        uhaozuData: [...one.uhaozuData, ...two.uhaozuData], zhwData: [...one.zhwData, ...two.zhwData],
        platformStatusNormMap: { ...one.platformStatusNormMap, ...two.platformStatusNormMap },
        platformRestrictSet: new Set([`1::${identity.account}::uhaozu`])
    }).actions.filter(x => x.type.startsWith('on_u'));
    assert.strictEqual(twoGames.length, 1);
    assert.strictEqual(twoGames[0].item.game_id, '2');

    const run = (rows = [wrapperRow(FACE)], options = {}) => engine.executeUserActionsIfNeeded({ user: { id: 8 }, rows, ...options });
    const skipped = await run(undefined, { actionEnabled: false });
    assert.strictEqual(skipped.planned, 0);
    assert.strictEqual(configReads, 0);
    const first = await run();
    assert.strictEqual(configReads, 1, 'one policy read per wrapper invocation');
    assert.strictEqual(first.errors.length, 0);
    assert.strictEqual(calls.at(-1).type, 'on_u_modify');
    assert.strictEqual(first.actions[0].uhaozu_recovery.config_version, 7);
    assert.strictEqual(history.at(-1).action_type, 'on_u_modify');

    const readsBeforeInjected = configReads;
    await run(undefined, { uhaozuAutoReshelfPolicy: policy });
    assert.strictEqual(configReads, readsBeforeInjected, 'an injected pipeline snapshot must not be read again');
    const callsBeforeReadonly = calls.length;
    const readonly = await run(undefined, { readOnly: true, uhaozuAutoReshelfPolicy: policy });
    assert.strictEqual(calls.length, callsBeforeReadonly);
    assert.strictEqual(readonly.actions[0].mode, 'read_only');

    onModify = async () => { configRow = { ...configRow, version: 8, value: { reasons: [] } }; };
    const beforeShared = configReads;
    const shared = await run([wrapperRow(FACE), wrapperRow(FORBIDDEN, '-second')]);
    assert.strictEqual(configReads, beforeShared + 1);
    assert.strictEqual(shared.actions.length, 2, 'the same configuration snapshot applies to both planned actions');
    assert(shared.actions.every(x => x.uhaozu_recovery.config_version === 7));
    onModify = null;
    const nextRound = await run();
    assert.strictEqual(nextRound.planned, 0, 'the next round observes an empty list without restarting');
    configRow = { found: false };
    assert.strictEqual((await run()).planned, 0);
    configRow = { found: true, id: 31, version: 9, value: { reasons: 'invalid' } };
    assert.strictEqual((await run()).planned, 0);
    configError = Object.assign(new Error('fixture unavailable'), { code: 'SQLITE_BUSY' });
    assert.strictEqual((await run()).planned, 0);
    configError = null;
    configRow = { found: true, id: 31, version: 10, value: { reasons: [FACE] } };
    apiResult = false;
    const failed = await run();
    assert.strictEqual(failed.errors.length, 1);
    assert.strictEqual(failed.timing.actions.failed, 1);
    assert.strictEqual(externalCalls, 0);
    console.log('[PASS] Uhaozu recovery actions: configured reasons, both paths, safety gates, identity, config versions, removal and failures; no external requests');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
