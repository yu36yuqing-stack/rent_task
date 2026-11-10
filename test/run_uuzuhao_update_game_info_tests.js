'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const logs = path.join(root, 'coverage/uuzuhao-update-game-info/test-logs');
fs.mkdirSync(logs, { recursive: true });
const tests = [
    'uuzuhao_update_game_info_api_test.js',
    'uuzuhao_modify_price_api_smoke_test.js',
    'uuzuhao_auth_revoke_smoke_test.js',
    'uuzuhao_game_mapping_smoke_test.js',
    'uuzuhao_auth_abnormal_mapping_smoke_test.js'
];

for (const test of tests) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-uuzuhao-game-info-'));
    const env = { ...process.env, SHEEP_FIX_ENABLE: 'false', BL_V2_INSPECTOR_ENABLE: 'false' };
    for (const key of ['MAIN', 'RUNTIME', 'ORDER', 'STATS', 'PRICE']) {
        env[`${key}_DB_FILE_PATH`] = path.join(dir, `${key}.db`);
    }
    // 夹具自行替换 fetch；任何漏网的真实 HTTP 请求都直接失败。
    const setup = `const blocked = () => { throw new Error('offline suite forbids real HTTP'); };
        global.fetch = async () => blocked();
        for (const protocol of ['http', 'https']) {
            const client = require(protocol); client.request = blocked; client.get = blocked;
        }
        require(${JSON.stringify(path.join(__dirname, test))});`;
    try {
        const result = spawnSync(process.execPath, ['-e', setup], {
            cwd: root, env, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024, timeout: 60000
        });
        fs.writeFileSync(path.join(logs, `${test}.log`), `${result.stdout || ''}${result.stderr || ''}`);
        if (result.status !== 0) {
            process.stdout.write(result.stdout || '');
            process.stderr.write(result.stderr || '');
            throw new Error(`${test}: ${result.error || result.signal || result.status}`);
        }
        console.log(`[PASS] ${test}`);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
console.log(`[PASS] uuzuhao update game info: ${tests.length} offline entries passed`);
