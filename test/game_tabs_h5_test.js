'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const puppeteer = require('puppeteer-core');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-game-tabs-'));
for (const db of ['MAIN', 'ORDER', 'RUNTIME', 'STATS', 'PRICE']) {
    process.env[db + '_DB_FILE_PATH'] = path.join(tmp, db + '.db');
}
Object.assign(process.env, { H5_PORT: '0', H5_HOST: '127.0.0.1', SHEEP_FIX_ENABLE: 'false', BL_V2_INSPECTOR_ENABLE: 'false' });
const { bootstrap } = require('../h5/local_h5_server');
const { createUserByAdmin } = require('../database/user_db');
const { createAccessToken } = require('../user/auth_token');
const { stopProdRiskTaskWorker } = require('../product/prod_status_guard');

async function main() {
    const server = await bootstrap();
    const base = 'http://127.0.0.1:' + server.address().port;
    let browser;
    try {
        const user = await createUserByAdmin({ account: 'tabs-fixture', password: 'test-local-only', status: 'enabled', user_type: '内部' });
        browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
            args: ['--disable-crash-reporter', '--disable-breakpad'] });
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.setRequestInterception(true);
        page.on('request', req => req.url().startsWith(base + '/') && req.method() === 'GET' ? req.continue() : req.abort());
        await page.evaluateOnNewDocument(auth => sessionStorage.setItem('h5_auth_bundle', JSON.stringify(auth)),
            { token: createAccessToken(user), user: { id: user.id, account: user.account, user_type: user.user_type } });
        await page.coverage.startJSCoverage({ resetOnNavigation: false, includeRawScriptCoverage: true });
        const all = ['全部', '王者荣耀', 'GTA6', '和平精英', 'CS2', 'CFM'];
        const sold = all.filter(label => label !== 'GTA6');
        const pricing = sold.slice(1);
        for (const width of [375, 1280]) {
            await page.setViewport({ width, height: 850 });
            for (const [menu, scope, api, labels] of [
                ['products', 'product', '/api/products', all], ['products_sold', 'product', '/api/products', sold],
                ['orders', 'order', '/api/orders', all], ['stats', 'stats', '/api/stats/dashboard', all],
                ['pricing_uhaozu', 'pricing', '/api/pricing/ladder', pricing]
            ]) {
                await page.goto(base + '/?menu=' + menu, { waitUntil: 'networkidle0' });
                const tabs = '[data-' + scope + '-game]';
                await page.waitForSelector(tabs, { visible: true, timeout: 8000 });
                assert.deepEqual(await page.$$eval(tabs, nodes => nodes.map(n => n.textContent.trim())), labels);
                assert.equal(await page.$eval(tabs + '.active', n => n.textContent.trim()), labels[0]);
                const cs2 = '[data-' + scope + '-game="CSGO"]';
                const [response] = await Promise.all([
                    page.waitForResponse(r => {
                        const url = new URL(r.url());
                        return url.pathname === api && url.searchParams.get('game_name') === 'CSGO';
                    }, { timeout: 6000 }),
                    page.locator(cs2).click()
                ]);
                assert.equal(response.status(), 200);
                if (menu === 'products_sold') assert.equal(new URL(response.url()).searchParams.get('asset_status'), 'sold');
                await page.waitForSelector(cs2 + '.active');
                assert.equal(await page.$$eval(tabs + '.active', nodes => nodes.length), 1);
                assert(await page.$eval(cs2 + ' img', img => img.complete && img.naturalWidth > 0));
                assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
                console.log('[PASS]', width, menu, 'CS2 → CSGO');
            }
        }
        assert.deepEqual(errors, []);
        const scripts = await page.coverage.stopJSCoverage();
        if (process.env.NODE_V8_COVERAGE) {
            const filename = path.resolve(__dirname, '../h5/public/js/ui/game_tabs.js');
            const result = scripts.filter(s => new URL(s.url).pathname === '/js/ui/game_tabs.js')
                .map(s => ({ ...s.rawScriptCoverage, url: pathToFileURL(filename).href }));
            assert(result.length);
            fs.writeFileSync(path.join(process.env.NODE_V8_COVERAGE, 'coverage-game-tabs-browser.json'), JSON.stringify({ result }));
        }
    } finally {
        if (browser) await browser.close();
        stopProdRiskTaskWorker();
        await new Promise(resolve => server.close(resolve));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
