'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-uhaozu-face-policy-'));
for (const name of ['MAIN', 'RUNTIME', 'ORDER', 'STATS', 'PRICE']) process.env[`${name}_DB_FILE_PATH`] = path.join(dir, `${name}.db`);
global.fetch = async () => { throw new Error('Unexpected external request'); };
const { reconcilePlatformFaceVerifyBlacklist: reconcile } = require('../pipeline/user_pipeline');
const { upsertSourceAndReconcile } = require('../blacklist/blacklist_source_gateway');
const { listBlacklistSourcesByUserAndAccounts } = require('../database/user_blacklist_source_db');
const { listUserBlacklistByUserWithMeta } = require('../database/user_blacklist_db');
const { loadUhaozuAutoReshelfPolicy } = require('../product/uhaozu_auto_reshelf_policy');
const policy = Object.freeze({ available: true, id: 1, version: 3,
    reasons: Object.freeze(['账号人脸识别', '商品开启禁玩,已自动下架', '检测游戏在线，请确认游戏离线后手动上架']) });
const disabled = Object.freeze({ available: true, id: 1, version: 4, reasons: [] });
const uid = 808;
const quiet = { log() {}, warn() {} };
const future = '2099-01-01 00:00:00';
const expired = '2000-01-01 00:00:00';
const identity = (account, game_id = '1') => ({ game_account: account, game_id, game_name: game_id === '2' ? '和平精英' : 'WZRY' });
const face = (account, platforms = ['uhaozu'], reason = '账号人脸识别') => ({ ...identity(account),
    channel_prd_info: Object.fromEntries(platforms.map((p) => [p, p === 'uhaozu' ? { audit_reason: reason }
        : p === 'zuhaowang' ? { exception_msg: reason } : { reason }])) });
const apply = (row, p = policy) => reconcile(uid, [row], quiet, { uhaozuAutoReshelfPolicy: p });
const source = async (account, userId = uid, game = '1') => (await listBlacklistSourcesByUserAndAccounts(userId,
    [identity(account, game)], { active_only: false })).find((x) => x.source === 'platform_face_verify');
const seed = (account, detail, expire_at = future, userId = uid, game = '1') => upsertSourceAndReconcile(userId, identity(account, game),
    'platform_face_verify', { active: true, reason: '人脸识别', priority: 800, expire_at, detail });
const evidence = (platforms) => ({ platforms, reasons: platforms.map((platform) => ({ platform, reason: '账号人脸识别' })) });

async function main() {
    assert.deepStrictEqual(await reconcile(0, [face('invalid')], quiet), { touched: 0, activated: 0, released: 0 });
    assert.deepStrictEqual(await reconcile(uid, [], quiet), { touched: 0, activated: 0, released: 0 });
    await apply(face('new-face'));
    assert.strictEqual(await source('new-face'), undefined, 'configured Uhaozu face must not create a blacklist');
    await apply(face('new-face', ['uhaozu'], '账号人脸识别：'));
    assert.strictEqual(await source('new-face'), undefined);
    await apply(face('hard-face', ['uhaozu'], '账号人脸识别：需人工解封'));
    assert((await source('hard-face')).active);
    await seed('old-face', evidence(['uhaozu']));
    await seed('old-face', evidence(['uhaozu']), future, uid + 1);
    await seed('old-face', evidence(['uhaozu']), future, uid, '2');
    const old = await apply(face('old-face'));
    assert.strictEqual(old.released, 1);
    assert.strictEqual((await source('old-face')).active, false);
    assert.strictEqual((await source('old-face')).detail.release_by, 'uhaozu_auto_reshelf_config');
    assert.strictEqual((await source('old-face')).detail.manual_suppressed_platforms, undefined);
    assert((await source('old-face', uid + 1)).active, 'other user remains isolated');
    assert((await source('old-face', uid, '2')).active, 'other game remains isolated');
    assert.strictEqual((await apply(face('old-face'))).touched, 0, 'release is idempotent');
    await apply(face('old-face'), disabled);
    assert((await source('old-face')).active, 'removing configuration restores face restrictions');
    await apply(face('old-face'));
    assert.strictEqual((await source('old-face')).active, false);

    await seed('manual', evidence(['uhaozu']));
    await upsertSourceAndReconcile(uid, identity('manual'), 'manual_maintenance', { active: true, reason: '维护中' });
    await apply(face('manual'));
    const projected = await listUserBlacklistByUserWithMeta(uid);
    assert.strictEqual(projected.find((x) => x.game_account === 'manual').reason, '维护中');

    await seed('mixed', evidence(['uhaozu', 'zuhaowang']));
    await apply(face('mixed'));
    let mixed = await source('mixed');
    assert(mixed.active);
    assert.strictEqual(mixed.expire_at, future);
    assert.deepStrictEqual(mixed.detail.platforms, ['zuhaowang']);
    assert.deepStrictEqual(mixed.detail.reasons, [{ platform: 'zuhaowang', reason: '账号人脸识别' }]);
    await apply(face('mixed'));
    assert.strictEqual((await source('mixed')).expire_at, future, 'Uhaozu recovery must not refresh another platform hold');
    await seed('mixed', mixed.detail, expired);
    await apply(face('mixed'));
    assert.strictEqual((await source('mixed')).active, false, 'other platform hold expires normally');

    await seed('mixed-live', evidence(['uhaozu', 'uuzuhao']));
    await apply(face('mixed-live', ['uhaozu', 'zuhaowang']));
    mixed = await source('mixed-live');
    assert.deepStrictEqual(new Set(mixed.detail.platforms), new Set(['uuzuhao', 'zuhaowang']));
    assert(mixed.active && mixed.detail.reasons.length === 2);

    await seed('expired-mixed', evidence(['uhaozu', 'uuzuhao']), expired);
    await apply(face('expired-mixed', ['uhaozu', 'zuhaowang']));
    assert.deepStrictEqual((await source('expired-mixed')).detail.platforms, ['zuhaowang']);
    await seed('expired-no-hit', evidence(['uhaozu', 'zuhaowang']), expired);
    await apply(face('expired-no-hit'));
    assert.strictEqual((await source('expired-no-hit')).active, false);

    for (const [account, detail] of [
        ['unknown', {}], ['bad-platforms', { platforms: 'uhaozu', reasons: evidence(['uhaozu']).reasons }],
        ['bad-reasons', { platforms: ['uhaozu'], reasons: 'unknown' }],
        ['unapproved-prior', { platforms: ['uhaozu'], reasons: [{ platform: 'uhaozu', reason: '账号人脸识别：人工审核中' }] }]
    ]) {
        await seed(account, detail);
        await apply(face(account));
        assert((await source(account)).active, account);
    }
    await seed('unknown-piece', { platforms: ['uhaozu'], reasons: [...evidence(['uhaozu']).reasons, null] });
    await apply(face('unknown-piece'));
    assert((await source('unknown-piece')).active, 'unattributed evidence is preserved');
    await seed('no-reasons', { platforms: ['uhaozu'] });
    await apply(face('no-reasons'));
    assert.strictEqual((await source('no-reasons')).active, false, 'known Uhaozu platform plus current allowed reason is sufficient');
    await seed('reason-only', { reasons: evidence(['uhaozu']).reasons });
    await apply(face('reason-only'));
    assert.strictEqual((await source('reason-only')).active, false);
    await seed('no-expiry-mixed', evidence(['uhaozu', 'zuhaowang']), '');
    await apply(face('no-expiry-mixed'));
    assert((await source('no-expiry-mixed')).active);
    assert.strictEqual((await source('no-expiry-mixed')).expire_at, '');
    await seed('suppressed', { ...evidence(['uhaozu']), manual_suppressed_platforms: ['uhaozu'] });
    await apply(face('suppressed'));
    assert.deepStrictEqual((await source('suppressed')).detail.manual_suppressed_platforms, ['uhaozu']);
    await apply(face('suppressed'), disabled);
    assert.strictEqual((await source('suppressed')).active, false, 'existing manual intent remains independent');
    await apply(face('other-platform', ['zuhaowang']));
    assert((await source('other-platform')).active);
    const unavailable = await loadUhaozuAutoReshelfPolicy({ getConfig: async () => ({ found: false }), logger: quiet });
    await apply(face('unavailable'), unavailable);
    assert((await source('unavailable')).active);
    console.log('[PASS] Uhaozu face configuration compatibility, provenance/TTL retention, rollback and account isolation');
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
