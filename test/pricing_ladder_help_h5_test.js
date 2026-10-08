'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-pricing-help-'));
for (const name of ['MAIN', 'PRICE', 'ORDER', 'RUNTIME', 'STATS']) {
    process.env[`${name}_DB_FILE_PATH`] = path.join(temp, `${name}.db`);
}
Object.assign(process.env, { SHEEP_FIX_ENABLE: '0', BL_V2_INSPECTOR_ENABLE: '0',
    ORDER_COUNT_TRACE: 'false', H5_PORT: '0' });
const { createUserByAdmin } = require('../database/user_db');
const { upsertUserGameAccount } = require('../database/user_game_account_db');
const { createAccessToken } = require('../user/auth_token');
const { bootstrap } = require('../h5/local_h5_server');
const { stopProdRiskTaskWorker } = require('../product/prod_status_guard');
const puppeteer = require('puppeteer-core');

async function main() {
    const user = await createUserByAdmin({ account: 'pricing_help', password: 'local-fixture', status: 'enabled', user_type: '内部' });
    const games = [['1', 'WZRY'], ['2', '和平精英'], ['3', 'CFM'], ['4', 'CSGO']];
    for (const [game_id, game_name] of games) {
        await upsertUserGameAccount({ user_id: user.id, game_id, game_name,
            game_account: `help-${game_id}`, account_remark: '测试长名称账号无需重复展示档位订单数',
            channel_prd_info: { uhaozu: { prd_id: `u-${game_id}` } } });
    }
    const server = await bootstrap();
    const base = `http://127.0.0.1:${server.address().port}`;
    let browser;
    try {
        browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
        const page = await browser.newPage(), errors = [], writes = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.coverage.startJSCoverage({ resetOnNavigation: false, includeRawScriptCoverage: true });
        await page.setRequestInterception(true);
        page.on('request', request => {
            if (!request.url().startsWith(base)) return request.abort();
            if (request.url().includes('/api/') && request.method() !== 'GET') {
                writes.push(request.url());
                return request.abort();
            }
            return request.continue();
        });
        await page.goto(base);
        const token = createAccessToken(user);
        await page.evaluate(bundle => localStorage.setItem('h5_auth_bundle', bundle), JSON.stringify({ token, access_token: token, user }));
        await page.goto(`${base}/?menu=pricing_uhaozu`);
        await page.waitForSelector('[data-pricing-account-card="help-1"]', { visible: true });
        const directory = path.resolve('coverage/daily-price-policy');
        fs.mkdirSync(directory, { recursive: true });
        for (const width of [375, 1365]) {
            await page.setViewport({ width, height: 900 });
            for (const [id, game] of games) {
                console.log(`[CHECK] pricing help game=${game} width=${width}`);
                await page.waitForSelector(`[data-pricing-game="${game}"]`, { visible: true });
                await page.click(`[data-pricing-game="${game}"]`);
                await page.waitForSelector(`[data-pricing-account-card="help-${id}"]`, { visible: true });
                assert.strictEqual(await page.$eval('#pricingWindowText', node => node.textContent), '订单周期：近24小时');
                assert.strictEqual(await page.$('.pricing-channel-note'), null);
                const labels = await page.$$eval('.pricing-tier-field > span', nodes => nodes.map(node => node.textContent));
                assert.deepStrictEqual(labels, ['1档时租价', '2档时租价', '3档时租价', '4档时租价']);
                const card = `[data-pricing-account-card="help-${id}"]`;
                assert((await page.$eval(card, node => node.textContent)).includes('近24h 0单'), 'keep actual order count');
                assert.strictEqual(await page.$eval('#pricingWindowHelpBtn', node => node.getAttribute('aria-expanded')), 'false');
                await page.click('#pricingWindowHelpBtn');
                await page.waitForSelector('#pricingWindowHelpSheet:not(.hidden)');
                const help = await page.$eval('#pricingWindowHelpSheet', node => node.textContent);
                for (const text of ['1档：0单', '2档：1单', '3档：2单', '4档：3单及以上', '向前滚动24小时', '档位可能下降']) assert(help.includes(text));
                assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'pricingWindowHelpCloseBtn');
                await page.keyboard.press('Tab');
                await page.keyboard.down('Shift');
                await page.keyboard.press('Tab');
                await page.keyboard.up('Shift');
                assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'pricingWindowHelpCloseBtn');
                await page.click('#pricingWindowHelpTitle');
                assert.strictEqual(await page.$eval('#pricingWindowHelpSheet', node => node.getAttribute('aria-hidden')), 'false');
                const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth,
                    card: document.querySelector('#pricingWindowHelpSheet .sheet-card').getBoundingClientRect().toJSON() }));
                assert(dimensions.scroll <= dimensions.width);
                assert(dimensions.card.x >= 0 && dimensions.card.right <= width);
                await page.screenshot({ path: path.join(directory, `help-${id}-${width}.png`) });
                await page.click('#pricingWindowHelpCloseBtn');
                assert.strictEqual(await page.evaluate(() => document.activeElement.id), 'pricingWindowHelpBtn');
                assert.strictEqual(await page.$eval('#pricingWindowHelpSheet', node => node.getAttribute('aria-hidden')), 'true');
                await page.click('#pricingWindowHelpBtn');
                await page.keyboard.press('Escape');
                assert.strictEqual(await page.$eval('#pricingWindowHelpBtn', node => node.getAttribute('aria-expanded')), 'false');
                await page.click('#pricingWindowHelpBtn');
                await page.mouse.click(2, 2);
                assert.strictEqual(await page.$eval('#pricingWindowHelpSheet', node => node.getAttribute('aria-hidden')), 'true');
                // Search and edit re-render the view; the question mark must survive and bind once.
                await page.$eval('#pricingSearchInput', node => { node.value = 'not-found'; node.dispatchEvent(new Event('input')); });
                await page.waitForFunction(() => document.getElementById('pricingListContainer').textContent.includes('没有找到'));
                await page.click('#pricingWindowHelpBtn');
                await page.keyboard.press('Escape');
                await page.$eval('#pricingSearchInput', node => { node.value = ''; node.dispatchEvent(new Event('input')); });
                await page.click(`${card} [data-pricing-action]`);
                assert.strictEqual(await page.$eval(`${card} [data-pricing-tier="1"]`, node => node.disabled), false);
                await page.click('#pricingWindowHelpBtn');
                await page.keyboard.press('Escape');
            }
        }
        assert.deepStrictEqual(errors, []);
        assert.deepStrictEqual(writes, [], 'viewing help must not save or reprice');
        const scripts = await page.coverage.stopJSCoverage();
        if (process.env.NODE_V8_COVERAGE) {
            const result = scripts.filter(script => new URL(script.url).pathname.startsWith('/js/')).map(script => ({
                ...script.rawScriptCoverage, url: path.resolve(__dirname, '../h5/public', '.' + new URL(script.url).pathname)
            }));
            fs.writeFileSync(path.join(process.env.NODE_V8_COVERAGE, `coverage-help-browser-${process.pid}.json`), JSON.stringify({ result }));
        }
        console.log('[PASS] pricing help: 4 games x 2 viewports, labels, dialog, focus, re-render and no writes');
    } finally {
        if (browser) await browser.close();
        stopProdRiskTaskWorker();
        await new Promise(resolve => server.close(resolve));
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
