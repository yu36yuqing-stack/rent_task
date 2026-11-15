'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'coverage/order-search/test-logs');
fs.mkdirSync(output, { recursive: true });
const entries = [
    'order_search_backend_test.js', 'order_search_frontend_test.js', 'order_search_api_test.js',
    'run_order_game_info_refresh_tests.js', 'h5_auth_channel_toggle_smoke_test.js',
    'h5_account_order_off_config_smoke_test.js'
];
const guard = `
'use strict';
let denied=0;
const local=input=>{try {const host=typeof input==='object'&&!(input instanceof URL)&&!input.url
?String(input.hostname||input.host||'localhost'):new URL(String(input&&input.url||input)).hostname;
return ['localhost','127.0.0.1','::1','[::1]'].includes(host);}catch{return false;}};
const reject=()=>{denied++;throw new Error('order search suite forbids external HTTP');};
const fetch=global.fetch;
global.fetch=(...args)=>local(args[0])?fetch(...args):Promise.reject((()=>{try{reject();}catch(error){return error;}})());
for(const protocol of ['http','https'])for(const method of ['request','get']) {
const client=require(protocol),original=client[method];
client[method]=function(...args){if(!local(args[0]))reject();return original.apply(this,args);};}
process.on('exit',()=>{if(denied){console.error('[FAIL] external HTTP attempts: '+denied);process.exitCode=1;}});
`;
for (const entry of entries) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-order-search-'));
    const guardFile = path.join(dir, 'offline-guard.cjs');
    fs.writeFileSync(guardFile, guard);
    const env = { ...process.env, TZ: 'Asia/Shanghai', SHEEP_FIX_ENABLE: 'false', BL_V2_INSPECTOR_ENABLE: 'false',
        UUZUHAO_AUTO_REAUTHORIZE_ENABLED: '0', ORDER_COUNT_TRACE: 'false',
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --require=${guardFile}`.trim() };
    for (const key of ['MAIN', 'RUNTIME', 'ORDER', 'STATS', 'PRICE']) env[`${key}_DB_FILE_PATH`] = path.join(dir, `${key}.db`);
    try {
        const result = spawnSync(process.execPath, [path.join(__dirname, entry)], {
            cwd: root, env, encoding: 'utf8', maxBuffer: 40 * 1024 * 1024, timeout: 240000
        });
        fs.writeFileSync(path.join(output, `${entry}.log`), `${result.stdout || ''}${result.stderr || ''}`);
        if (result.status !== 0) {
            process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '');
            throw new Error(`${entry}: ${result.error || result.signal || result.status}`);
        }
        console.log(`[PASS] ${entry}`);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
console.log(`[PASS] order search: ${entries.length} isolated suite entries`);
