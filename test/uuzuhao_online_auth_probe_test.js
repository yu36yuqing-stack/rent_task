'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-online-auth-probe-'));
for (const name of ['MAIN', 'RUNTIME', 'ORDER', 'STATS', 'PRICE']) process.env[`${name}_DB_FILE_PATH`] = path.join(dir, `${name}.db`);
const accounts = require('../database/user_game_account_db');
const { getUuzuhaoAuthState: read, recordUuzuhaoAuthObservation: record } = require('../database/uuzuhao_auth_state_db');
const probes = require('../product/prod_probe_cache_service');
const { deleteBlacklistWithGuard } = require('../blacklist/blacklist_release_guard');
const { upsertBlacklistSource, listBlacklistSourcesByUserAndAccounts } = require('../database/user_blacklist_source_db');
const auth = { app_key: 'fixture', app_secret: 'fixture', api_base: 'https://fixture.invalid' };
const key = { game_account: '2256481878', game_id: '1', game_name: 'WZRY' };
const opts = { auth, force_refresh: true, game_id: '1', game_name: 'WZRY' };
let response = { code: 201010027, msg: '查询失败，请稍后重试' };
let calls = 0;
const fetch = global.fetch;
global.fetch = async url => {
    assert.ok(String(url).startsWith(auth.api_base), 'external calls must be stubbed');
    calls++;
    return { ok: true, status: 200, text: async () => JSON.stringify(response) };
};
async function seed(uid = 16, gameId = '1') {
    await accounts.upsertUserGameAccount({ user_id: uid, ...key, game_id: gameId,
        game_name: gameId === '2' ? 'HPJY' : gameId === '3' ? 'CFM' : 'WZRY',
        channel_status: { uuzuhao: '上架' } });
}

async function main() {
    try {
        await seed(); await seed(12); await seed(16, '2');
        await assert.rejects(() => probes.queryOnlineStatusCached(16, key.game_account, opts), { code: '201010027' });
        assert.strictEqual((await read(16, key)).required, true);
        const before = calls;
        for (let i = 0; i < 4; i++) await assert.rejects(() => probes.queryOnlineStatusCached(16, key.game_account, opts), { code: 'UUZUHAO_AUTHORIZATION_PAUSED' });
        assert.strictEqual(calls, before, 'blocked probes must make zero requests');
        await accounts.updateUserGameAccountOnlineProbeSnapshot(16, key.game_account, { ...key, online: true });
        await assert.rejects(() => probes.queryOnlineStatusCached(16, key.game_account, { auth }), { code: 'UUZUHAO_AUTHORIZATION_PAUSED' });
        assert.strictEqual(calls, before, 'an old successful cache cannot bypass the marker');
        await upsertBlacklistSource(16, key, 'manual', { active: true, reason: 'manual' });
        const blocked = await deleteBlacklistWithGuard(16, key);
        assert.strictEqual(blocked.blocked_reason, '等待授权恢复');
        assert.strictEqual(calls, before, 'blacklist release must not retry online queries');
        assert.ok((await listBlacklistSourcesByUserAndAccounts(16, [key])).some(r => r.active));
        await assert.rejects(() => probes.queryOnlineStatusCached(16, key.game_account, { ...opts, manual: true }), { code: '201010027' });
        assert.strictEqual((await read(16, key)).required, true);

        response = { code: 85004, msg: '访问超时，请稍后再重试' };
        await assert.rejects(() => probes.queryOnlineStatusCached(12, key.game_account, opts), { code: '85004' });
        assert.strictEqual((await read(12, key)).required, false, 'timeouts do not require reauthorization');
        await assert.rejects(() => probes.queryForbiddenStatusCached(12, key.game_account, opts), { code: '85004' });
        assert.strictEqual((await read(12, key)).required, false, 'forbidden query failures do not mark online authorization');
        response = { code: 201010027, msg: '查询失败' };
        await assert.rejects(() => probes.queryForbiddenStatusCached(12, key.game_account, opts), { code: '201010027' });
        assert.strictEqual((await read(12, key)).required, false, 'the code must be scoped to the online endpoint');

        response = { code: 0, data: { gameOnline: false, enabled: false } };
        const otherUser = await probes.queryOnlineStatusCached(12, key.game_account, opts);
        assert.strictEqual(otherUser.online, false);
        await probes.queryOnlineStatusCached(16, key.game_account, { ...opts, game_id: '2', game_name: 'HPJY' });
        assert.strictEqual((await read(16, key)).required, true);
        const forbidden = await probes.queryForbiddenStatusCached(12, key.game_account, opts);
        assert.strictEqual(forbidden.enabled, false);
        const beforeCache = calls;
        const forbiddenCached = await probes.queryForbiddenStatusCached(12, key.game_account, { auth });
        assert.strictEqual(forbiddenCached.cached, true);
        assert.strictEqual(forbiddenCached.enabled, false);
        assert.strictEqual(calls, beforeCache, 'forbidden cache remains functional');
        const forbiddenSet = await probes.setForbiddenPlayWithSnapshot(16, key.game_account, false, { ...opts, manual: true });
        assert.strictEqual(forbiddenSet.type, 2);
        assert.strictEqual((await read(16, key)).required, true, 'a successful forbidden operation cannot validate online authorization');
        const cached = await probes.queryOnlineStatusCached(16, key.game_account, { auth, manual: true });
        assert.strictEqual(cached.cached, true);
        assert.strictEqual((await read(16, key)).required, true, 'cached manual results cannot clear a marker');
        const recovered = await probes.queryOnlineStatusCached(16, key.game_account, { ...opts, manual: true });
        assert.strictEqual(recovered.online, false, 'successful offline result is a successful validation');
        assert.strictEqual(recovered.uuzuhao_auth_state.required, false);
        assert.strictEqual((await read(16, key)).required, false);
        await probes.queryOnlineStatusCached(16, key.game_account, opts);

        response = { code: -50000, msg: 'QQ鉴权失败，请稍候再试。' };
        await assert.rejects(() => probes.queryOnlineStatusCached(16, key.game_account, opts), { code: '-50000' });
        assert.strictEqual((await read(16, key)).error_code, '-50000');
        await seed(16, '3');
        const unsupported = { ...key, game_id: '3', game_name: 'CFM' };
        await record(16, unsupported, { required: true, request_started_at: 1 });
        const beforeSkip = calls;
        const skip = await probes.queryOnlineStatusCached(16, key.game_account, { ...opts, manual: true, game_id: '3', game_name: 'CFM' });
        assert.strictEqual(skip.skipped, true);
        assert.strictEqual((await read(16, unsupported)).required, true, 'unsupported skip is not an authorization validation');
        assert.strictEqual(calls, beforeSkip);
        response = { code: 0, data: { gameOnline: false } };
        await probes.queryOnlineStatusCached(16, key.game_account, { ...opts, manual: true });
        let releaseOld;
        const stub = global.fetch;
        global.fetch = url => {
            if (!releaseOld) return new Promise(resolve => { releaseOld = resolve; });
            return stub(url);
        };
        const oldFailure = probes.queryOnlineStatusCached(16, key.game_account, opts);
        const oldRejected = assert.rejects(() => oldFailure, { code: '201010027' });
        while (!releaseOld) await new Promise(resolve => setImmediate(resolve));
        await probes.queryOnlineStatusCached(16, key.game_account, { ...opts, manual: true });
        releaseOld({ ok: true, status: 200, text: async () => JSON.stringify({ code: 201010027, msg: 'late response' }) });
        await oldRejected;
        assert.strictEqual((await read(16, key)).required, false, 'a real delayed failure must not undo manual recovery');
        global.fetch = stub;
        console.log('[PASS] online auth probe: one failure blocks all background online entries; manual-only recovery; timeout/forbidden isolation');
    } finally { global.fetch = fetch; }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
