'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-online-auth-h5-'));
for (const name of ['MAIN', 'RUNTIME', 'ORDER', 'STATS', 'PRICE']) process.env[`${name}_DB_FILE_PATH`] = path.join(dir, `${name}.db`);
process.env.H5_PORT = '0';
process.env.SHEEP_FIX_ENABLE = '0';
process.env.BL_V2_INSPECTOR_ENABLE = '0';
const { createUserByAdmin } = require('../database/user_db');
const { upsertUserGameAccount, updateUserGameAccountOnlineProbeSnapshot } = require('../database/user_game_account_db');
const { upsertUserPlatformAuth } = require('../database/user_platform_auth_db');
const { recordUuzuhaoAuthObservation, getUuzuhaoAuthState } = require('../database/uuzuhao_auth_state_db');
const { createAccessToken } = require('../user/auth_token');
const { bootstrap } = require('../h5/local_h5_server');
const { stopProdRiskTaskWorker } = require('../product/prod_status_guard');
const identity = { game_account: '2256481878', game_id: '1', game_name: 'WZRY' };
const auth = { app_key: 'fixture', app_secret: 'fixture', api_base: 'https://fixture.invalid' };
const realFetch = global.fetch;
const failureCode = Number(process.env.ONLINE_AUTH_FAILURE_CODE || 201010027);
const failureReason = failureCode === 12101001 ? '悠悠商品不存在' : 'QQ鉴权失败';
let response = { code: failureCode, msg: failureCode === 12101001 ? '商品不存在' : '查询失败，请稍后重试' };
const calls = [];
global.fetch = async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, options);
    assert.ok(String(url).startsWith(auth.api_base));
    calls.push({ url: String(url), body: JSON.parse(options.body) });
    return { ok: true, status: 200, text: async () => JSON.stringify(response) };
};
async function main() {
    let server;
    try {
        const user = await createUserByAdmin({ account: 'online-auth-fixture', password: 'fixture-only', user_type: '内部', status: 'enabled' });
        const other = await createUserByAdmin({ account: 'online-auth-other', password: 'fixture-only', user_type: '内部', status: 'enabled' });
        await upsertUserGameAccount({ user_id: user.id, ...identity, channel_status: { uuzuhao: '上架', uhaozu: '上架' } });
        await upsertUserGameAccount({ user_id: user.id, ...identity, game_id: '2', game_name: 'HPJY' });
        await upsertUserGameAccount({ user_id: other.id, ...identity });
        await upsertUserPlatformAuth({ user_id: user.id, platform: 'uuzuhao', auth_type: 'token', auth_status: 'valid', auth_payload: auth });
        await updateUserGameAccountOnlineProbeSnapshot(user.id, identity.game_account, { ...identity, online: true });
        server = await bootstrap();
        const base = `http://127.0.0.1:${server.address().port}`;
        const headers = { Authorization: `Bearer ${createAccessToken(user)}`, 'Content-Type': 'application/json' };
        async function query(endpoint = '/api/products/online') {
            const res = await fetch(base + endpoint, { method: 'POST', headers, body: JSON.stringify(identity) });
            return { status: res.status, body: await res.json() };
        }
        async function list(owner = user) {
            const res = await fetch(base + '/api/products?game_name=ALL&page_size=20', { headers: { Authorization: `Bearer ${createAccessToken(owner)}` } });
            const body = await res.json();
            assert.strictEqual(res.status, 200, JSON.stringify(body));
            return body.list;
        }
        const failure = await query();
        assert.strictEqual(failure.status, 502);
        assert.ok(failure.body.message.includes(String(failureCode)));
        assert.strictEqual(failure.body.data.uuzuhao_auth_state.required, true);
        assert.strictEqual(failure.body.data.uuzuhao_auth_state.error_code, String(failureCode));
        assert.strictEqual(failure.body.data.uuzuhao_auth_state.reason, failureReason);
        const rows = await list();
        const marked = rows.find(r => r.game_id === '1');
        assert.strictEqual(marked.uuzuhao_auth_state.required, true);
        assert.strictEqual(marked.online_tag, '', 'stale online status must not be presented as current');
        assert.strictEqual(marked.channel_status.uuzuhao, '上架', 'real channel shelf status is not rewritten');
        assert.strictEqual(rows.find(r => r.game_id === '2').uuzuhao_auth_state.required, false);
        assert.strictEqual((await list(other))[0].uuzuhao_auth_state.required, false);
        const secondFailure = await query();
        assert.strictEqual(secondFailure.status, 502);
        assert.strictEqual(calls.length, 2, 'manual retries still reach the upstream endpoint');
        response = { code: 85004, msg: '访问超时，请稍后再重试' };
        const timeout = await query('/api/products/forbidden/query');
        assert.strictEqual(timeout.status, 502);
        assert.ok(timeout.body.message.includes('85004'));
        assert.strictEqual((await getUuzuhaoAuthState(user.id, identity)).required, true, 'forbidden results never clear online auth state');
        response = { code: 0, data: { gameOnline: false, enabled: false } };
        const success = await query();
        assert.strictEqual(success.status, 200);
        assert.strictEqual(success.body.data.online, false);
        assert.strictEqual(success.body.data.uuzuhao_auth_state.required, false);
        assert.strictEqual((await list()).find(r => r.game_id === '1').online_tag, '离线');
        response = { code: 85004, msg: '访问超时' };
        assert.strictEqual((await query()).status, 502);
        assert.strictEqual((await getUuzuhaoAuthState(user.id, identity)).required, false);
        for (const code of [201010027, 12101001]) {
            response = { code, msg: '禁玩查询失败' };
            assert.strictEqual((await query('/api/products/forbidden/query')).status, 502);
            assert.strictEqual((await getUuzuhaoAuthState(user.id, identity)).required, false, 'forbidden failures must not mark online authorization');
        }
        for (const code of ['12115014', '12115012']) {
            await recordUuzuhaoAuthObservation(user.id, identity, {
                required: true, error_code: code, reason: 'shelf authorization failure', request_started_at: Date.now()
            });
            response = { code: 0, data: { gameOnline: false, enabled: false } };
            const successWithShelfFailure = await query();
            assert.strictEqual(successWithShelfFailure.status, 200);
            assert.strictEqual(successWithShelfFailure.body.data.uuzuhao_auth_state.required, true);
            assert.strictEqual(successWithShelfFailure.body.data.uuzuhao_auth_state.error_code, code);
            assert.strictEqual((await list()).find(r => r.game_id === '1').online_tag, '', 'manual online success must not present a shelf failure as recovered');
            await require('../product/uuzuhao_shelf_auth_service').recoverShelfAuthByProduct(user.id, {
                ...identity, status: '上架', prd_info: { prd_id: 'fixture-product' }
            }, Date.now());
            assert.strictEqual((await getUuzuhaoAuthState(user.id, identity)).required, false);
        }
        await recordUuzuhaoAuthObservation(user.id, identity, { required: true, request_started_at: Date.now() + 10000 });
        response = { code: 0, data: { gameOnline: true } };
        assert.strictEqual((await query()).body.data.uuzuhao_auth_state.required, true, 'older response cannot clear newer marker');
        assert.ok(calls.every(c => c.body.accountId === identity.game_account && [1].includes(c.body.gameId)));
        console.log(`[PASS] online auth H5 (${failureCode}): structured failure, manual-only recovery, stale snapshot hiding, correct game identity and user isolation`);
    } finally {
        if (server) await new Promise(resolve => server.close(resolve));
        stopProdRiskTaskWorker();
        global.fetch = realFetch;
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
