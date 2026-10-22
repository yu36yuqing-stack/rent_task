'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const v8toIstanbul = require('v8-to-istanbul');
const { createCoverageMap } = require('istanbul-lib-coverage');
const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'h5/public');
const outputDir = path.join(root, 'coverage/uuzuhao-online-auth');

async function main() {
    fs.mkdirSync(outputDir, { recursive: true });
    const launchErrors = [];
    let browser;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            browser = await puppeteer.launch({
                executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
                headless: true,
                args: ['--disable-crash-reporter', '--disable-breakpad']
            });
            break;
        } catch (error) {
            launchErrors.push(error.message);
            if (attempt === 2) throw error;
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    }
    const errors = [], requests = [], results = [];
    let onlineResult = { status: 502, body: { ok: false, message: '在线查询失败: code=201010027',
        data: { uuzuhao_auth_state: { required: true, version: 2 } } } };
    let forbiddenResult = { status: 200, body: { ok: true, data: { enabled: false } } };
    let holdOnline = false;
    let heldOnline = null;
    try {
        const page = await browser.newPage();
        await page.coverage.startJSCoverage({ resetOnNavigation: false, includeRawScriptCoverage: true });
        page.on('pageerror', error => errors.push(error.message));
        page.on('dialog', dialog => dialog.dismiss());
        await page.setRequestInterception(true);
        page.on('request', request => {
            const pathname = decodeURIComponent(new URL(request.url()).pathname);
            if (pathname.startsWith('/api/')) {
                requests.push({ pathname, body: JSON.parse(request.postData() || '{}') });
                if (pathname === '/api/products/online' && holdOnline) {
                    heldOnline = request;
                    return;
                }
                const result = pathname === '/api/products/online' ? onlineResult
                    : pathname === '/api/products/forbidden/query' ? forbiddenResult
                        : { status: 503, body: { ok: false, message: 'unexpected fixture request' } };
                return request.respond({ status: result.status, contentType: 'application/json', body: JSON.stringify(result.body) });
            }
            const file = path.resolve(publicDir, `.${pathname === '/' ? '/index.html' : pathname}`);
            if (!file.startsWith(publicDir + '/') || !fs.existsSync(file) || !fs.statSync(file).isFile()) return request.abort();
            const types = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' };
            return request.respond({ status: 200, contentType: types[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
        });
        await page.goto('http://online-auth.test/', { waitUntil: 'networkidle0' });
        async function fixture(game_id, game_name, marked, blacklisted = false, prodGuardEnabled = true) {
            await page.evaluate(({ game_id, game_name, marked, blacklisted, prodGuardEnabled }) => {
                state.user = { id: 16, account: 'fixture', name: 'Fixture' };
                state.token = 'fixture-only'; state.currentMenu = 'products'; state.gameName = game_name;
                state.onlineStatusMap = {}; state.onlineLoadingMap = {}; state.forbiddenLoadingMap = {};
                state.list = [{ game_id, game_name, game_account: '2256481878', display_name: '长名称账号仍须保留完整档位及渠道时租价',
                    uuzuhao_auth_state: { required: marked, version: 1 }, online_tag: '在线',
                    prod_guard_enabled: prodGuardEnabled, blacklisted, blacklist_reason: blacklisted ? '维护中' : '',
                    channel_status: { uuzuhao: '上架', uhaozu: '上架', zuhaowang: '租赁中' },
                    price_ladder: { uuzuhao: { current_tier: 3, desired_tier: 4, hour_price: 2.9 },
                        uhaozu: { current_tier: 1, hour_price: 2 }, zuhaowang: { current_tier: 2, hour_price: 3 } }, today_paid_count: 2 }];
                state.total = 1; render();
            }, { game_id, game_name, marked, blacklisted, prodGuardEnabled });
        }
        for (const width of [320, 375, 390, 430, 768, 1280]) {
            await page.setViewport({ width, height: 1000, deviceScaleFactor: 1 });
            for (const [gameId, gameName] of [['1', 'WZRY'], ['2', 'HPJY'], ['3', 'CFM'], ['4', 'CSGO']]) {
                for (const blacklisted of [false, true]) {
                    await fixture(gameId, gameName, true, blacklisted);
                    const layout = await page.evaluate(() => {
                        const card = document.querySelector('#listView .product-card');
                        const badges = [...card.querySelectorAll('.platforms .plat')];
                        return { width: innerWidth, documentWidth: document.documentElement.scrollWidth,
                            badges: badges.map(b => b.textContent.trim()), top: card.querySelector('.card-top-chips').textContent.trim(),
                            online: card.querySelector('[data-slot="online-chip"]').textContent.trim(),
                            abnormalColor: getComputedStyle(badges[0]).color,
                            topClipped: [...card.querySelectorAll('.card-top-chips .chip')].some(b => b.scrollWidth > b.clientWidth + 1),
                            clipped: badges.some(b => b.scrollWidth > b.clientWidth + 1),
                            outOfBounds: badges.some(b => { const r = b.getBoundingClientRect(), p = b.closest('.info-square').getBoundingClientRect(); return r.left < p.left || r.right > p.right + 1; }) };
                    });
                    assert.strictEqual(layout.badges[0], '悠悠: 授权异常 · 3档 · ¥2.90/时');
                    assert.strictEqual(layout.badges[1], 'U号: 上架 · 1档 · ¥2.00/时');
                    assert.strictEqual(layout.badges[2], 'ZHW: 租赁中 · 2档 · ¥3.00/时');
                    assert.ok(layout.top.includes('需重新授权'));
                    assert.ok(!layout.top.includes('状态正常'));
                    if (blacklisted) assert.ok(layout.top.includes('维护中'));
                    assert.strictEqual(layout.online, '');
                    assert.strictEqual(layout.abnormalColor, 'rgb(181, 66, 59)');
                    assert.ok(layout.documentWidth <= width && !layout.clipped && !layout.outOfBounds, JSON.stringify(layout));
                    assert.ok(!layout.topClipped, 'main status and authorization labels must remain readable: ' + JSON.stringify(layout));
                    results.push({ width, gameName, blacklisted, ...layout });
                    if (gameId === '1' && [390, 1280].includes(width)) {
                        await page.screenshot({ path: path.join(outputDir, `auth-${width}${blacklisted ? '-maintenance' : ''}.png`), fullPage: true });
                    }
                }
            }
        }
        assert.deepStrictEqual(requests, [], 'rendering marked accounts must not automatically call an API');
        await page.click('[data-op="uuzuhao-auth-detail"]');
        assert.ok(await page.evaluate(() => document.querySelector('.toast').textContent.includes('号主前往悠悠租号重新授权')));

        await fixture('1', 'WZRY', false);
        await page.evaluate(() => queryStatus(state.list[0]));
        assert.strictEqual(await page.evaluate(() => state.list[0].uuzuhao_auth_state.required), true);
        assert.ok(await page.evaluate(() => document.querySelector('.status-main-chip').textContent.includes('需重新授权')));
        assert.strictEqual(requests.length, 2);
        assert.ok(requests.every(r => r.body.game_id === '1' && r.body.game_account === '2256481878'));
        onlineResult = { status: 200, body: { ok: true, data: { online: false,
            uuzuhao_auth_state: { required: false, version: 3 } } } };
        forbiddenResult = { status: 502, body: { ok: false, message: '禁玩查询失败: HTTP 504: 访问超时' } };
        await page.evaluate(() => queryStatus(state.list[0]));
        assert.strictEqual(await page.evaluate(() => state.list[0].uuzuhao_auth_state.required), false);
        assert.strictEqual(await page.$('[data-op="uuzuhao-auth-detail"]'), null);
        assert.ok(await page.evaluate(() => document.querySelector('.status-main-chip').textContent.includes('状态正常')));
        forbiddenResult = { status: 200, body: { ok: true, data: { enabled: false } } };
        await fixture('1', 'WZRY', true, false, false);
        await page.evaluate(() => queryStatus(state.list[0]));
        assert.strictEqual(await page.evaluate(() => state.list[0].uuzuhao_auth_state.required), false);
        assert.strictEqual(await page.evaluate(() => state.list[0].prod_guard_enabled), false, 'manual recovery must not toggle the user switch');
        assert.ok(requests.filter(r => r.pathname === '/api/products/online').length === 3);
        await fixture('1', 'WZRY', false);
        holdOnline = true;
        await page.evaluate(() => { window.pendingAuthQuery = queryStatus(state.list[0]); });
        for (let attempt = 0; attempt < 100 && !heldOnline; attempt++) await new Promise(resolve => setTimeout(resolve, 20));
        assert.ok(heldOnline, 'the old user request must be in flight');
        await page.evaluate(() => {
            state.user = { id: 12, account: 'other-fixture' };
            state.list[0].uuzuhao_auth_state = { required: false, version: 0 };
            state.onlineLoadingMap['1::2256481878'] = true;
        });
        await heldOnline.respond({ status: 502, contentType: 'application/json', body: JSON.stringify({ ok: false,
            message: 'old user error', data: { uuzuhao_auth_state: { required: true, version: 9 } } }) });
        await page.evaluate(() => window.pendingAuthQuery);
        assert.strictEqual(await page.evaluate(() => state.list[0].uuzuhao_auth_state.required), false);
        assert.strictEqual(await page.evaluate(() => state.onlineLoadingMap['1::2256481878']), true, 'old user cleanup must not alter the new user loading state');
        assert.deepStrictEqual(errors, []);
        const browserCoverage = createCoverageMap({});
        for (const entry of await page.coverage.stopJSCoverage()) {
            const pathname = new URL(entry.url).pathname;
            if (!['/js/app_core.js', '/js/menu_products.js', '/js/ui/uuzuhao_auth_status.js'].includes(pathname)) continue;
            const file = path.resolve(publicDir, '.' + pathname);
            assert.strictEqual(entry.text, fs.readFileSync(file, 'utf8'), 'coverage must match the actual application source');
            const converter = v8toIstanbul(file, 0, { source: entry.text });
            await converter.load();
            converter.applyCoverage(entry.rawScriptCoverage.functions);
            browserCoverage.merge(converter.toIstanbul());
        }
        fs.writeFileSync(path.join(outputDir, 'browser-coverage.json'), JSON.stringify(browserCoverage.toJSON()));
        fs.writeFileSync(path.join(outputDir, 'visual-results.json'), JSON.stringify({ layouts: results, requests, errors,
            browser_setup_retries: launchErrors.length, browser_setup_errors: launchErrors }, null, 2) + '\n');
        console.log(`[PASS] online auth visual: ${results.length} viewport/game/status combinations; first failure and manual recovery with real request/UI code`);
    } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
