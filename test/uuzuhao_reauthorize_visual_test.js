'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const directory = path.resolve(__dirname, '../coverage/uuzuhao-reauthorize');
const publicDir = path.resolve(__dirname, '../h5/public');
async function main() {
    fs.mkdirSync(directory, { recursive: true });
    const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: true, args: ['--disable-crash-reporter', '--disable-breakpad'] });
    try {
        const page = await browser.newPage();
        const errors = [], results = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.setRequestInterception(true);
        page.on('request', request => {
            const pathname = new URL(request.url()).pathname;
            if (pathname.startsWith('/api/')) return request.respond({ status: 503, contentType: 'application/json', body: '{"ok":false}' });
            const file = path.resolve(publicDir, `.${pathname === '/' ? '/index.html' : pathname}`);
            if (!file.startsWith(publicDir + '/') || !fs.existsSync(file) || !fs.statSync(file).isFile()) return request.abort();
            const mime = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml' };
            return request.respond({ status: 200, contentType: mime[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
        });
        await page.goto('http://recovery.test/', { waitUntil: 'networkidle0' });
        for (const width of [320, 375, 1365]) {
            await page.setViewport({ width, height: 1000 });
            for (const [game_id, game_name] of [['1','WZRY'], ['2','HPJY'], ['3','CFM'], ['4','CSGO']]) {
                for (const stage of ['waiting_result', 'manual_required']) {
                    await page.evaluate(({ game_id, game_name, stage }) => {
                        state.user = { id: 8, account: 'fixture' }; state.token = 'fixture';
                        state.currentMenu = 'products'; state.gameName = game_name;
                        state.list = [{ game_id, game_name, game_account: '123456789', display_name: '长名称账号：授权异常恢复状态',
                            uuzuhao_auth_state: { required: true, error_code: '12115012', version: 1 },
                            uuzuhao_recovery: { stage, query_count: stage === 'manual_required' ? 3 : 1 },
                            channel_status: { uuzuhao: '下架', uhaozu: '上架', zuhaowang: '下架' },
                            price_ladder: { uuzuhao: { current_tier: 2, hour_price: 2.5 } },
                            today_paid_count: 0, blacklisted: true, blacklist_reason: '维护中', prod_guard_enabled: false }];
                        state.total = 1; render();
                    }, { game_id, game_name, stage });
                    const layout = await page.evaluate(() => {
                        const badges = [...document.querySelectorAll('#listView .platforms .plat')];
                        return { width: innerWidth, documentWidth: document.documentElement.scrollWidth,
                            text: badges[0].textContent, top: document.querySelector('#listView .card-top-chips').textContent,
                            clipped: badges.some(b => b.scrollWidth > b.clientWidth + 1) };
                    });
                    assert.ok(layout.text.includes(stage === 'manual_required' ? '需人工介入' : '已查询1/3次'), layout.text);
                    assert.ok(layout.text.includes('2档 · ¥2.50/时'));
                    assert.ok(layout.top.includes('维护中'), 'the original maintenance reason must stay visible');
                    assert.strictEqual(layout.documentWidth <= width, true, JSON.stringify(layout));
                    assert.strictEqual(layout.clipped, false, JSON.stringify(layout));
                    results.push({ game_id, stage, ...layout });
                    if (game_id === '1') await page.screenshot({ path: path.join(directory, `${stage}-${width}.png`), fullPage: true });
                }
            }
        }
        assert.deepStrictEqual(errors, []);
        fs.writeFileSync(path.join(directory, 'visual-results.json'), JSON.stringify(results, null, 2));
        console.log(`[PASS] recovery visual: ${results.length} mobile/desktop, four-game, progress/manual layouts`);
    } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
