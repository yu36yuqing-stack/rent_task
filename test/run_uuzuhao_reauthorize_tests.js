'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const entries = ['uuzuhao_operation_lock_test.js', 'uuzuhao_reauthorize_test.js', 'run_uuzuhao_update_game_info_tests.js',
    'run_uuzuhao_online_auth_tests.js', 'run_uuzuhao_background_pause_tests.js', 'order_auth_revoke_smoke_test.js'];
const guardDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-recovery-guard-'));
const guardFile = path.join(guardDir, 'offline.cjs');
fs.writeFileSync(guardFile, `
'use strict';
let denied = 0;
const local = input => {
    try {
        const host = typeof input === 'object' && !(input instanceof URL) && !input.url
            ? new URL('http://' + String(input.hostname || input.host || 'localhost')).hostname
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
`);
try {
    for (const entry of entries) {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-recovery-suite-'));
        const env = { ...process.env, UUZUHAO_AUTO_REAUTHORIZE_ENABLED: '0', SHEEP_FIX_ENABLE: 'false',
            BL_V2_INSPECTOR_ENABLE: 'false', ORDER_COUNT_TRACE: 'false',
            NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${guardFile}`.trim() };
        for (const name of ['MAIN', 'RUNTIME', 'ORDER', 'STATS', 'PRICE']) env[`${name}_DB_FILE_PATH`] = path.join(dir, `${name}.db`);
        try {
            const result = spawnSync(process.execPath, [path.join(__dirname, entry)], { env, stdio: 'inherit', timeout: 240000 });
            if (result.status !== 0) throw new Error(`${entry}: ${result.error || result.signal || result.status}`);
        } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    }
} finally { fs.rmSync(guardDir, { recursive: true, force: true }); }
console.log(`[PASS] reauthorize: ${entries.length} suite entries`);
