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
const { upsertAccountPriceLadderRuntime } = require('../database/account_price_ladder_runtime_db');
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

async function assertPricingHeaderLayout(page) {
    const layout = await page.evaluate(() => {
        const rect = selector => document.querySelector(selector).getBoundingClientRect();
        const select = rect('#pricingCountMode');
        const track = rect('.pricing-settings-row .feature-switch-track');
        const label = rect('label[for="pricingCountMode"]');
        const title = rect('.pricing-settings-row .feature-switch-copy strong');
        const status = rect('#pricingFeatureStatus');
        const settings = rect('.pricing-settings-row');
        const head = rect('#pricingLadderPane .pricing-ladder-head');
        return {
            width: innerWidth,
            scrollWidth: document.documentElement.scrollWidth,
            labelOffset: Math.abs(label.top - title.top),
            controlOffset: Math.abs(select.top + select.height / 2 - track.top - track.height / 2),
            selectWidth: select.width,
            selectRight: select.right,
            trackRight: track.right,
            statusHeight: status.height,
            settingsWidth: settings.width,
            headWidth: head.width,
            appearance: getComputedStyle(document.getElementById('pricingCountMode')).appearance,
            arrowInset: getComputedStyle(document.querySelector('.pricing-count-control'), '::after').right,
            duplicateWindow: Boolean(document.querySelector('#pricingLadderPane #pricingWindowText')),
            rangeInHelp: Boolean(document.querySelector('#pricingWindowHelpSheet #pricingWindowText'))
        };
    });
    if (layout.scrollWidth > layout.width || layout.labelOffset > 1 || layout.controlOffset > 1
        || layout.selectWidth > 192 || layout.selectRight > layout.width || layout.trackRight > layout.width
        || layout.statusHeight > 36 || Math.abs(layout.settingsWidth - layout.headWidth) > 5
        || layout.appearance !== 'none' || layout.arrowInset !== '14px'
        || layout.duplicateWindow || !layout.rangeInHelp) {
        throw new Error(`阶梯配置头部未对齐或溢出: ${JSON.stringify(layout)}`);
    }
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
            },
            uuzuhao: {
                prd_id: 'visual-uuzuhao-target',
                hourPrice: 3.1,
                minRentHour: 2
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
    // Seed confirmed tiers without making any real platform write requests.
    for (const channel of ['uhaozu', 'uuzuhao']) {
        await upsertAccountPriceLadderRuntime(user.id, {
            game_id: '2', game_name: '和平精英', game_account: 'hpjy-target',
            channel, desired_tier: 1, applied_tier: 1, rule_version: 1, status: 'applied'
        });
    }
    let browser = null;
    try {
        browser = await puppeteer.launch({
            executablePath: chromePath,
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();
        const browserEvents = [];
        const featureRequests = [];
        page.on('request', request => {
            if (request.method() === 'POST' && request.url().endsWith('/api/pricing/ladder/feature')) {
                featureRequests.push(JSON.parse(request.postData()));
            }
        });
        page.on('console', (msg) => browserEvents.push(`console:${msg.type()}:${msg.text()}`));
        page.on('pageerror', (err) => browserEvents.push(`pageerror:${err.message}`));
        page.on('response', (response) => {
            if (response.status() >= 400) browserEvents.push(`response:${response.status()}:${response.url()}`);
        });
        await page.setViewport({ width: 1365, height: 900, deviceScaleFactor: 1 });
        const baseUrl = `http://127.0.0.1:${process.env.H5_PORT}`;
        await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
        const authBundle = JSON.stringify({
            token: createAccessToken(user),
            access_token: createAccessToken(user),
            refresh_token: '',
            user
        });
        await page.evaluate((bundle) => localStorage.setItem('h5_auth_bundle', bundle), authBundle);
        await page.goto(`${baseUrl}/?menu=pricing_uhaozu`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-pricing-game="和平精英"]', { visible: true });
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
        await page.waitForFunction(() => document.getElementById('pricingCountMode').value === 'rolling_24h'
            && document.getElementById('pricingWindowText').textContent.includes('北京时间'));
        await assertPricingHeaderLayout(page);
        await page.click('[data-pricing-game="WZRY"]');
        await page.waitForFunction(() => document.getElementById('pricingListContainer').textContent.includes('暂无可配置账号'));
        await assertPricingHeaderLayout(page);
        await page.screenshot({ path: path.join(outputDir, 'pricing-header-empty-desktop.png'), fullPage: true });
        await page.click('[data-pricing-game="和平精英"]');
        await page.waitForSelector(targetCard);
        if (!(await page.$eval(targetCard, node => node.textContent)).includes('近24h 0单')) {
            throw new Error('滚动窗口计数文案未显示');
        }
        await page.select('#pricingCountMode', 'business_day');
        await page.waitForFunction(() => document.getElementById('pricingCountMode').value === 'business_day'
            && !document.getElementById('pricingCountMode').disabled
            && document.querySelector('[data-pricing-account-card="hpjy-target"]').textContent.includes('本周期 0单'));
        await page.click('#pricingWindowHelpBtn');
        await page.waitForSelector('#pricingWindowHelpSheet:not(.hidden)');
        if (!(await page.$eval('#pricingWindowHelpDescription', node => node.textContent)).includes('凌晨6点前从前一天06:00算起')) {
            throw new Error('固定06:00周期说明未跟随设置');
        }
        await page.click('#pricingWindowHelpCloseBtn');
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#pricingCountMode');
        await page.waitForFunction(() => document.getElementById('pricingCountMode').value === 'business_day'
            && document.getElementById('pricingWindowText').textContent.includes('06:00'));
        await page.click('[data-pricing-game="和平精英"]');
        await page.waitForSelector(targetCard);
        await page.screenshot({ path: path.join(outputDir, 'pricing-count-mode-desktop.png'), fullPage: true });
        const headerClip = await page.$eval('#pricingLadderPane .pricing-ladder-head', node => {
            const rect = node.getBoundingClientRect();
            return { x: rect.x - 8, y: rect.y - 8, width: rect.width + 16, height: rect.height + 16 };
        });
        await page.screenshot({ path: path.join(outputDir, 'pricing-header-detail.png'), clip: headerClip });
        await page.select('#pricingCountMode', 'rolling_24h');
        await page.waitForFunction(() => !document.getElementById('pricingCountMode').disabled
            && document.getElementById('pricingCountMode').value === 'rolling_24h'
            && document.querySelector('[data-pricing-account-card="hpjy-target"]').textContent.includes('近24h 0单'));
        if (featureRequests.length !== 2 || featureRequests.some(body => body.enabled !== false)
            || featureRequests[0].count_mode !== 'business_day' || featureRequests[1].count_mode !== 'rolling_24h'
            || featureRequests[1].expected_version <= featureRequests[0].expected_version) {
            throw new Error(`计数周期设置未复用版本保存或意外开启自动调价: ${JSON.stringify(featureRequests)}`);
        }
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
        if (desktopChannelState.channelTabs.join(',') !== 'U号租,租号王,悠悠租号'
            || desktopChannelState.tierRows !== 4
            || desktopChannelState.hasBaselineAction
            || desktopChannelState.sheetText.includes('已冻结基准')
            || desktopChannelState.sheetText.includes('价格基准')) {
            throw new Error(`渠道价格抽屉内容错误: ${JSON.stringify(desktopChannelState)}`);
        }
        await page.click('[data-pricing-channel-tab="zuhaowang"]');
        await page.waitForFunction(() => document.getElementById('pricingChannelBody').textContent.includes('当前账号未关联该渠道商品'));
        await page.click('[data-pricing-channel-tab="uuzuhao"]');
        await page.waitForSelector('#pricingChannelSheet .pricing-package-row.package-count-9.is-active');
        const uuzuhaoDesktop = await page.evaluate(() => ({
            text: document.getElementById('pricingChannelBody').textContent,
            packageLabels: Array.from(document.querySelectorAll('.pricing-package-header span')).map((node) => node.textContent.trim()),
            packageColumns: getComputedStyle(document.querySelector('.pricing-package-row.package-count-9')).gridTemplateColumns.split(' ').filter(Boolean).length,
            scrollWidth: document.querySelector('.pricing-package-scroll').scrollWidth,
            clientWidth: document.querySelector('.pricing-package-scroll').clientWidth
        }));
        if (!uuzuhaoDesktop.text.includes('时租价已回读验证')
            || !uuzuhaoDesktop.text.includes('起租 2 小时')
            || uuzuhaoDesktop.packageLabels.join(',') !== '时租,2小时,3小时,5小时,7小时,9小时,10小时,24小时,168小时'
            || uuzuhaoDesktop.packageColumns !== 10) {
            throw new Error(`悠悠租号套餐展示错误: ${JSON.stringify(uuzuhaoDesktop)}`);
        }
        await page.screenshot({
            path: path.join(outputDir, 'pricing-channel-uuzuhao-desktop.png'),
            fullPage: true
        });
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

        await page.goto(`${baseUrl}/?menu=pricing_ratios`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#pricingRatioPanel [data-pricing-ratio-key="week"]');
        await page.$eval('#pricingRatioPreviewHour', (input) => {
            input.value = '3.25';
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
        await page.waitForFunction(() => {
            const item = document.querySelector('[data-pricing-ratio-result-key="week"]');
            return item && item.textContent.includes('¥113.75');
        });
        const ratioDesktop = await page.evaluate(() => ({
            tabs: Array.from(document.querySelectorAll('#pricingRatioChannelTabs [data-pricing-ratio-channel]')).map((node) => node.textContent.trim()),
            keys: Array.from(document.querySelectorAll('#pricingRatioPanel [data-pricing-ratio-key]')).map((node) => node.dataset.pricingRatioKey),
            hourDisabled: document.querySelector('[data-pricing-ratio-key="hour"]').disabled,
            previewHour: document.getElementById('pricingRatioPreviewHour').value,
            previewWeek: document.querySelector('[data-pricing-ratio-result-key="week"]').textContent.trim(),
            resultIsText: document.querySelector('[data-pricing-ratio-result-key="week"]').tagName === 'SPAN',
            documentWidth: document.documentElement.scrollWidth,
            viewportWidth: window.innerWidth
        }));
        if (ratioDesktop.tabs.join(',') !== 'U号租,租号王,悠悠租号'
            || ratioDesktop.keys.join(',') !== 'hour,night,day,week'
            || !ratioDesktop.hourDisabled
            || ratioDesktop.previewHour !== '3.25'
            || !ratioDesktop.previewWeek.includes('¥113.75')
            || !ratioDesktop.resultIsText
            || ratioDesktop.documentWidth > ratioDesktop.viewportWidth) {
            throw new Error(`桌面套餐倍率展示错误: ${JSON.stringify(ratioDesktop)}`);
        }
        await page.click('[data-pricing-ratio-channel="zuhaowang"]');
        await page.waitForSelector('#pricingRatioPanel [data-pricing-ratio-key="p168"]');
        await page.waitForFunction(() => {
            const input = document.getElementById('pricingRatioPreviewHour');
            const item = document.querySelector('[data-pricing-ratio-result-key="p168"]');
            return input && input.value === '3.25' && item && item.textContent.includes('¥102.3');
        });
        await page.screenshot({
            path: path.join(outputDir, 'pricing-ratio-desktop.png'),
            fullPage: true
        });

        await page.goto(`${baseUrl}/?menu=pricing_uhaozu`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-pricing-game="和平精英"]', { visible: true });
        await page.click('[data-pricing-game="和平精英"]');
        await page.waitForSelector(targetCard);

        await page.setViewport({ width: 390, height: 640, deviceScaleFactor: 1 });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-pricing-game="和平精英"]', { visible: true });
        await page.click('[data-pricing-game="和平精英"]');
        await page.waitForSelector(targetCard);
        await page.select('#pricingCountMode', 'business_day');
        await page.waitForFunction(() => !document.getElementById('pricingCountMode').disabled
            && document.getElementById('pricingCountMode').value === 'business_day'
            && document.querySelector('[data-pricing-account-card="hpjy-target"]').textContent.includes('本周期 0单'));
        for (const width of [320, 360, 390]) {
            await page.setViewport({ width, height: 640, deviceScaleFactor: 1 });
            await assertPricingHeaderLayout(page);
            if (width === 320) await page.screenshot({ path: path.join(outputDir, 'pricing-header-mobile-320.png'), fullPage: true });
        }
        const layout = await page.evaluate((selector) => {
            const card = document.querySelector(selector);
            const cardRect = card.getBoundingClientRect();
            const inputs = Array.from(card.querySelectorAll('.pricing-price-input')).map((node) => node.getBoundingClientRect());
            const countSelect = document.getElementById('pricingCountMode').getBoundingClientRect();
            return {
                viewportWidth: window.innerWidth,
                documentWidth: document.documentElement.scrollWidth,
                cardLeft: cardRect.left,
                cardRight: cardRect.right,
                inputsInside: inputs.every((rect) => rect.left >= cardRect.left && rect.right <= cardRect.right),
                countSelectInside: countSelect.left >= 0 && countSelect.right <= window.innerWidth
            };
        }, targetCard);
        if (layout.documentWidth > layout.viewportWidth || !layout.inputsInside || !layout.countSelectInside || layout.cardLeft < 0 || layout.cardRight > layout.viewportWidth) {
            throw new Error(`移动端布局溢出: ${JSON.stringify(layout)}`);
        }
        await page.click(`${targetCard} [data-pricing-channel-result]`);
        await page.waitForSelector('#pricingChannelSheet:not(.hidden) .pricing-package-row.is-active');
        const channelLayout = await page.evaluate(() => {
            const sheet = document.querySelector('#pricingChannelSheet .pricing-channel-sheet-card');
            const body = document.getElementById('pricingChannelBody');
            const rows = Array.from(document.querySelectorAll('#pricingChannelSheet .pricing-package-row:not(.pricing-package-header)'));
            const packageLine = document.querySelector('#pricingChannelSheet .pricing-package-line');
            const scroller = document.querySelector('#pricingChannelSheet .pricing-package-scroll');
            const header = document.querySelector('#pricingChannelSheet .pricing-package-header');
            const rect = sheet.getBoundingClientRect();
            body.scrollTop = body.scrollHeight;
            scroller.scrollLeft = scroller.scrollWidth;
            const bodyRect = body.getBoundingClientRect();
            const lastRowRect = rows.at(-1).getBoundingClientRect();
            const scrollerRect = scroller.getBoundingClientRect();
            const bodyScrollable = body.scrollHeight > body.clientHeight;
            const lastRowVisible = lastRowRect.bottom <= bodyRect.bottom + 1 && lastRowRect.top >= bodyRect.top - 1;
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
                bodyScrollable,
                bodyScrolled: body.scrollTop > 0,
                lastRowVisible,
                contentReachable: lastRowVisible && (!bodyScrollable || body.scrollTop > 0),
                packageColumns: getComputedStyle(packageLine).gridTemplateColumns.split(' ').filter(Boolean).length,
                rowColumns: getComputedStyle(rows[0]).gridTemplateColumns.split(' ').filter(Boolean).length,
                headerDisplay: getComputedStyle(header).display,
                headerLabels: Array.from(header.querySelectorAll('span')).map((node) => node.textContent.trim()),
                tableScrollable: scroller.scrollWidth > scroller.clientWidth,
                tableScrolled: scroller.scrollLeft > 0,
                scrollerInside: scrollerRect.left >= rect.left && scrollerRect.right <= rect.right
            };
        });
        if (!(await page.$eval('#pricingChannelBody', node => node.textContent)).includes('每日06:00切日 · 本周期 0单')) {
            throw new Error('渠道套餐详情的周期与列表不一致');
        }
        if (channelLayout.documentWidth > channelLayout.viewportWidth || channelLayout.sheetLeft < 0
            || channelLayout.sheetRight > channelLayout.viewportWidth || !channelLayout.scrollerInside
            || !channelLayout.contentReachable || !channelLayout.tableScrollable || !channelLayout.tableScrolled
            || channelLayout.headerDisplay !== 'grid'
            || channelLayout.headerLabels.join(',') !== '时租,包夜,包天,包周'
            || channelLayout.packageColumns !== 3 || channelLayout.rowColumns !== 5) {
            throw new Error(`移动端渠道价格溢出: ${JSON.stringify(channelLayout)}`);
        }
        await page.$eval('#pricingChannelSheet .pricing-package-scroll', (node) => { node.scrollLeft = 0; });
        await page.screenshot({
            path: path.join(outputDir, 'pricing-channel-mobile.png'),
            fullPage: true
        });
        await page.click('[data-pricing-channel-tab="uuzuhao"]');
        await page.waitForSelector('#pricingChannelSheet .pricing-package-row.package-count-9.is-active');
        const uuzuhaoMobile = await page.evaluate(() => {
            const scroller = document.querySelector('.pricing-package-scroll');
            const table = document.querySelector('.pricing-package-table.package-count-9');
            const header = table.querySelector('.pricing-package-header');
            const row = table.querySelector('.pricing-package-row:not(.pricing-package-header)');
            scroller.scrollLeft = scroller.scrollWidth;
            const scrollerRect = scroller.getBoundingClientRect();
            const tableRect = table.getBoundingClientRect();
            return {
                documentWidth: document.documentElement.scrollWidth,
                viewportWidth: window.innerWidth,
                packageLabels: Array.from(row.querySelectorAll('.pricing-package-value'))
                    .map((node) => node.dataset.label),
                headerDisplay: getComputedStyle(header).display,
                headerLabels: Array.from(header.querySelectorAll('span')).map((node) => node.textContent.trim()),
                rowColumns: getComputedStyle(row).gridTemplateColumns.split(' ').filter(Boolean).length,
                scrollable: scroller.scrollWidth > scroller.clientWidth,
                scrolled: scroller.scrollLeft > 0,
                scrollerLeft: scrollerRect.left,
                scrollerRight: scrollerRect.right,
                tableWidth: tableRect.width
            };
        });
        if (uuzuhaoMobile.documentWidth > uuzuhaoMobile.viewportWidth
            || !uuzuhaoMobile.scrollable || !uuzuhaoMobile.scrolled
            || uuzuhaoMobile.headerDisplay !== 'grid'
            || uuzuhaoMobile.headerLabels.join(',') !== '时租,2小时,3小时,5小时,7小时,9小时,10小时,24小时,168小时'
            || uuzuhaoMobile.rowColumns !== 10
            || uuzuhaoMobile.packageLabels.join(',') !== '时租,2小时,3小时,5小时,7小时,9小时,10小时,24小时,168小时'
            || uuzuhaoMobile.scrollerLeft < 0 || uuzuhaoMobile.scrollerRight > uuzuhaoMobile.viewportWidth) {
            throw new Error(`悠悠租号移动端套餐溢出: ${JSON.stringify(uuzuhaoMobile)}`);
        }
        await page.$eval('#pricingChannelSheet .pricing-package-scroll', (node) => { node.scrollLeft = 0; });
        await page.screenshot({
            path: path.join(outputDir, 'pricing-channel-uuzuhao-mobile.png'),
            fullPage: true
        });
        await page.click('#pricingChannelCloseBtn');
        await page.screenshot({
            path: path.join(outputDir, 'pricing-ladder-mobile.png'),
            fullPage: true
        });
        await page.goto(`${baseUrl}/?menu=pricing_ratios`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#pricingRatioPanel [data-pricing-ratio-key="week"]');
        await page.click('[data-pricing-ratio-channel="uuzuhao"]');
        await page.waitForSelector('#pricingRatioPanel [data-pricing-ratio-key="p168"]');
        const ratioMobile = await page.evaluate(() => {
            const panel = document.getElementById('pricingRatioPanel');
            const rect = panel.getBoundingClientRect();
            const fields = Array.from(panel.querySelectorAll('.pricing-ratio-field'))
                .map((node) => node.getBoundingClientRect()).filter(rect => rect.width > 0);
            const previewItems = Array.from(panel.querySelectorAll('.pricing-ratio-result')).map((node) => node.getBoundingClientRect());
            return {
                documentWidth: document.documentElement.scrollWidth,
                viewportWidth: window.innerWidth,
                panelLeft: rect.left,
                panelRight: rect.right,
                fieldBounds: fields.map(field => ({ left: field.left, right: field.right })),
                fieldsInside: fields.every((field) => field.left >= rect.left && field.right <= rect.right),
                previewInside: previewItems.every((item) => item.left >= rect.left && item.right <= rect.right),
                previewCount: previewItems.length,
                previewHour: document.getElementById('pricingRatioPreviewHour').value,
                resultTags: Array.from(panel.querySelectorAll('.pricing-ratio-result')).map((node) => node.tagName)
            };
        });
        if (ratioMobile.documentWidth > ratioMobile.viewportWidth || ratioMobile.panelLeft < 0
            || ratioMobile.panelRight > ratioMobile.viewportWidth || !ratioMobile.fieldsInside
            || !ratioMobile.previewInside || ratioMobile.previewCount !== 9 || ratioMobile.previewHour !== '2'
            || ratioMobile.resultTags.some((tag) => tag !== 'SPAN')) {
            throw new Error(`移动端套餐倍率布局溢出: ${JSON.stringify(ratioMobile)}`);
        }
        await page.screenshot({
            path: path.join(outputDir, 'pricing-ratio-mobile.png'),
            fullPage: true
        });
        console.log(JSON.stringify({ ok: true, savedState, desktopChannelState, uuzuhaoDesktop, ratioDesktop, layout, channelLayout, uuzuhaoMobile, ratioMobile, outputDir }));
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
