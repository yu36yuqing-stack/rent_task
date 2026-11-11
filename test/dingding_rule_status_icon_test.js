'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const dir = fs.mkdtempSync('/tmp/rent-ding-rule-icon-');
for (const name of ['MAIN', 'RUNTIME', 'ORDER', 'STATS', 'PRICE']) {
    process.env[`${name}_DB_FILE_PATH`] = path.join(dir, `${name}.db`);
}
global.fetch = async () => { throw new Error('This test must not send real notifications'); };
const style = require('../report/dingding/ding_style');
const runtime = require('../database/runtime_task_db');
const history = new Map();
runtime.listRuntimeTasksByUserAndType = async (uid) => history.get(uid) || [];
const dedup = require('../report/dingding/ding_report_dedup');

const down = { youpin: '下架', uhaozu: '下架', zuhaowan: '下架' };
const up = { youpin: '上架', uhaozu: '上架', zuhaowan: '上架' };
const bindings = {
    uuzuhao: { prd_id: 'y-id' },
    uhaozu: { prd_id: 'u-id' },
    zuhaowang: { prd_id: 'z-id' }
};
const manual = {
    ...down, account: 'sample-account', game_id: '1', remark: '呆小雨',
    today_order_count: 0, online_tag: 'OFF', is_blacklisted: true,
    suffix: ' 🔸已按人工下架规则下架', channel_prd_info: bindings
};
let assertions = 0;
function icon(name, row, expected, authorized) {
    assert.strictEqual(style.pickIcon(row, authorized), expected, name);
    assertions++;
}
function report(row, extra = {}) {
    return { ok: true, hhmm: '10:00', accounts: [row], master_total: 1,
        authorized_platforms: ['uuzuhao', 'uhaozu', 'zuhaowang'], ...extra };
}

async function main() {
    for (const game_id of ['1', '2', '3', '4']) {
        for (const reason of ['人工下架', '维护中', '4单下架', '检测在线', '禁玩中', '人脸识别']) {
            for (const status of ['下架', '审核失败', '授权异常', '上架', '未知']) {
                icon(`${game_id}/${reason}/${status}`, {
                    ...manual, game_id, uhaozu: status, suffix: ` 🔸已按${reason}规则下架`
                }, '⬇️');
            }
        }
    }
    assert.strictEqual(style.buildDingdingAccountLine({ ...manual, uhaozu: '审核失败' }),
        '⬇️[0单](OFF) 呆小雨 Y下/U审/Z下 🔸已按人工下架规则下架');
    const cold = { ...manual, suffix: ' 🔸已按冷却期下架规则下架' };
    icon('cooldown still wins over other statuses', { ...cold, ...up, has_renting_order: true }, '⏳');
    icon('a remaining actual order wins over non-cooldown rules', { ...manual, has_renting_order: true }, '💰');
    icon('renting channel wins over non-cooldown rules', { ...manual, uhaozu: '租赁中' }, '💰');
    icon('出租中 alias is a real renting signal', { ...manual, zuhaowan: '出租中' }, '💰');
    icon('blocked account without a reason remains blocked', { ...manual, suffix: '' }, '⬇️');
    icon('blocked account without product evidence remains blocked', { ...manual, channel_prd_info: null }, '⬇️');

    const available = { ...manual, is_blacklisted: false, suffix: '' };
    icon('all down with no rule is an actionable shelf warning', available, '⚠️');
    icon('unblocked review failure is a shelf warning', { ...available, uhaozu: '审核失败' }, '⚠️');
    icon('unblocked authorization failure is a shelf warning', { ...available, uhaozu: '授权异常' }, '⚠️');
    icon('one channel down is a warning', { ...available, ...up, uhaozu: '下架' }, '⚠️');
    icon('all listed is normal', { ...available, ...up }, '✅');
    icon('an order is authoritative even when product states are stale', { ...available, has_renting_order: true }, '💰');
    icon('a suffix alone must not activate a rule', { ...manual, is_blacklisted: false }, '⚠️');
    icon('missing blacklist flag is legacy unblocked data', { ...available, is_blacklisted: undefined }, '⚠️');
    icon('invalid blacklist flag is not proof of an actionable state', { ...available, is_blacklisted: 'false' }, '❔');
    icon('null blacklist flag is unknown', { ...available, is_blacklisted: null }, '❔');

    icon('unapproved channel is not compared', { ...available, ...up, youpin: '下架' }, '✅', ['uhaozu', 'zuhaowang']);
    icon('disabled channel renting snapshot is not compared', { ...available, ...up, youpin: '租赁中' }, '✅', ['uhaozu']);
    icon('real order still counts independently of channel authorization', { ...available, has_renting_order: true }, '💰', []);
    icon('empty authorization list is not all channels', { ...available, ...up }, '❔', []);
    icon('unsupported-only authorization list has no comparable channel', { ...available, ...up }, '❔', ['5e']);
    icon('platform normalization supports uppercase and duplicates', { ...available, ...up }, '✅', ['UHAOZU', 'uhaozu']);
    icon('unassociated error channel is excluded', {
        ...available, ...up, uhaozu: '审核失败', channel_prd_info: { uuzuhao: bindings.uuzuhao }
    }, '✅');
    icon('empty product binding is not an associated product', {
        ...available, ...up, uhaozu: '审核失败', channel_prd_info: { uuzuhao: bindings.uuzuhao, uhaozu: {} }
    }, '✅');
    icon('no product bindings means unknown rather than normal', { ...available, ...up, channel_prd_info: {} }, '❔');
    icon('legacy input without bindings uses explicit channel facts', { ...up }, '✅');
    icon('legacy unassociated statuses are ignored', { youpin: '上架', uhaozu: '未找到', zuhaowan: '未关联' }, '✅');
    icon('legacy blank statuses are ignored', { youpin: '上架', uhaozu: '', zuhaowan: ' ' }, '✅');
    icon('legacy no product facts is unknown', {}, '❔');
    icon('null account is unknown', null, '❔');
    icon('array account is unknown', [], '❔');
    icon('primitive account is unknown', 'invalid', '❔');
    icon('omitted account is unknown', undefined, '❔');

    for (const channel_prd_info of [null, [], 'invalid', 1]) {
        icon('invalid product evidence cannot prove normality', { ...up, channel_prd_info }, '❔');
        icon('no authorization still has no evidence', { ...up, channel_prd_info }, '❔', []);
    }
    for (const bad of [[], 'invalid', 1]) {
        icon('invalid product binding is unknown', { ...available, ...up,
            channel_prd_info: { ...bindings, uhaozu: bad } }, '❔');
    }
    for (const status of ['', null, '未知', '未找到', '同步失败']) {
        icon('linked product with missing status is unknown', { ...available, ...up, uhaozu: status }, '❔');
    }
    icon('unknown channel might be renting, so not a definitive shelf warning', { ...available, uhaozu: '未知' }, '❔');
    assert.deepStrictEqual(style.normalizeAuthorizedPlatforms([]), []);
    assert.deepStrictEqual(style.normalizeAuthorizedPlatforms(['5e']), []);
    assert.deepStrictEqual(style.normalizeAuthorizedPlatforms(), ['uuzuhao', 'uhaozu', 'zuhaowang']);

    for (const row of [manual, cold, available, { ...available, ...up }, { ...available, uhaozu: '未知' }]) {
        const p = report(row);
        const before = JSON.stringify(row);
        const text = style.buildDingdingMessage(p);
        const snapshot = dedup.buildDingdingReportSnapshot(p);
        const account = snapshot.accounts[0];
        assert.strictEqual(account.icon, style.pickIcon(row, p.authorized_platforms));
        assert.ok(text.includes(account.icon + '[0单](OFF)'));
        assert.strictEqual(JSON.stringify(row), before, 'formatting must not mutate facts');
        assert.strictEqual(dedup.buildDingdingReportFingerprint(p, 'same').content_hash,
            dedup.buildDingdingReportFingerprint({ ...p, hhmm: '10:05' }, 'same').content_hash);
    }
    const legacy = report({ ...up, account: 'legacy' });
    delete legacy.authorized_platforms;
    assert.ok(style.buildDingdingMessage(legacy).includes('✅[0单]'));
    assert.strictEqual(dedup.buildDingdingReportSnapshot(legacy).accounts[0].icon, '✅');
    const noAuth = { ...legacy, authorized_platforms: [] };
    assert.ok(style.buildDingdingMessage(noAuth).includes('❔[0单]'));
    assert.strictEqual(dedup.buildDingdingReportSnapshot(noAuth).accounts[0].icon, '❔');

    const manualPayload = report({ ...manual, uhaozu: '审核失败' });
    const current = dedup.buildDingdingReportSnapshot(manualPayload);
    const old = structuredClone(current);
    old.accounts[0].icon = '⚠️';
    const diff = dedup.diffDingdingReportSnapshots(old, current);
    assert.strictEqual(diff.accounts['1::sample-account'].type, 'changed');
    assert.ok(diff.accounts['1::sample-account'].fields.some(x => x.key === 'icon'));

    const fp = dedup.buildDingdingReportFingerprint(manualPayload, 'test-destination');
    const checkpoint = (contentHash, snapshot) => [{ task_id: 'test-task', result_json: {
        notification_checkpoint: { dingding_rent_status: { status: 'sent', content_hash: contentHash,
            destination_hash: fp.destination_hash, snapshot } }
    } }];
    history.set(8, checkpoint('old-icon-content-hash', old));
    const changed = await dedup.buildDingdingReportDeliveryDecision({ userId: 8, payload: manualPayload, webhook: 'test-destination' });
    assert.strictEqual(changed.should_send, true);
    assert.strictEqual(changed.reason, 'content_changed');
    history.set(8, checkpoint(fp.content_hash, current));
    const repeated = await dedup.buildDingdingReportDeliveryDecision({ userId: 8, payload: { ...manualPayload, hhmm: '10:05' }, webhook: 'test-destination' });
    assert.strictEqual(repeated.should_send, false);
    assert.strictEqual(repeated.reason, 'unchanged');
    assert.strictEqual((await dedup.buildDingdingReportDeliveryDecision({ userId: 12, payload: manualPayload, webhook: 'test-destination' })).should_send, true);

    const withProblems = style.buildDingdingMessage(report({ ...manual, uhaozu: '审核失败',
        channel_prd_info: { ...bindings, uuzuhao: { prd_id: 'y-id', off_type: 'AUTHORIZE_ERROR' } } }, {
        sync_anomalies: [{ platform: 'uhaozu', expected_count: 1, pulled_count: 0, missing_count: 1 }]
    }));
    assert.ok(withProblems.includes('⬇️[0单](OFF)'));
    assert.ok(withProblems.includes('请号主在悠悠重新授权'));
    assert.ok(withProblems.includes('U号租: 期望1 / 拉回0 / 少回1'));
    assert.ok(withProblems.includes('Y下/U审/Z下'));
    console.log(`[PASS] DingTalk rule-aware icons: ${assertions} classification cases plus formatting, dedup, user isolation and anomaly preservation; no real HTTP`);
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
