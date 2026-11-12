'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const logs = path.join(root, 'coverage/order-game-info-refresh/test-logs');
fs.mkdirSync(logs, { recursive: true });
const tests = [...new Set([
    'order_game_info_refresh_policy_test.js',
    'order_game_info_refresh_db_test.js',
    'order_game_info_refresh_service_test.js',
    'order_game_info_refresh_worker_test.js',
    'order_game_info_refresh_integration_test.js',
    'price_ladder_feature_gate_smoke_test.js',
    'five_e_order_sync_smoke_test.js',
    'platform_channel_toggle_smoke_test.js',
    'uhaozu_order_detail_smoke_test.js',
    'uhaozu_pending_status_smoke_test.js',
    'order_account_order_off_reconcile_smoke_test.js',
    'order_cooldown_config_smoke_test.js',
    'order_cooldown_release_smoke_test.js',
    'product_order_service_regression_smoke_test.js',
    'runtime_task_smoke_test.js',
    'price_ladder_count_mode_smoke_test.js',
    'order_rule_service_smoke_test.js',
    'order_query_service_smoke_test.js',
    'order_command_service_smoke_test.js',
    'order_auth_revoke_smoke_test.js',
    'order_stats_refresh_policy_smoke_test.js',
    'runtime_db_split_smoke_test.js',
    'schema_migration_smoke_test.js',
    'uuzuhao_update_game_info_api_test.js',
    'merge_code_sqlite_exclusion_test.js'
])];

// 允许本地HTTP夹具，拒绝未被桩替换的第三方调用；对子进程同样生效。
const guard = `
'use strict';
let denied = 0;
const local = input => {
    try {
        const host = typeof input === 'object' && !(input instanceof URL) && !input.url
            ? String(input.hostname || input.host || 'localhost')
            : new URL(String(input && input.url || input)).hostname;
        return ['localhost','127.0.0.1','::1','[::1]'].includes(host);
    } catch { return false; }
};
const reject = () => { denied++; throw new Error('offline suite forbids external HTTP'); };
const fetch = global.fetch;
global.fetch = (...args) => local(args[0]) ? fetch(...args) : Promise.reject((() => { try { reject(); } catch(error) { return error; } })());
for (const protocol of ['http','https']) {
    const client = require(protocol);
    for (const method of ['request','get']) {
        const original = client[method];
        client[method] = function(...args) { if(!local(args[0])) reject(); return original.apply(this,args); };
    }
}
process.on('exit', () => { if(denied) { console.error('[FAIL] unexpected external HTTP attempts: '+denied); process.exitCode=1; } });
`;

for (const name of tests) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-order-game-info-'));
    const guardFile = path.join(dir, 'offline-guard.cjs');
    fs.writeFileSync(guardFile, guard);
    const env = { ...process.env, TZ: 'Asia/Shanghai', SHEEP_FIX_ENABLE: 'false',
        BL_V2_INSPECTOR_ENABLE: 'false', ORDER_COUNT_TRACE: 'false',
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${guardFile}`.trim() };
    for (const key of ['MAIN', 'RUNTIME', 'ORDER', 'STATS', 'PRICE']) env[`${key}_DB_FILE_PATH`] = path.join(dir, `${key}.db`);
    try {
        const result = spawnSync(process.execPath, [path.join(__dirname, name)], {
            cwd: root, env, encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, timeout: 120000
        });
        fs.writeFileSync(path.join(logs, `${name}.log`), `${result.stdout || ''}${result.stderr || ''}`);
        if (result.status !== 0) {
            process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
            throw new Error(`${name}: ${result.error || result.signal || result.status}`);
        }
        console.log(`[PASS] ${name}`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
console.log(`[PASS] order game info refresh: ${tests.length} isolated entries passed`);
