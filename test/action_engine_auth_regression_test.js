'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-action-auth-regression-'));
for (const name of ['MAIN', 'RUNTIME', 'ORDER', 'STATS', 'PRICE']) process.env[`${name}_DB_FILE_PATH`] = path.join(dir, `${name}.db`);
global.fetch = async () => { throw new Error('unexpected external request'); };
const restriction = require('../database/user_platform_restrict_db');
const authDb = require('../database/user_platform_auth_db');
const calls = [];
let authEnabled = true;
let behaviour = 'clear';
let active = new Set();
let removes = {};
let recordedRestrictions = 0;
const platforms = ['uuzuhao', 'uhaozu', 'zuhaowang', '5e'];
authDb.listUserPlatformAuth = async () => authEnabled ? platforms.map(platform => ({ platform, auth_status: 'valid',
    auth_payload: { app_key: 'fixture', cookie: 'fixture', yuanbao: { token: 'fixture', device_id: 'fixture' } } })) : [];
restriction.listPlatformRestrictByUserAndAccounts = async () => [...active].map(platform => ({ game_id: '1', game_account: 'A', platform }));
restriction.removePlatformRestrict = async (_uid, _key, platform) => {
    removes[platform] = (removes[platform] || 0) + 1;
    if (behaviour === 'throw' || behaviour === 'retry_once' && removes[platform] === 1) throw new Error('fixture busy');
    if (behaviour !== 'stuck') active.delete(platform);
};
restriction.upsertPlatformRestrict = async () => { recordedRestrictions++; };
const y = require('../uuzuhao/uuzuhao_api');
const u = require('../uhaozu/uhaozu_api');
y.youpinOnShelf = async () => { calls.push('on_y'); return { ok: true }; };
y.youpinOffShelf = async () => { calls.push('off_y'); return true; };
u.uhaozuOnShelf = async () => { calls.push('on_u'); return true; };
u.uhaozuOffShelf = async () => { calls.push('off_u'); return true; };
u.uhaozuReshelfByModify = async () => { calls.push('on_u_modify'); return true; };
require('../zuhaowang/zuhaowang_api').changeStatus = async (_a, _g, type) => { calls.push(type === 1 ? 'on_z' : 'off_z'); return true; };
require('../5e_platfrom/5e_api').updateRentAccountShelf = async () => { calls.push('5e'); return { ok: true }; };
const engine = require('../action_engine/action_engine');
const key = { game_account: 'A', game_id: '1', game_name: 'WZRY' };
const row = status => ({ ...key, channel_status: Object.fromEntries(platforms.map(p => [p, status])),
    channel_prd_info: { uuzuhao: { prd_id: 'y' }, uhaozu: { prd_id: 'u' },
        zuhaowang: { game_id: 1, prd_id: 'z' }, '5e': { account_no: '5e', steam_id: '765' } } });
const run = (r, extra = {}) => engine.executeUserActionsIfNeeded({ user: { id: 8 }, rows: [r], ...extra });
const types = ['on_y', 'off_y', 'on_u', 'off_u', 'on_u_modify', 'on_z', 'off_z', 'on_5e', 'off_5e'];
const actions = types.map(type => ({ type, item: { account: 'A', game_id: '1', game_name: 'WZRY', gameId: 1 }, reason: type }));
async function execute(override = {}, user = { id: 8 }) {
    const runRecord = { actions: [], errors: [] };
    await engine.executeActions({ user, actions, runRecord,
        youpinOnShelf: async () => ({ ok: true }), youpinOffShelf: async () => true,
        uhaozuOnShelf: async () => true, uhaozuOffShelf: async () => true, uhaozuReshelfByModify: async () => true,
        changeZhwStatus: async () => true, changeFiveEShelfStatus: async () => ({ ok: true }), ...override });
    return runRecord;
}

async function main() {
    await require('../database/user_game_account_db').upsertUserGameAccount({ user_id: 8, ...row('上架') });
    await require('../database/product_onoff_history_db').initProductOnoffHistoryDb();
    const empty = engine.detectConflictsAndBuildSnapshot({});
    assert.deepStrictEqual(empty.actions, []);
    const all = engine.buildPlatformRowsFromUserAccounts([row('上架')]);
    const blacklisted = engine.detectConflictsAndBuildSnapshot({ ...all, blacklistAccounts: new Set(['1::A']) });
    assert.deepStrictEqual(blacklisted.actions.map(a => a.type).sort(), ['off_5e', 'off_u', 'off_y', 'off_z']);
    for (const held of ['youpinData', 'uhaozuData', 'zhwData', 'fiveEData']) {
        const input = structuredClone(all);
        input[held][0].status = '租赁中';
        const result = engine.detectConflictsAndBuildSnapshot(input);
        assert.strictEqual(result.actions.length, 3);
        assert(result.actions.every(a => a.type.startsWith('off_')));
    }
    const system = structuredClone(all);
    system.youpinData[0].reason = '系统下架';
    assert.strictEqual(engine.detectConflictsAndBuildSnapshot(system).actions.length, 4);
    system.youpinData[0].account = '3045296464';
    assert(engine.detectConflictsAndBuildSnapshot(system).actions.some(a => a.reason.includes('人工指令')));
    assert.deepStrictEqual(engine.buildPlatformRowsFromUserAccounts([{ game_account: '' }]).youpinData, []);
    assert.strictEqual((await run(row('上架'), { actionEnabled: false })).planned, 0);
    await assert.rejects(() => run(row('上架'), { user: null }), /user/);
    for (const mode of ['clear', 'retry_once', 'stuck', 'throw']) {
        active = new Set(platforms); removes = {}; behaviour = mode;
        const result = await run(row('上架'));
        assert.strictEqual(result.planned, 0);
        assert.strictEqual(result.errors.length, ['stuck', 'throw'].includes(mode) ? 4 : 0);
        assert.strictEqual(removes.uuzuhao, mode === 'clear' ? 1 : mode === 'retry_once' ? 2 : 3);
    }
    behaviour = 'clear'; active.clear();
    const listed = await run(row('下架'));
    assert.strictEqual(listed.actions.length, 4);
    assert.strictEqual(listed.errors.length, 0);
    for (const name of ['on_y', 'on_u', 'on_z', '5e']) assert(calls.includes(name));
    const soft = row('上架');
    soft.channel_status.uhaozu = '下架';
    soft.channel_prd_info.uhaozu.audit_reason = '检测游戏在线，请确认游戏离线后手动上架';
    const softResult = await run(soft);
    assert.strictEqual(softResult.actions[0].type, 'on_u_modify');
    assert(calls.includes('on_u_modify'));
    authEnabled = false;
    await assert.rejects(() => run(row('下架')), /授权缺失/);
    authEnabled = true;
    assert.strictEqual((await execute()).actions.length, 9);
    const readonly = await execute({ readOnly: true });
    assert.strictEqual(readonly.actions.length, 9);
    assert(readonly.actions.every(a => a.skipped && a.mode === 'read_only'));
    const restricted = await execute({ actions: [actions[0]], youpinOnShelf: async () => ({ ok: false, code: 12101012, msg: 'fixture restriction' }) });
    assert.strictEqual(recordedRestrictions, 1);
    assert.strictEqual(restricted.errors.length, 1);
    const invalid = await execute({ actions: [actions[2]] }, { id: 0 });
    assert(invalid.errors.some(e => e.includes('invalid_args')));
    const failed = await execute({ uhaozuOnShelf: async () => { throw new Error('fixture timeout'); },
        changeFiveEShelfStatus: undefined, actions: [actions[2], actions[7]] });
    assert.strictEqual(failed.errors.length, 2);
    const noGame = await execute({ actions: [actions[5], actions[6]].map(a => ({ ...a, item: { account: 'A' } })) });
    assert.strictEqual(noGame.errors.length, 2);
    const noActions = await execute({ actions: [] });
    assert.strictEqual(noActions.action_timing.executed, 0);
    console.log('[PASS] action engine regression: four-channel safety, restriction cleanup/retries, readonly, errors and auth isolation');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
