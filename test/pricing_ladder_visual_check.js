#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-price-ladder-visual-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');
process.env.ORDER_DB_FILE_PATH = path.join(tempDir, 'rent_robot_order.db');
process.env.STATS_DB_FILE_PATH = path.join(tempDir, 'rent_robot_stats.db');
process.env.PRICE_DB_FILE_PATH = path.join(tempDir, 'rent_robot_price.db');
process.env.SHEEP_FIX_ENABLE = '0';
process.env.BL_V2_INSPECTOR_ENABLE = '0';
process.env.ORDER_COUNT_TRACE = 'false';
process.env.H5_PORT = String(25080 + Math.floor(Math.random() * 1000));

const puppeteer = require('puppeteer-core');
const { createUserByAdmin } = require('../database/user_db');
const { upsertUserGameAccount } = require('../database/user_game_account_db');
const { savePriceLadderRuleByUser } = require('../price/price_ladder_service');
const { createPricePublishItemLog } = require('../database/price_publish_log_db');
const { createAccessToken } = require('../user/auth_token');
const { bootstrap } = require('../h5/local_h5_server');
const { stopProdRiskTaskWorker } = require('../product/prod_status_guard');

const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const outputDir = path.join(__dirname, '../coverage/price-ladder');

async function waitForText(page, selector, expected) {
    await page.waitForFunction((targetSelector, text) => {
        const node = document.querySelector(targetSelector);
        return node && String(node.textContent || '').trim() === text;
    }, { timeout: 10000 }, selector, expected);
}

async function main() {
    fs.mkdirSync(outputDir, { recursive: true });
    const user = await createUserByAdmin({
        account: 'price_ladder_visual',
        password: '123456',
        name: '阶梯定价视觉测试',
        user_type: '内部',
        status: 'enabled'
    });
    await upsertUserGameAccount({
        user_id: user.id,
        game_id: '2',
        game_name: '和平精英',
        game_account: 'hpjy-source',
        account_remark: '和平精英长名称示例一号账号',
        channel_prd_info: {
            uhaozu: {
                prd_id: 'visual-source',
                rentalByHour: 2.4,
                rentalByNight: 9.6,
                rentalByDay: 14.4,
                rentalByWeek: 84
            }
        }
    });
    await upsertUserGameAccount({
        user_id: user.id,
        game_id: '2',
        game_name: '和平精英',
        game_account: 'hpjy-target',
        account_remark: '待复制账号',
        channel_prd_info: {
            uhaozu: {
                prd_id: 'visual-target',
                rentalByHour: 3.1,
                rentalByNight: 12.4,
                rentalByDay: 18.6,
                rentalByWeek: 108.5
            }
        }
    });
    await upsertUserGameAccount({
        user_id: user.id,
        game_id: '2',
        game_name: '和平精英',
        game_account: 'hpjy-no-price',
        account_remark: '',
        channel_prd_info: {}
    });
    await savePriceLadderRuleByUser(user.id, {
        game_name: '和平精英',
        game_account: 'hpjy-source',
        prices: [2.4, 3.4, 5.4, 10.4],
        expected_version: 0
    });
    await createPricePublishItemLog({
        batch_id: 'visual-price-error',
        user_id: user.id,
        channel: 'uhaozu',
        game_name: '和平精英',
        game_account: 'hpjy-target',
        goods_id: 'visual-target',
        publish_status: 'fail',
        fail_message: '包夜价格低于 U号租允许范围',
        price_target_hour: 4.75,
        price_target_night: 19,
        price_target_day: 28.5,
        price_target_week: 166.25
    });

    const server = await bootstrap();
    let browser = null;
    try {
        browser = await puppeteer.launch({
            executablePath: chromePath,
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        const browserEvents = [];
        page.on('console', (msg) => browserEvents.push(`console:${msg.type()}:${msg.text()}`));
        page.on('pageerror', (err) => browserEvents.push(`pageerror:${err.message}`));
        page.on('response', (response) => {
            if (response.status() >= 400) browserEvents.push(`response:${response.status()}:${response.url()}`);
        });
        await page.setViewport({ width: 1365, height: 900, deviceScaleFactor: 1 });
        const baseUrl = `http://127.0.0.1:${process.env.H5_PORT}`;
        await page.goto(baseUrl, { waitUntil: 'networkidle0' });
        const authBundle = JSON.stringify({
            token: createAccessToken(user),
            access_token: createAccessToken(user),
            refresh_token: '',
            user
        });
        await page.evaluate((bundle) => localStorage.setItem('h5_auth_bundle', bundle), authBundle);
        await page.goto(`${baseUrl}/?menu=pricing_uhaozu`, { waitUntil: 'networkidle0' });
        await page.click('[data-pricing-game="和平精英"]');
        try {
            await page.waitForSelector('[data-pricing-account-card="hpjy-target"]', { timeout: 10000 });
        } catch (err) {
            const pageState = await page.evaluate(() => ({
                loginHidden: document.getElementById('loginView').classList.contains('hidden'),
                pricingHidden: document.getElementById('pricingView').classList.contains('hidden'),
                pricingText: document.getElementById('pricingListContainer').textContent,
                toast: document.getElementById('toast').textContent
            }));
            throw new Error(`账号卡片未显示: ${JSON.stringify({ pageState, browserEvents })}`);
        }

        const targetCard = '[data-pricing-account-card="hpjy-target"]';
        await page.type('#pricingSearchInput', '待复制');
        await page.waitForFunction(() => (
            document.querySelectorAll('[data-pricing-account-card]').length === 1
            && document.getElementById('pricingSearchSummary').textContent.includes('1 / 共 3')
        ));
        await page.$eval('#pricingSearchInput', (input) => {
            input.value = '';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await page.waitForFunction(() => document.querySelectorAll('[data-pricing-account-card]').length === 3);
        await page.click(`${targetCard} [data-pricing-action]`);
        await page.waitForSelector(`${targetCard} [data-pricing-copy]:not([disabled])`);
        await page.select(`${targetCard} [data-pricing-copy]`, 'hpjy-source');
        await page.waitForFunction((selector) => {
            const inputs = Array.from(document.querySelectorAll(`${selector} [data-pricing-tier]`));
            return inputs.length === 4 && inputs.map((node) => node.value).join(',') === '2.4,3.4,5.4,10.4';
        }, {}, targetCard);
        await page.screenshot({
            path: path.join(outputDir, 'pricing-ladder-desktop-edit.png'),
            fullPage: true
        });

        await page.$eval(`${targetCard} [data-pricing-tier="2"]`, (input) => {
            input.value = '4.75';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await page.click(`${targetCard} [data-pricing-action]`);
        await waitForText(page, `${targetCard} [data-pricing-action]`, '编辑');
        const savedState = await page.$eval(targetCard, (card) => ({
            values: Array.from(card.querySelectorAll('[data-pricing-tier]')).map((node) => node.value),
            disabled: Array.from(card.querySelectorAll('[data-pricing-tier]')).every((node) => node.disabled)
        }));
        if (savedState.values.join(',') !== '2.4,4.75,5.4,10.4' || !savedState.disabled) {
            throw new Error(`保存后页面状态错误: ${JSON.stringify(savedState)}`);
        }
        await page.click(`${targetCard} [data-pricing-channel-result]`);
        await page.waitForSelector('#pricingChannelSheet:not(.hidden) .pricing-package-row.is-active');
        const desktopChannelState = await page.evaluate(() => ({
            channelTabs: Array.from(document.querySelectorAll('#pricingChannelTabs [data-pricing-channel-tab]')).map((node) => node.textContent.trim()),
            tierRows: document.querySelectorAll('#pricingChannelSheet .pricing-package-row:not(.pricing-package-header)').length,
            sheetText: document.getElementById('pricingChannelBody').textContent,
            hasBaselineAction: Boolean(document.querySelector('[data-pricing-refresh-baseline]'))
        }));
        if (desktopChannelState.channelTabs.join(',') !== 'U号租,租号玩,悠悠租号'
            || desktopChannelState.tierRows !== 4
            || desktopChannelState.hasBaselineAction
            || desktopChannelState.sheetText.includes('已冻结基准')
            || desktopChannelState.sheetText.includes('价格基准')) {
            throw new Error(`渠道价格抽屉内容错误: ${JSON.stringify(desktopChannelState)}`);
        }
        await page.click('[data-pricing-channel-tab="zuhaowang"]');
        await page.waitForFunction(() => document.getElementById('pricingChannelBody').textContent.includes('已知套餐：时租、日租'));
        await page.click('[data-pricing-channel-tab="uhaozu"]');
        await page.waitForSelector('#pricingChannelSheet .pricing-package-row.is-active');
        await page.click('[data-pricing-result-view="logs"]');
        await page.waitForSelector('[data-pricing-error-detail]');
        await page.waitForFunction(() => document.getElementById('pricingChannelBody').textContent.includes('包夜价格低于 U号租允许范围'));
        await page.screenshot({
            path: path.join(outputDir, 'pricing-channel-logs-desktop.png'),
            fullPage: true
        });
        await page.click('[data-pricing-error-detail]');
        await page.waitForSelector('#toast.show.toast-detail');
        await new Promise((resolve) => setTimeout(resolve, 1400));
        const detailToastVisible = await page.$eval('#toast', (node) => (
            node.classList.contains('show') && node.textContent.includes('包夜价格低于 U号租允许范围')
        ));
        if (!detailToastVisible) throw new Error('错误详情 Toast 不应自动消失');
        await page.click('#toast');
        await page.waitForFunction(() => !document.getElementById('toast').classList.contains('show'));
        await page.click('[data-pricing-result-view="result"]');
        await page.waitForSelector('#pricingChannelSheet .pricing-package-row.is-active');
        await page.screenshot({
            path: path.join(outputDir, 'pricing-channel-desktop.png'),
            fullPage: true
        });
        await page.click('#pricingChannelCloseBtn');

        await page.setViewport({ width: 390, height: 640, deviceScaleFactor: 1 });
        await page.reload({ waitUntil: 'networkidle0' });
        await page.click('[data-pricing-game="和平精英"]');
        await page.waitForSelector(targetCard);
        const layout = await page.evaluate((selector) => {
            const card = document.querySelector(selector);
            const cardRect = card.getBoundingClientRect();
            const inputs = Array.from(card.querySelectorAll('.pricing-price-input')).map((node) => node.getBoundingClientRect());
            return {
                viewportWidth: window.innerWidth,
                documentWidth: document.documentElement.scrollWidth,
                cardLeft: cardRect.left,
                cardRight: cardRect.right,
                inputsInside: inputs.every((rect) => rect.left >= cardRect.left && rect.right <= cardRect.right)
            };
        }, targetCard);
        if (layout.documentWidth > layout.viewportWidth || !layout.inputsInside || layout.cardLeft < 0 || layout.cardRight > layout.viewportWidth) {
            throw new Error(`移动端布局溢出: ${JSON.stringify(layout)}`);
        }
        await page.click(`${targetCard} [data-pricing-channel-result]`);
        await page.waitForSelector('#pricingChannelSheet:not(.hidden) .pricing-package-row.is-active');
        const channelLayout = await page.evaluate(() => {
            const sheet = document.querySelector('#pricingChannelSheet .pricing-channel-sheet-card');
            const body = document.getElementById('pricingChannelBody');
            const rows = Array.from(document.querySelectorAll('#pricingChannelSheet .pricing-package-row:not(.pricing-package-header)'));
            const packageLine = document.querySelector('#pricingChannelSheet .pricing-package-line');
            const rect = sheet.getBoundingClientRect();
            body.scrollTop = body.scrollHeight;
            const bodyRect = body.getBoundingClientRect();
            const lastRowRect = rows.at(-1).getBoundingClientRect();
            return {
                documentWidth: document.documentElement.scrollWidth,
                viewportWidth: window.innerWidth,
                sheetLeft: rect.left,
                sheetRight: rect.right,
                sheetHeight: rect.height,
                sheetRows: getComputedStyle(sheet).gridTemplateRows,
                bodyHeight: bodyRect.height,
                bodyClientHeight: body.clientHeight,
                bodyScrollHeight: body.scrollHeight,
                bodyScrollable: body.scrollHeight > body.clientHeight,
                bodyScrolled: body.scrollTop > 0,
                lastRowVisible: lastRowRect.bottom <= bodyRect.bottom + 1 && lastRowRect.top >= bodyRect.top - 1,
                packageColumns: getComputedStyle(packageLine).gridTemplateColumns.split(' ').filter(Boolean).length,
                rowColumns: getComputedStyle(rows[0]).gridTemplateColumns.split(' ').filter(Boolean).length,
                rowsInside: rows.every((row) => {
                    const rowRect = row.getBoundingClientRect();
                    return rowRect.left >= rect.left && rowRect.right <= rect.right;
                })
            };
        });
        if (channelLayout.documentWidth > channelLayout.viewportWidth || channelLayout.sheetLeft < 0
            || channelLayout.sheetRight > channelLayout.viewportWidth || !channelLayout.rowsInside
            || !channelLayout.bodyScrollable || !channelLayout.bodyScrolled || !channelLayout.lastRowVisible
            || channelLayout.packageColumns !== 3 || channelLayout.rowColumns !== 3) {
            throw new Error(`移动端渠道价格溢出: ${JSON.stringify(channelLayout)}`);
        }
        await page.screenshot({
            path: path.join(outputDir, 'pricing-channel-mobile.png'),
            fullPage: true
        });
        await page.click('#pricingChannelCloseBtn');
        await page.screenshot({
            path: path.join(outputDir, 'pricing-ladder-mobile.png'),
            fullPage: true
        });
        console.log(JSON.stringify({ ok: true, savedState, desktopChannelState, layout, channelLayout, outputDir }));
    } finally {
        if (browser) await browser.close();
        await new Promise((resolve) => server.close(resolve));
        stopProdRiskTaskWorker();
    }
}

main().catch((err) => {
    stopProdRiskTaskWorker();
    console.error('[FAIL] pricing_ladder_visual_check failed:', err);
    process.exit(1);
});
