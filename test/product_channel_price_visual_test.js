'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');
const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'h5/public');
const outputDir = path.join(root, 'coverage/product-channel-price');

async function main() {
    fs.mkdirSync(outputDir, { recursive: true });
    const browser = await puppeteer.launch({
        executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: true
    });
    const results = [];
    const errors = [];
    const apiRequests = [];
    try {
        const page = await browser.newPage();
        page.on('pageerror', (error) => errors.push(error.message));
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const pathname = decodeURIComponent(new URL(request.url()).pathname);
            if (pathname.startsWith('/api/')) {
                apiRequests.push(`${request.method()} ${pathname}`);
                return request.respond({ status: 503, contentType: 'application/json', body: '{"ok":false}' });
            }
            const file = path.resolve(publicDir, `.${pathname === '/' ? '/index.html' : pathname}`);
            if (!file.startsWith(`${publicDir}/`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return request.abort();
            const type = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html',
                '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' }[path.extname(file)] || 'application/octet-stream';
            return request.respond({ status: 200, contentType: type, body: fs.readFileSync(file) });
        });
        // Serve the real app from fixtures; no local or production business API is contacted.
        await page.goto('http://product-price.test/', { waitUntil: 'networkidle0' });
        for (const width of [320, 375, 390, 430, 768, 1280]) {
            await page.setViewport({ width, height: 1000, deviceScaleFactor: 1 });
            for (const [game_id, game_name] of [['1', 'WZRY'], ['2', '和平精英'], ['3', 'CFM'], ['4', 'CSGO']]) {
                await page.evaluate(({ game_id, game_name }) => {
                    state.user = { id: 12, name: 'Fixture user', account: 'fixture' };
                    state.token = 'fixture-only';
                    state.currentMenu = 'products';
                    state.gameName = game_name;
                    state.list = [{ game_id, game_name, game_account: '1072370802',
                        display_name: '商品名称较长时也应保持完整的渠道档位和时租价格',
                        channel_status: { uuzuhao: '下架', uhaozu: '上架', zuhaowang: '租赁中' },
                        price_ladder: { uuzuhao: { current_tier: 1, hour_price: 1.9 },
                            uhaozu: { current_tier: 2, hour_price: 2.3 }, zuhaowang: { current_tier: 3, hour_price: 123.45 } },
                        five_e_info: game_name === 'CSGO' ? { account_no: 'fixture' } : null,
                        today_paid_count: 2 }];
                    state.total = 1;
                    render();
                }, { game_id, game_name });
                const layout = await page.evaluate(() => {
                    const badges = [...document.querySelectorAll('#listView .channel-square .platforms .plat')];
                    return { documentWidth: document.documentElement.scrollWidth, width: window.innerWidth,
                        texts: badges.map((badge) => badge.textContent.trim()),
                        badgeSizes: badges.map((badge) => ({ text: badge.textContent.trim(),
                            client: badge.clientWidth, scroll: badge.scrollWidth,
                            whiteSpace: getComputedStyle(badge).whiteSpace, display: getComputedStyle(badge).display })),
                        clipped: badges.some((badge) => badge.scrollWidth > badge.clientWidth + 1),
                        outOfBounds: badges.some((badge) => {
                            const rect = badge.getBoundingClientRect();
                            const container = badge.closest('.info-square').getBoundingClientRect();
                            return rect.left < container.left || rect.right > container.right + 1;
                        }) };
                });
                assert.strictEqual(layout.texts[0], '悠悠: 下架 · 1档 · ¥1.90/时');
                assert.strictEqual(layout.texts[1], 'U号: 上架 · 2档 · ¥2.30/时');
                assert.strictEqual(layout.texts[2], 'ZHW: 租赁中 · 3档 · ¥123.45/时');
                assert(layout.documentWidth <= width, JSON.stringify(layout));
                if (layout.clipped || layout.outOfBounds) await page.screenshot({ path: path.join(outputDir, 'layout-failure.png'), fullPage: true });
                assert(!layout.clipped && !layout.outOfBounds, JSON.stringify(layout));
                results.push({ width, game_name, ...layout });
                if (game_name === 'WZRY' && [390, 1280].includes(width)) {
                    await page.screenshot({ path: path.join(outputDir, `product-price-${width}.png`), fullPage: true });
                }
            }
        }
        assert.deepStrictEqual(errors, []);
        assert.deepStrictEqual(apiRequests, []);
        fs.writeFileSync(path.join(outputDir, 'visual-results.json'), JSON.stringify(results, null, 2) + '\n');
        console.log(`[PASS] product channel price visual: ${results.length} viewport/game combinations, real app rendering, no API calls`);
    } finally {
        await browser.close();
    }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
