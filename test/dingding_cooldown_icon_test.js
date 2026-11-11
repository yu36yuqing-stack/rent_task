'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const dbDir = fs.mkdtempSync('/tmp/rent-ding-cooldown-test-');
for (const name of ['MAIN', 'RUNTIME', 'ORDER', 'STATS', 'PRICE']) {
    process.env[`${name}_DB_FILE_PATH`] = path.join(dbDir, `${name}.db`);
}
const style = require('../report/dingding/ding_style');

const suffix = ' 🔸已按冷却期下架规则下架';
const down = { youpin: '下架', uhaozu: '下架', zuhaowan: '下架' };
const cold = { ...down, account: 'sample', game_id: '1', remark: '呆萌萌', is_blacklisted: true, suffix, today_order_count: 1 };
let checks = 0;

async function check(name, fn) {
    await fn();
    checks++;
    console.log(`[PASS] ${name}`);
}

function payload(accounts = [cold], overrides = {}) {
    return { ok: true, report_owner: '样式测试', hhmm: '20:25', master_total: accounts.length, accounts, ...overrides };
}

async function main() {
    await check('only the effective cooldown blacklist changes the account icon', () => {
        for (const game_id of ['1', '2', '3', '4']) {
            assert.strictEqual(style.pickIcon({ ...cold, game_id }), '⏳');
        }
        for (const states of [down, { ...down, youpin: '租赁中' }, { youpin: '上架', uhaozu: '上架', zuhaowan: '上架' }]) {
            assert.strictEqual(style.pickIcon({ ...cold, ...states, has_renting_order: true }), '⏳');
        }
        for (const reason of ['维护中', '禁玩中', '人工下架', '4单下架', '检测在线']) {
            assert.strictEqual(style.pickIcon({ ...cold, suffix: ` 🔸已按${reason}规则下架` }), '⬇️');
        }
        assert.strictEqual(style.pickIcon({ ...cold, is_blacklisted: false }), '⚠️');
        assert.strictEqual(style.pickIcon({ ...cold, is_blacklisted: 'true' }), '❔');
        assert.strictEqual(style.pickIcon({ ...cold, suffix: '', remark: '冷却期下架' }), '⬇️');
        assert.strictEqual(style.pickIcon({ ...cold, is_blacklisted: false, has_renting_order: true }), '💰');
        assert.strictEqual(style.pickIcon({ ...down, youpin: '租赁中' }), '💰');
        assert.strictEqual(style.pickIcon({ youpin: '上架', uhaozu: '上架', zuhaowan: '上架' }), '✅');
        assert.strictEqual(style.pickIcon({ ...down, uhaozu: '审核失败' }), '⚠️');
        assert.strictEqual(style.pickIcon({ youpin: '', uhaozu: '', zuhaowan: '' }), '❔');
        assert.strictEqual(style.pickIcon(down, ['UHAOZU']), '⚠️');
    });

    await check('one native hourglass per cooldown row, with complete brackets and ordinary text preserved', () => {
        const text = style.buildDingdingMessage(payload([cold, { ...down, account: 'normal' }]));
        assert.strictEqual((text.match(/⏳/gu) || []).length, 1);
        assert.ok(!text.includes('🧊'));
        assert.ok(!text.includes('!['));
        assert.ok(!text.includes('http'));
        assert.ok(text.includes('⚠️[0单] normal Y下/U下/Z下'));
        assert.ok(text.includes('已按冷却期下架规则下架'));
        for (const count of [2, 25]) {
            const rows = Array.from({ length: count }, (_, i) => ({ ...cold, account: `a-${i}` }));
            const all = style.buildDingdingMessage(payload(rows));
            assert.strictEqual((all.match(/⏳\[1单\]/gu) || []).length, count);
        }
        assert.strictEqual(style.buildDingdingAccountLine().includes('[0单]'), true);
        assert.ok(style.buildDingdingAccountLine({ ...cold, online_tag: 'OFF', hint: 'hint' }).includes('(OFF)'));
        assert.strictEqual(style.buildDingdingAccountLine({ ...cold, online_tag: '离线' }),
            `⏳[1单](离线) 呆萌萌 Y下/U下/Z下${suffix}`);
        for (const count of [0, 1, 12]) {
            assert.ok(style.buildDingdingAccountLine({ ...cold, today_order_count: count, online_tag: '离线' }).startsWith(`⏳[${count}单](离线) `));
        }
    });

    await check('image conversion and URL configuration are removed', () => {
        assert.strictEqual(Object.hasOwn(style, 'buildDingdingWireMessage'), false);
        const source = fs.readFileSync(require.resolve('../report/dingding/ding_style'), 'utf8');
        assert.ok(!source.includes('cooldown-hourglass-v1'));
        assert.ok(!source.includes('DINGDING_COOLDOWN_ICON_URL'));
        assert.ok(!fs.existsSync(path.join(__dirname, '../h5/public/assets/notification_icons/cooldown-hourglass-v1.png')));
    });

    await check('sample clearly labels synthetic data; dedup tracks cooldown entry and exit', () => {
        const sample = style.buildDingdingCooldownPreview({ owner: 'xuzhou', hhmm: '20:25' });
        assert.ok(sample.startsWith('【样式测试】冷却期原生沙漏'));
        assert.ok(sample.includes('不代表账号实时状态'));
        assert.ok(sample.includes('xuzhou'));
        assert.ok(sample.includes('⏳[1单](离线)'));
        assert.ok(!sample.includes('冰蓝'));
        assert.ok(style.buildDingdingCooldownPreview().includes('UID=8'));
        const dedup = require('../report/dingding/ding_report_dedup');
        const old = payload([{ ...cold, is_blacklisted: false, suffix: '' }]);
        const active = payload();
        assert.notStrictEqual(dedup.buildDingdingReportFingerprint(old, 'stub').content_hash, dedup.buildDingdingReportFingerprint(active, 'stub').content_hash);
        assert.strictEqual(dedup.buildDingdingReportFingerprint(active, 'stub').content_hash, dedup.buildDingdingReportFingerprint({ ...active, hhmm: '20:30' }, 'stub').content_hash);
        const snapshot = dedup.buildDingdingReportSnapshot(active);
        assert.strictEqual(snapshot.accounts[0].icon, '⏳');
        assert.notStrictEqual(dedup.buildDingdingReportFingerprint(active, 'stub').destination_hash, dedup.buildDingdingReportFingerprint(active, 'other-user').destination_hash);
    });

    await check('existing style paths: summary changes, auth notices, anomalies and inspector messages', () => {
        assert.ok(style.buildDingdingMessage().includes('暂无状态数据'));
        assert.strictEqual(style.buildDingdingMessage({ message: 'failure' }), 'failure');
        assert.ok(style.buildDingdingMessage({ ok: true, allNormal: true }).includes('所有状态正常'));
        const account = { ...cold, account: 'changed', channel_prd_info: { uuzuhao: { off_type: 'AUTHORIZE_ERROR' } } };
        const p = payload([account, { ...cold, account: 'added' }], {
            recentActions: ['one', 'two'],
            allNormal: true,
            sync_anomalies: ['uuzuhao', 'uhaozu', 'zuhaowang', '5e', ''].map(platform => ({ platform, sample_missing_text: 'missing' })),
            dingding_changes: {
                available: true,
                summary: { header_changed: true, recent_actions_changed: true, auth_problems_changed: true, order_count: { before: 2 }, master_total: { before: 1 }, sync_anomalies_changed: true, footer_changed: true },
                accounts: { '1::changed': { type: 'changed', detail: 'changed' }, '1::added': { type: 'added' } },
                removed_accounts: [{ account: 'old', display_name: 'Old' }, {}, { display_name: 'No account' }]
            }
        });
        const text = style.buildDingdingMessage(p);
        for (const expected of ['请号主在悠悠重新授权', '2 → 2', '1 → 2个', '授权失效', '已移出商品主档', '🆕', '〔changed〕', '悠悠:', 'U号租:', '租号王:', '5e:']) {
            assert.ok(text.includes(expected), expected);
        }
        assert.ok(text.includes('🔄 ⏳[1单]'));
        assert.ok(text.includes('🆕 ⏳[1单]'));
        style.buildDingdingMessage(payload([], { dingding_changes: { available: true, summary: {}, accounts: {}, removed_accounts: [] }, sync_anomalies: [{}, { platform: 'custom' }] }));
        assert.deepStrictEqual(style.normalizeAuthorizedPlatforms(['UUZUHAO', 'uhaozu', 'zuhaowang', 'uuzuhao', 'invalid', '']), ['uuzuhao', 'uhaozu', 'zuhaowang']);
        assert.deepStrictEqual(style.normalizeAuthorizedPlatforms('invalid'), ['uuzuhao', 'uhaozu', 'zuhaowang']);
        assert.strictEqual(style.accountIdentityKey(), '1::');
        assert.strictEqual(style.accountIdentityKey({ game_id: ' 2 ', account: ' a ' }), '2::a');
        assert.strictEqual(style.shortState(), '未');
        assert.strictEqual(style.shortState('出租中'), '租');
        const complaint = style.buildComplaintFirstHitText({ user_name: 'owner', user_id: 8, game_account: 'account', role_name: 'Role', complaint_context: 'x'.repeat(81) });
        assert.ok(complaint.includes('8(owner)'));
        assert.ok(complaint.includes('...'));
        assert.ok(style.buildComplaintFirstHitText({ complaint_context: 'short' }).includes('short'));
        assert.ok(style.buildComplaintFirstHitText().includes('用户: -'));
        const mismatch = Array.from({ length: 16 }, (_, i) => ({ game_account: `a${i}`, legacy_reason: 'old', projected_reason: 'new', projected_source: 'source' }));
        assert.ok(style.buildBlacklistInspectorMismatchText({ user_id: 8, user_name: 'owner', mismatch }).includes('其余 1 条'));
        assert.ok(style.buildBlacklistInspectorMismatchText({ mismatch: [null, {}] }).includes('旧=无 / 新=无'));
        assert.ok(style.buildBlacklistInspectorMismatchText().includes('差异账号数: 0'));
        assert.ok(style.buildBlacklistInspectorSummaryText().includes('users_checked=0'));
        assert.ok(style.buildBlacklistInspectorSummaryText({ mode: 3, users_checked: 2, users_mismatch: 1, accounts_mismatch: 1, duration_ms: 5 }).includes('mode=3'));
    });

    const notifyPath = require.resolve('../report/dingding/ding_notify');
    let config = { dingding_webhook: 'config-token', dingding_secret: 'config-secret' };
    let exists = true;
    let readError = false;
    let invalidJson = false;
    const fakeFs = {
        existsSync: () => exists,
        readFileSync: () => {
            if (readError) throw new Error('stub config read error');
            return invalidJson ? '{bad' : JSON.stringify(config);
        }
    };
    const originalLoad = Module._load;
    try {
        Module._load = function (request, parent, ...rest) {
            if (request === 'fs' && parent.filename === notifyPath) return fakeFs;
            return originalLoad.call(this, request, parent, ...rest);
        };
        delete require.cache[notifyPath];
        require(notifyPath);
    } finally { Module._load = originalLoad; }
    const notify = require(notifyPath);
    const requests = [];
    let response = { ok: true, status: 200, content: '{"errcode":0,"errmsg":"ok"}' };
    let networkFailure = false;
    const originalFetch = global.fetch;
    global.fetch = async (url, options) => {
        requests.push({ url, body: JSON.parse(options.body), options });
        if (networkFailure) throw new Error('stub network failure');
        return { ok: response.ok, status: response.status, text: async () => response.content };
    };
    try {
        await check('real sender emits unchanged text for cooldown and preserves signing and mentions', async () => {
            const message = style.buildDingdingMessage(payload([{ ...cold, online_tag: '离线' }]));
            assert.strictEqual(await notify.sendDingdingMessage(message, {
                webhook: 'https://oapi.dingtalk.com/robot/send?access_token=stub', secret: 'stub-secret', at_all: true,
                at_mobiles: ['+86 13800138000', '13800138000', 'invalid', '', '123'], at_user_ids: ['owner', '', 'owner']
            }), true);
            const sent = requests.at(-1);
            assert.strictEqual(sent.body.msgtype, 'text');
            assert.strictEqual(sent.body.text.content, message);
            assert.ok(sent.body.text.content.includes('⏳[1单](离线)'));
            assert.strictEqual(Object.hasOwn(sent.body, 'markdown'), false);
            assert.deepStrictEqual(sent.body.at, { isAtAll: true, atMobiles: ['13800138000'], atUserIds: ['owner'] });
            assert.ok(new URL(sent.url).searchParams.get('sign'));
            assert.ok(new URL(sent.url).searchParams.get('timestamp'));
            await notify.sendDingdingMessage('ordinary alert', { webhook: 'short-token', secret: 's', at_mobiles: '13900139000,13900139000', at_user_ids: 'owner' });
            assert.strictEqual(requests.at(-1).body.msgtype, 'text');
            assert.strictEqual(new URL(requests.at(-1).url).searchParams.get('access_token'), 'short-token');
            assert.deepStrictEqual(requests.at(-1).body.at.atUserIds, ['owner']);
            const count = requests.length;
            assert.strictEqual(await notify.sendDingdingMessage(' '), false);
            assert.strictEqual(requests.length, count);
        });

        await check('plain text keeps punctuation, links and line breaks without Markdown parsing', async () => {
            const text = `标题 <a> & **name**\r\n🔄 ⏳[1单](离线) [bad](https://bad.test) ${suffix}\n🆕 ⏳[2单] second ${suffix}`;
            const saved = process.env.DINGDING_COOLDOWN_ICON_URL;
            try {
                process.env.DINGDING_COOLDOWN_ICON_URL = 'not-a-valid-url';
                await notify.sendDingdingMessage(text, { webhook: 'token', secret: 's' });
                assert.strictEqual(requests.at(-1).body.msgtype, 'text');
                assert.strictEqual(requests.at(-1).body.text.content, text);
            } finally {
                if (saved === undefined) delete process.env.DINGDING_COOLDOWN_ICON_URL;
                else process.env.DINGDING_COOLDOWN_ICON_URL = saved;
            }
        });

        await check('sender configuration and mention compatibility', async () => {
            await notify.sendDingdingMessage('config message');
            assert.strictEqual(new URL(requests.at(-1).url).searchParams.get('access_token'), 'config-token');
            config = {};
            await notify.sendDingdingMessage('unsigned', { webhook: 'token' });
            assert.ok(!new URL(requests.at(-1).url).searchParams.has('sign'));
            assert.ok(!requests.at(-1).body.at);
            exists = false;
            await assert.rejects(notify.sendDingdingMessage('x'), /webhook 未配置/);
            await notify.sendDingdingMessage('x', { webhook: 'token' });
            exists = true;
            invalidJson = true;
            await assert.rejects(notify.sendDingdingMessage('x'), /webhook 未配置/);
            invalidJson = false;
            readError = true;
            await assert.rejects(notify.sendDingdingMessage('x'), /webhook 未配置/);
            readError = false;
            assert.deepStrictEqual(notify.resolveDingdingAtOptions(), {});
            assert.deepStrictEqual(notify.resolveDingdingAtOptions(null), {});
            assert.deepStrictEqual(notify.resolveDingdingAtOptions({ at_mode: 'all' }), { at_all: true });
            assert.deepStrictEqual(notify.resolveDingdingAtOptions({ at_mode: 'none', at_mobiles: '13800138000' }), {});
            assert.deepStrictEqual(notify.resolveDingdingAtOptions({ status_at_mode: 'owner', status_at_mobiles: '13800138000', status_at_user_ids: 'owner' }, 'status'), { at_mobiles: ['13800138000'], at_user_ids: ['owner'] });
            assert.deepStrictEqual(notify.resolveDingdingAtOptions({ at_mobiles: '13800138000', at_user_ids: 'owner' }, 'status'), { at_mobiles: ['13800138000'], at_user_ids: ['owner'] });
            assert.deepStrictEqual(notify.resolveDingdingAtOptions({ complaint_at_mode: 'owner', complaint_at_mobiles: '13800138000', at_user_ids: ['owner', 'owner'] }, 'status'), { at_mobiles: ['13800138000'], at_user_ids: ['owner'] });
            assert.deepStrictEqual(notify.resolveDingdingAtOptions({ at_mode: 'invalid', complaint_at_mode: 'all' }, 'complaint'), { at_all: true });
        });

        await check('sender failures propagate once, without duplicate retry or silent success', async () => {
            const options = { webhook: 'token', secret: 's' };
            response = { ok: false, status: 403, content: 'denied' };
            await assert.rejects(notify.sendDingdingMessage('x', options), /HTTP 403/);
            response = { ok: true, status: 200, content: 'not JSON' };
            await assert.rejects(notify.sendDingdingMessage('x', options), /返回非JSON/);
            response.content = '{"errcode":310000,"errmsg":"denied"}';
            await assert.rejects(notify.sendDingdingMessage('x', options), /errcode=310000/);
            response.content = '{"errcode":1}';
            await assert.rejects(notify.sendDingdingMessage('x', options), /errcode=1, errmsg=$/);
            response.content = '';
            assert.strictEqual(await notify.sendDingdingMessage('x', options), true);
            networkFailure = true;
            const count = requests.length;
            await assert.rejects(notify.sendDingdingMessage('x', options), /network failure/);
            assert.strictEqual(requests.length, count + 1);
            networkFailure = false;
        });
    } finally { global.fetch = originalFetch; }

    console.log(`DingTalk cooldown icon: ${checks}/${checks} checks passed; all webhook requests stubbed.`);
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
