'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const v8toIstanbul = require('v8-to-istanbul');
const { createCoverageMap } = require('istanbul-lib-coverage');
const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'h5/public');
const output = path.join(root, 'coverage/order-search');

async function main() {
    fs.mkdirSync(output, { recursive: true });
    const browser = await puppeteer.launch({
        executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: true, args: ['--disable-crash-reporter', '--disable-breakpad']
    });
    const errors = [], requests = [], layouts = [];
    let responseStatus = 200;
    try {
        const page = await browser.newPage();
        await page.coverage.startJSCoverage({ resetOnNavigation: false, includeRawScriptCoverage: true });
        page.on('pageerror', error => errors.push(error.message));
        await page.setRequestInterception(true);
        page.on('request', request => {
            const url = new URL(request.url());
            if (url.hostname !== 'orders.test') return request.abort();
            if (url.pathname.startsWith('/api/')) {
                if (url.pathname !== '/api/orders') return request.respond({ status: 503, contentType: 'application/json', body: '{"ok":false,"message":"fixture"}' });
                const query = Object.fromEntries(url.searchParams);
                requests.push(query);
                const row = { channel: 'zuhaowang', order_no: 'FIXTURE-ORDER', game_id: query.game_name === 'CSGO' ? '4' : query.game_name === 'CFM' ? '3' : query.game_name === '和平精英' ? '2' : '1',
                    game_name: query.game_name, game_account: '00123456789', display_name: '搜索示例：很长的账号名称和最新悠悠备注',
                    order_status: '已完成', start_time: '2026-11-15 08:00:00', end_time: '2026-11-15 09:00:00', rent_hour: 1, rec_amount: 2, order_amount: 3 };
                if (query.game_name === 'GTA6') Object.assign(row, {
                    channel: 'uuzuhao', order_kind: 'device', source_game_id: '11001', device_no: 'DEVICE-FIXTURE', ren_way: '首租',
                    source_game_logo: 'https://example.invalid/wukong.png', display_name: '主机搜索示例'
                });
                const list = query.keyword === '不存在' ? [] : [row];
                if (list.length && row.order_kind === 'device') list.push(
                    { ...row, order_no: 'FIXTURE-GTA6', source_game_id: '11000', source_game_name: '', source_game_logo: '', ren_way: '续租' },
                    { ...row, order_no: 'FIXTURE-OTHER', source_game_id: '999', source_game_name: '地平线6', source_game_logo: '/assets/missing-device.png', ren_way: '未知' },
                    { ...row, order_no: 'FIXTURE-LONG', source_game_id: '', source_game_name: 'LongGameName'.repeat(7), device_no: 'A'.repeat(80), source_game_logo: '', ren_way: '' },
                    { ...row, order_no: 'FIXTURE-UNKNOWN', source_game_id: '998', source_game_name: ' ', device_no: '', source_game_logo: '', ren_way: null }
                );
                return request.respond({ status: responseStatus, contentType: 'application/json', body: JSON.stringify(responseStatus !== 200
                    ? { ok: false, message: '搜索请求失败夹具' }
                    : { ok: true, page: Number(query.page), page_size: 20, total: list.length, list, stats: { done_zero: 0 },
                        keyword: query.keyword || '', game_name: query.game_name, quick_filter: query.quick_filter, status_filter: query.status_filter }) });
            }
            const file = path.resolve(publicDir, '.' + (url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)));
            if (!file.startsWith(publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return request.abort();
            const mime = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
            return request.respond({ status: 200, contentType: mime[path.extname(file)] || 'application/octet-stream', body: fs.readFileSync(file) });
        });
        await page.goto('http://orders.test/', { waitUntil: 'networkidle0' });
        await page.evaluate(async () => {
            setAuth('fixture', { id: 8, account: 'fixture', name: '搜索测试' }); state.currentMenu = 'orders';
            state.orders.quick_filter = 'last30'; state.orders.status_filter = 'all'; state.orders.page = 1;
            await loadOrders(); render();
        });
        for (const width of [320, 390, 1280]) {
            await page.setViewport({ width, height: 1000, deviceScaleFactor: 1 });
            for (const game of ['WZRY', 'GTA6', '和平精英', 'CFM', 'CSGO']) {
                await page.evaluate(async game => { state.orders.game_name = game; await loadOrders(); render(); }, game);
                const layout = await page.evaluate(() => {
                    const form = document.getElementById('orderSearchForm');
                    const input = document.getElementById('orderSearchInput');
                    const submit = document.getElementById('orderSearchSubmit');
                    const sync = document.getElementById('orderSyncNowBtn');
                    const f = form.getBoundingClientRect(), i = input.getBoundingClientRect(), b = submit.getBoundingClientRect();
                    const style = getComputedStyle(input);
                    const properties = ['height', 'padding', 'fontSize', 'fontWeight', 'lineHeight', 'color', 'backgroundColor', 'borderColor', 'borderRadius'];
                    const submitStyle = getComputedStyle(submit), syncStyle = getComputedStyle(sync);
                    return { width: innerWidth, documentWidth: document.documentElement.scrollWidth, inputWidth: i.width,
                        sameRow: Math.abs(i.top + i.height / 2 - b.top - b.height / 2) < 1, inside: i.left >= f.left && b.right <= f.right + 1,
                        inputHeight: i.height, submitHeight: b.height, fontSize: style.fontSize,
                        buttonsMatch: properties.every(prop => submitStyle[prop] === syncStyle[prop]),
                        inkMatches: style.color === getComputedStyle(document.body).color,
                        placeholderColor: getComputedStyle(input, '::placeholder').color,
                        singleLineTabs: [...document.querySelectorAll('#orderStatusTabs button')].every(node => getComputedStyle(node).whiteSpace === 'nowrap') };
                });
                if (game === 'WZRY') await page.screenshot({ path: path.join(output, `orders-search-${width}.png`), fullPage: true });
                assert(layout.documentWidth <= width && layout.inputWidth >= 100 && layout.sameRow && layout.inside && layout.singleLineTabs, JSON.stringify(layout));
                assert(layout.buttonsMatch && layout.submitHeight <= layout.inputHeight && layout.inputHeight - layout.submitHeight <= 6, JSON.stringify(layout));
                assert.deepStrictEqual([layout.fontSize, layout.inkMatches, layout.placeholderColor],
                    ['14px', true, 'rgb(109, 122, 138)']);
                layouts.push({ game, ...layout });
            }
        }
        await page.setViewport({ width: 320, height: 1000 });
        await page.evaluate(() => { state.orders.search_draft = '很长的账号名称'.repeat(8); orderSearch.render(); });
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth
            && !document.getElementById('orderSearchClear').classList.contains('hidden')));
        assert(await page.$eval('#orderSearchClear', node => {
            const clear = getComputedStyle(node), sync = getComputedStyle(document.getElementById('orderSyncNowBtn'));
            return ['height', 'padding', 'fontSize', 'fontWeight', 'lineHeight', 'color', 'backgroundColor', 'borderColor', 'borderRadius']
                .every(prop => clear[prop] === sync[prop]);
        }));
        await page.screenshot({ path: path.join(output, 'orders-search-active-320.png'), fullPage: true });
        async function input(text) {
            await page.$eval('#orderSearchInput', (element, text) => {
                element.value = text; element.dispatchEvent(new Event('input', { bubbles: true }));
            }, text);
        }
        async function submit(text, enter = false) {
            await input(text);
            const response = page.waitForResponse(response => {
                const url = new URL(response.url());
                return url.pathname === '/api/orders' && (url.searchParams.get('keyword') || '') === text;
            });
            if (enter) { await page.focus('#orderSearchInput'); await page.keyboard.press('Enter'); }
            else await page.click('#orderSearchSubmit');
            await response;
            await page.waitForFunction(() => !state.orders.loading);
        }
        const beforeTyping = requests.length;
        await input('测试账号');
        assert.strictEqual(requests.length, beforeTyping, 'typing must not request the server');
        await submit('测试账号');
        await page.waitForFunction(() => document.getElementById('orderSearchInput').value === '测试账号' && state.orders.list.length === 1);
        assert.strictEqual(requests.at(-1).keyword, '测试账号');
        assert.strictEqual(requests.at(-1).quick_filter, 'last30');
        assert.strictEqual(requests.at(-1).page, '1');
        await submit('00123456789', true);
        await page.waitForFunction(() => state.orders.keyword === '00123456789');
        assert.strictEqual(requests.at(-1).keyword, '00123456789');
        const clearResponse = page.waitForResponse(response => {
            const url = new URL(response.url());
            return url.pathname === '/api/orders' && !url.searchParams.get('keyword');
        });
        await page.click('#orderSearchClear'); await clearResponse;
        await page.waitForFunction(() => !state.orders.loading);
        await page.waitForFunction(() => document.getElementById('orderSearchInput').value === '');
        assert.strictEqual(requests.at(-1).keyword || '', '');
        assert.strictEqual(requests.at(-1).quick_filter, 'last30');
        await page.locator('[data-order-game="GTA6"]').click();
        await page.waitForFunction(() => {
            const images = [...document.querySelectorAll('#orderListContainer .game-avatar img')];
            return [['黑悟空', 'wukong.jpg'], ['GTA6', 'gta6.svg'], ['地平线6', 'console.svg']]
                .every(([name, file]) => images.some(img => img.alt === name && img.src.endsWith('/' + file) && img.naturalWidth > 0));
        });
        assert.deepStrictEqual(await page.$$eval('#orderListContainer .device-order-meta', nodes => nodes.map(n=>n.textContent)), [
            '游戏：黑悟空 · 编号：DEVICE-FIXTURE · 首租', '游戏：GTA6 · 编号：DEVICE-FIXTURE · 续租',
            '游戏：地平线6 · 编号：DEVICE-FIXTURE', `游戏：${'LongGameName'.repeat(7)} · 编号：${'A'.repeat(80)}`, '游戏：未知游戏 · 编号：-'
        ]);
        assert(await page.$$eval('#orderListContainer .device-order-meta', nodes => nodes.every(n=>n.scrollWidth<=n.clientWidth)));
        assert(await page.$eval('#orderListContainer', n=>!n.textContent.includes('渠道：悠悠主机')));
        await page.screenshot({ path: path.join(output, 'orders-wukong-320.png'), fullPage: true });
        await page.locator('[data-order-quick="last30"]').click();
        await page.waitForFunction(() => state.orders.quick_filter === 'last30' && !state.orders.loading);
        await submit('不存在');
        await page.waitForFunction(() => document.getElementById('orderListContainer').textContent.includes('匹配'));
        assert.deepStrictEqual(await page.$eval('#orderListContainer [role="status"]', node => {
            const style = getComputedStyle(node);
            return [style.fontSize, style.color, node.scrollWidth <= node.clientWidth];
        }), ['12px', 'rgb(94, 115, 139)', true]);
        await page.screenshot({ path: path.join(output, 'orders-search-empty-320.png'), fullPage: true });
        responseStatus = 500;
        await submit('故障');
        await page.waitForFunction(() => document.getElementById('orderSearchFeedback').textContent.includes('失败'));
        responseStatus = 200;
        const requestsBeforeOtherSearch = requests.length;
        await page.evaluate(() => {
            state.currentMenu = 'pricing_uhaozu'; state.pricing.list = []; render();
            const input = document.getElementById('pricingSearchInput');
            input.value = '定价筛选'; input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        assert.strictEqual(await page.evaluate(() => state.pricing.query), '定价筛选');
        await page.evaluate(() => {
            state.currentMenu = 'board'; state.board.list = []; render();
            const input = document.getElementById('boardSearchInput');
            input.value = '板卡筛选'; input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        assert.strictEqual(await page.evaluate(() => state.board.query), '板卡筛选');
        assert.strictEqual(requests.length, requestsBeforeOtherSearch, 'existing local filters must not submit order requests');
        await page.evaluate(() => {
            state.currentMenu = 'orders';
            state.orders.list = [{ game_name: '未知游戏', game_id: '999', display_name: '无图标账号', game_account: 'fixture', order_status: '已完成' }];
            render();
        });
        await page.$eval('#orderListContainer .game-avatar img', image => { image.src = '/assets/missing-order-icon.png'; });
        await page.waitForFunction(() => {
            const image = document.querySelector('#orderListContainer .game-avatar img');
            return image.complete && image.naturalWidth === 0;
        });
        assert(await page.$eval('#orderListContainer', node => node.textContent.includes('无图标账号')));
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        assert.deepStrictEqual(errors, []);
        const coverage = createCoverageMap({});
        for (const entry of await page.coverage.stopJSCoverage()) {
            const pathname = new URL(entry.url).pathname;
            if (!['/js/app_core.js', '/js/menu_orders.js', '/js/ui/order_search.js'].includes(pathname)) continue;
            const file = path.join(publicDir, pathname.slice(1));
            assert.strictEqual(entry.text, fs.readFileSync(file, 'utf8'));
            const converter = v8toIstanbul(file, 0, { source: entry.text });
            await converter.load(); converter.applyCoverage(entry.rawScriptCoverage.functions);
            coverage.merge(converter.toIstanbul());
        }
        fs.writeFileSync(path.join(output, 'browser-coverage.json'), JSON.stringify(coverage.toJSON()));
        fs.writeFileSync(path.join(output, 'visual-results.json'), JSON.stringify({ layouts, requests, errors }, null, 2));
        console.log(`[PASS] order search visual: ${layouts.length} viewport/game cases; manual submit, QQ, clear, empty and failure`);
    } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
