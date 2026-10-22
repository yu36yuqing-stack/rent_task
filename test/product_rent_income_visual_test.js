'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'h5/public');
const outputDir = path.join(root, 'coverage/product-rent-income');
const viewports = [320, 375, 390, 430, 768, 1280];
const games = [
    { game_id: '1', game_name: 'WZRY' },
    { game_id: '2', game_name: '和平精英' },
    { game_id: '3', game_name: 'CFM' },
    { game_id: '4', game_name: 'CSGO' }
];
const scenarios = [
    { name: 'cost-equals-purchase', total_cost_amount: 500, purchase_price: 500,
        rental_income: { status: 'ready', amount: 368.5 }, costText: '总成本 ¥500.00', incomeText: '累计租金 ¥368.50' },
    { name: 'cost-includes-maintenance', total_cost_amount: 525, purchase_price: 500,
        rental_income: { status: 'ready', amount: 25.5 }, costText: '总成本 ¥525.00', incomeText: '累计租金 ¥25.50' },
    { name: 'zero-income', total_cost_amount: 500, purchase_price: 500,
        rental_income: { status: 'ready', amount: 0 }, costText: '总成本 ¥500.00', incomeText: '累计租金 ¥0.00' },
    { name: 'negative-income-adjustment', total_cost_amount: 500, purchase_price: 500,
        rental_income: { status: 'ready', amount: -12.34 }, costText: '总成本 ¥500.00', incomeText: '累计租金 ¥-12.34' },
    { name: 'unavailable-income', total_cost_amount: 500, purchase_price: 500,
        rental_income: { status: 'unavailable', amount: null }, costText: '总成本 ¥500.00', incomeText: '累计租金 --' },
    { name: 'unknown-cost', total_cost_amount: null, purchase_price: null, purchase_date: '',
        rental_income: { status: 'ready', amount: 42.25 }, costText: '总成本 --', incomeText: '累计租金 ¥42.25' },
    { name: 'long-amount-account-name', total_cost_amount: 9876543210987.12, purchase_price: 9876543210987.12,
        game_account: '1072370802107237080210723708021072370802',
        display_name: '超长商品名称与很长的游戏说明：和平精英穿越火线枪战王者反恐精英全球攻势',
        rental_income: { status: 'ready', amount: 1234567890123.45 },
        costText: '总成本 ¥9876543210987.12', incomeText: '累计租金 ¥1234567890123.45' }
];

function fixture(game, scenario) {
    return { ...game,
        game_account: '1072370802', display_name: '商品租金与总成本对比', purchase_date: '2026-01-01',
        channel_status: { uuzuhao: '下架', uhaozu: '上架', zuhaowang: '租赁中' },
        price_ladder: { uuzuhao: { current_tier: 1, hour_price: 1.9 },
            uhaozu: { current_tier: 2, hour_price: 2.3 }, zuhaowang: { current_tier: 3, hour_price: 123.45 } },
        five_e_info: game.game_name === 'CSGO' ? { account_no: 'fixture' } : null,
        today_paid_count: 2,
        // A relative future date keeps this read-only rendering fixture valid over time.
        renting_order_end_time: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        ...scenario
    };
}

async function renderFixture(page, item, sold = false) {
    await page.evaluate(({ item, sold }) => {
        state.user = { id: 12, name: 'Fixture user', account: 'fixture' };
        state.token = 'fixture-only';
        state.currentMenu = sold ? 'products_sold' : 'products';
        state.product_game_name = item.game_name;
        state.userRules.order_off_mode = 'rolling_24h';
        state.list = [item];
        state.total = 1;
        state.page = 1;
        render();
    }, { item, sold });
    await page.waitForSelector('#listView .product-card');
}

async function readCardLayout(page) {
    return page.evaluate(() => {
        const card = document.querySelector('#listView .product-card');
        const cost = card.querySelector('[data-slot="total-cost"]');
        const income = card.querySelector('[data-slot="rental-income"]');
        const base = card.querySelector('.base-square');
        const channel = card.querySelector('.channel-square');
        const squares = card.querySelector('.info-squares');
        const ops = card.querySelector('.ops');
        const buttons = [...ops.querySelectorAll('button')];
        const badges = [...channel.querySelectorAll('.platforms .plat')];
        const account = card.querySelector('.account');
        const countdown = card.querySelector('[data-slot="rent-countdown"]');
        const copy = card.querySelector('.copy-btn');
        const box = (element) => {
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
                width: rect.width, height: rect.height, client: element.clientWidth, scroll: element.scrollWidth };
        };
        const overflowingText = [cost, income, account, ...badges].filter(Boolean).map((element) => {
            const bounds = element.getBoundingClientRect();
            const container = element.closest('.info-square').getBoundingClientRect();
            const range = document.createRange();
            range.selectNodeContents(element);
            const textBounds = [...range.getClientRects()];
            return { text: element.textContent.trim(), clipped: element.scrollWidth > element.clientWidth + 1,
                outside: bounds.left < container.left - 1 || bounds.right > container.right + 1
                    || textBounds.some((rect) => rect.left < container.left - 1 || rect.right > container.right + 1) };
        }).filter((result) => result.clipped || result.outside);
        return {
            documentWidth: document.documentElement.scrollWidth, viewport: window.innerWidth,
            card: box(card), base: box(base), channel: box(channel), squares: box(squares), ops: box(ops),
            cost: box(cost), income: box(income), countdown: box(countdown), copy: box(copy),
            costText: cost && cost.textContent.trim(), incomeText: income && income.textContent.trim(),
            costCount: card.querySelectorAll('[data-slot="total-cost"]').length,
            incomeCount: card.querySelectorAll('[data-slot="rental-income"]').length,
            adjacent: Boolean(cost && income && cost.nextElementSibling === income),
            sameParent: Boolean(cost && income && cost.parentElement === income.parentElement),
            brief: Boolean(cost && income && cost.parentElement.classList.contains('purchase-brief')),
            orderCount: [...base.querySelectorAll('.square-line')].map((node) => node.textContent.trim()),
            countdownText: countdown && countdown.textContent.trim(),
            badges: badges.map((node) => node.textContent.trim()),
            buttons: buttons.map((button) => ({ text: button.textContent.trim(), op: button.dataset.op,
                classes: [...button.classList], ...box(button) })),
            copyValue: copy && copy.dataset.copy,
            paybackFields: /待回本|已回本|回本差额/.test(card.textContent),
            costBeforeOrder: Boolean(income && [...base.querySelectorAll('.square-line')]
                .every((line) => income.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING)),
            overflowingText
        };
    });
}

function verifyActiveLayout(layout, width, game, scenario, item) {
    const context = `${width}px/${game.game_name}/${scenario.name}`;
    assert.strictEqual(layout.costCount, 1, `${context}: total cost must always be present`);
    assert.strictEqual(layout.incomeCount, 1, `${context}: rental income must occur once`);
    assert.strictEqual(layout.costText, scenario.costText, context);
    assert.strictEqual(layout.incomeText, scenario.incomeText, context);
    assert(layout.adjacent && layout.sameParent && layout.brief, `${context}: the two lines must be adjacent siblings in purchase-brief`);
    assert(layout.income.top >= layout.cost.bottom - 1, `${context}: income must be below cost, not side-by-side`);
    assert(Math.abs(layout.income.left - layout.cost.left) <= 1, `${context}: both amounts must be left-aligned`);
    assert(layout.income.top - layout.cost.bottom <= 4, `${context}: no blank row between cost and income`);
    assert(layout.costBeforeOrder, `${context}: order count must remain after purchase/income details`);
    assert(!layout.paybackFields, `${context}: no payback amount or status may be added`);
    assert(layout.documentWidth <= width, `${context}: page must not overflow horizontally`);
    assert.deepStrictEqual(layout.overflowingText, [], `${context}: text must not be clipped or overflow its square`);
    assert.deepStrictEqual(layout.badges.slice(0, 3), [
        '悠悠: 下架 · 1档 · ¥1.90/时', 'U号: 上架 · 2档 · ¥2.30/时', 'ZHW: 租赁中 · 3档 · ¥123.45/时'
    ], `${context}: channel tier/hourly summaries must be preserved`);
    assert(layout.base.right <= layout.channel.left + 1, `${context}: existing two-square order must remain`);
    assert(Math.abs(layout.base.top - layout.channel.top) <= 1, `${context}: channel summary must stay at the top, not follow income vertically`);
    assert.deepStrictEqual(layout.orderCount, ['近24h订单：2'], `${context}: order count must remain intact`);
    assert(layout.countdownText.startsWith('租赁倒计时：'), `${context}: countdown must remain`);
    assert(layout.countdown.top >= layout.income.bottom, `${context}: countdown must remain after financial information`);
    assert.strictEqual(layout.copyValue, item.game_account, `${context}: copy button must use the original complete account`);
    assert(layout.copy.left >= layout.base.left && layout.copy.right <= layout.base.right + 1,
        `${context}: the account copy button must stay visible inside the base square`);
    assert.deepStrictEqual(layout.buttons.map((button) => button.op), ['online-query', 'blacklist-toggle', 'more-ops'], context);
    assert.strictEqual(layout.buttons[0].text, game.game_name === 'CSGO' ? '查令牌码' : '状态查询', context);
    assert.deepStrictEqual(layout.buttons.slice(1).map((button) => button.text), ['加入黑名单', '更多操作'], context);
    assert(layout.ops.top >= layout.squares.bottom - 1, `${context}: action group must remain below both squares`);
    assert(layout.buttons.every((button) => button.classes.includes('btn-card-action')
        && button.left >= layout.card.left && button.right <= layout.card.right + 1), `${context}: preserve card action styling and bounds`);
}

async function main() {
    fs.mkdirSync(outputDir, { recursive: true });
    const browser = await puppeteer.launch({
        executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: true
    });
    const chromeProcess = browser.process();
    const results = [];
    const errors = [];
    const apiRequests = [];
    try {
        const page = await browser.newPage();
        page.on('pageerror', (error) => errors.push(error.message));
        await page.evaluateOnNewDocument(() => {
            window.__copiedAccounts = [];
            Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
                async writeText(value) { window.__copiedAccounts.push(value); }
            } });
        });
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const url = new URL(request.url());
            const pathname = decodeURIComponent(url.pathname);
            if (pathname.startsWith('/api/')) {
                apiRequests.push(`${request.method()} ${pathname}`);
                return request.respond({ status: 503, contentType: 'application/json', body: '{"ok":false}' });
            }
            if (url.origin !== 'http://product-income.test') return request.abort();
            const file = path.resolve(publicDir, `.${pathname === '/' ? '/index.html' : pathname}`);
            if (!file.startsWith(`${publicDir}/`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return request.abort();
            const contentType = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html',
                '.png': 'image/png', '.svg': 'image/svg+xml', '.webp': 'image/webp' }[path.extname(file)] || 'application/octet-stream';
            return request.respond({ status: 200, contentType, body: fs.readFileSync(file) });
        });
        // Load only local static files in a synthetic origin; every API is blocked before reaching a server.
        await page.goto('http://product-income.test/', { waitUntil: 'networkidle0' });
        for (const width of viewports) {
            await page.setViewport({ width, height: 1100, deviceScaleFactor: 1 });
            for (const game of games) {
                for (const scenario of scenarios) {
                    const item = fixture(game, scenario);
                    await renderFixture(page, item);
                    const layout = await readCardLayout(page);
                    try {
                        verifyActiveLayout(layout, width, game, scenario, item);
                    } catch (error) {
                        await page.screenshot({ path: path.join(outputDir, `failure-${width}-${game.game_id}-${scenario.name}.png`), fullPage: true });
                        throw error;
                    }
                    // Exercise the real ClipboardCopy event without touching the system clipboard.
                    await page.click('#listView .product-card .copy-btn');
                    const copied = await page.evaluate(() => window.__copiedAccounts.pop());
                    assert.strictEqual(copied, item.game_account, `${width}/${game.game_name}/${scenario.name}: actual copy handler`);
                    results.push({ width, game: game.game_name, scenario: scenario.name, sold: false, ...layout });
                    if (game.game_id === '1' && ['cost-equals-purchase', 'long-amount-account-name'].includes(scenario.name)
                        && [320, 390, 1280].includes(width)) {
                        const card = await page.$('#listView .product-card');
                        await card.screenshot({ path: path.join(outputDir, `income-card-${width}-${scenario.name}.png`) });
                    }
                }
                const soldItem = { ...fixture(game, scenarios[0]), sold_price: 800,
                    lifecycle_profit_amount: 668.5, sold_at: '2026-10-21 12:00:00', asset_status: 'sold' };
                await renderFixture(page, soldItem, true);
                const soldLayout = await readCardLayout(page);
                const context = `${width}/${game.game_name}/sold`;
                assert.strictEqual(soldLayout.incomeCount, 0, `${context}: sold cards must not gain rental income row`);
                assert.strictEqual(soldLayout.costCount, 0, `${context}: sold purchase brief must retain its original markup`);
                assert.deepStrictEqual(soldLayout.orderCount, ['售出价：¥800.00', '生命周期总收益：¥668.50'], context);
                assert.strictEqual(soldLayout.copy, null, `${context}: sold card copy behavior remains unchanged`);
                assert.strictEqual(soldLayout.countdown, null, `${context}: sold card has no rental countdown`);
                assert.deepStrictEqual(soldLayout.buttons.map((button) => button.op), ['sold-maintenance', 'cost-detail'], context);
                assert(soldLayout.documentWidth <= width, `${context}: no horizontal page overflow`);
                results.push({ width, game: game.game_name, scenario: 'sold-unchanged', sold: true, ...soldLayout });
            }
        }
        assert.deepStrictEqual(errors, [], 'no runtime errors while rendering all cases');
        assert.deepStrictEqual(apiRequests, [], 'no API calls, especially no real business writes');
        fs.writeFileSync(path.join(outputDir, 'visual-results.json'), JSON.stringify({
            activeCases: viewports.length * games.length * scenarios.length,
            soldCases: viewports.length * games.length,
            apiRequests, errors, results
        }, null, 2) + '\n');
        console.log(`[PASS] product rental income visual: ${results.length} cases (${viewports.length * games.length * scenarios.length} active + ${viewports.length * games.length} sold), 4 games x 6 viewports, adjacent vertical amounts, copy/actions/channel/countdown regression, no API calls`);
    } finally {
        try {
            await browser.close();
        } finally {
            // Chrome/Crashpad may leave inherited pipes open after Chromium exits on macOS.
            // Dispose these handles, not process.exit(), so genuine pending work/failures remain visible.
            for (const stream of (chromeProcess && chromeProcess.stdio) || []) {
                if (stream && typeof stream.destroy === 'function') stream.destroy();
            }
        }
    }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
