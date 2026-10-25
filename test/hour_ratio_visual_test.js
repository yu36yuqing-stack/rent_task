'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer-core');

const root = path.resolve(__dirname, '..');
const publicDir = path.join(root, 'h5/public');
const outputDir = path.join(root, 'coverage/hour-ratio');
const widths = [320, 375, 390, 430, 768, 1280];
const channels = ['uhaozu', 'uuzuhao', 'zuhaowang'].map(name => {
    const { capability } = require(`../price/channel_adapters/${name}_price_adapter`);
    return { ...JSON.parse(JSON.stringify(capability)), ratios: { ...capability.default_ratios },
        daily_policy: { mode: 'follow', factors: [1, 1, 0.95, 0.9] }, source: 'saved', version: 1 };
});
const clone = value => JSON.parse(JSON.stringify(value));

async function setValue(page, selector, value) {
    await page.$eval(selector, (element, text) => {
        element.value = String(text);
        element.dispatchEvent(new Event('input', { bubbles: true }));
    }, value);
}

async function readPreview(page) {
    return page.evaluate(() => ({
        hour: document.querySelector('[data-pricing-ratio-result-key="hour"]').textContent.trim(),
        others: [...document.querySelectorAll('[data-pricing-ratio-result-key]')]
            .filter(node => node.dataset.pricingRatioResultKey !== 'hour')
            .map(node => ({ key: node.dataset.pricingRatioResultKey, text: node.textContent.trim() })),
        daily: document.querySelector('[data-daily-preview]').textContent.trim(),
        basis: document.getElementById('pricingRatioPreviewHour').value,
        disabled: document.querySelector('[data-pricing-ratio-key="hour"]').disabled,
        text: document.getElementById('pricingRatioPane').textContent,
        width: innerWidth,
        scroll: document.documentElement.scrollWidth,
        rows: [...document.querySelectorAll('.pricing-ratio-field-line')].map(node => {
            const input = node.querySelector('.pricing-price-input').getBoundingClientRect();
            const result = node.querySelector('.pricing-ratio-result').getBoundingClientRect();
            return { inputRight: input.right, resultLeft: result.left, resultRight: result.right,
                centerGap: Math.abs(input.top + input.height / 2 - result.top - result.height / 2) };
        })
    }));
}

async function main() {
    fs.mkdirSync(outputDir, { recursive: true });
    const browser = await puppeteer.launch({
        executablePath: process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: true
    });
    const chromeProcess = browser.process();
    const cases = [], basisCases = [], errors = [], requests = [], unexpected = [];
    let saved = clone(channels);
    let failNextSave = false;
    let holdSave = false;
    let releaseSave;
    try {
        const page = await browser.newPage();
        page.on('pageerror', error => errors.push(error.message));
        await page.setRequestInterception(true);
        page.on('request', async request => {
            try {
                const url = new URL(request.url());
                if (url.pathname.startsWith('/api/')) {
                    requests.push({ path: url.pathname, method: request.method(),
                        body: request.postData() ? JSON.parse(request.postData()) : null });
                    if (url.pathname !== '/api/pricing/ladder/package-ratios') {
                        unexpected.push(`${request.method()} ${url.pathname}`);
                        return await request.respond({ status: 503, contentType: 'application/json', body: '{"ok":false}' });
                    }
                    if (request.method() === 'GET') return await request.respond({ status: 200,
                        contentType: 'application/json', body: JSON.stringify({ ok: true, channels: saved }) });
                    if (holdSave) await new Promise(resolve => { releaseSave = resolve; });
                    if (failNextSave) {
                        failNextSave = false;
                        return await request.respond({ status: 409, contentType: 'application/json',
                            body: JSON.stringify({ ok: false, message: 'fixture version conflict' }) });
                    }
                    const body = JSON.parse(request.postData());
                    assert.strictEqual(body.hour_ratio_editable, true);
                    assert(!Object.hasOwn(body, 'preview_hour'));
                    const channel = saved.find(item => item.channel === body.channel);
                    channel.ratios = body.ratios;
                    channel.daily_policy = body.daily_policy;
                    channel.version += 1;
                    return await request.respond({ status: 200, contentType: 'application/json',
                        body: JSON.stringify({ ok: true, setting: { ...channel, queued_count: 2 } }) });
                }
                if (url.origin !== 'http://hour-ratio.test') {
                    unexpected.push(`${request.method()} ${url.origin}`);
                    return await request.abort();
                }
                const file = path.resolve(publicDir, `.${url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname)}`);
                if (!file.startsWith(`${publicDir}/`) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return await request.abort();
                const contentType = { '.js': 'application/javascript', '.html': 'text/html', '.css': 'text/css',
                    '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml' }[path.extname(file)] || 'application/octet-stream';
                await request.respond({ status: 200, contentType, body: fs.readFileSync(file) });
            } catch (error) {
                errors.push(error.message);
                if (!request.isInterceptResolutionHandled()) await request.abort();
            }
        });
        // The synthetic origin is served entirely from local source; no running H5 or real API is used.
        await page.goto('http://hour-ratio.test/', { waitUntil: 'networkidle0' });
        for (const width of widths) {
            await page.setViewport({ width, height: 1050, deviceScaleFactor: 1 });
            for (const channel of channels) {
                for (const mode of ['follow', 'flat', 'decrease']) {
                    await page.evaluate(({ channels, selected, mode }) => {
                        state.token = 'fixture-only';
                        state.user = { id: 880, account: 'fixture', name: '独立时租倍率演算' };
                        state.currentMenu = 'pricing_ratios';
                        state.pricing = {};
                        const ratios = ensurePricingLadderState().ratio_settings;
                        ratios.channels = channels.map(item => ({ ...item, daily_policy: { ...item.daily_policy, mode } }));
                        ratios.selected_channel = selected;
                        ratios.preview_hour = '2';
                        ratios.loaded_once = true;
                        render();
                    }, { channels, selected: channel.channel, mode });
                    const before = await readPreview(page);
                    assert.strictEqual(before.hour, '= ¥2');
                    for (const multiplier of [0.9, 1, 1.2]) {
                        await setValue(page, '[data-pricing-ratio-key="hour"]', multiplier);
                        const after = await readPreview(page);
                        const context = `${width}/${channel.channel}/${mode}/${multiplier}`;
                        assert.strictEqual(after.hour, `= ¥${2 * multiplier}`, context);
                        assert.deepStrictEqual(after.others, before.others, `${context}: all nonhour packages stay unchanged`);
                        assert.strictEqual(after.daily, before.daily, `${context}: daily-policy preview stays unchanged`);
                        assert.strictEqual(after.basis, '2', context);
                        assert.strictEqual(after.disabled, false, context);
                        assert(!after.text.includes('时租固定为1倍'), context);
                        assert(after.text.includes('时租倍率不影响其他套餐'), context);
                        assert(after.scroll <= width, `${context}: no page overflow`);
                        assert(after.rows.every(row => row.resultLeft >= row.inputRight
                            && row.resultRight <= width && row.centerGap < 1), `${context}: result stays aligned immediately after multiplier`);
                        cases.push({ width, channel: channel.channel, mode, multiplier, hour: after.hour,
                            nonhourPrices: after.others, dailyPreview: after.daily });
                    }
                    if (mode === 'decrease' && [390, 1280].includes(width)) {
                        const pane = await page.$('#pricingRatioPane');
                        await pane.screenshot({ path: path.join(outputDir, `hour-ratio-${channel.channel}-${width}.png`) });
                    }
                }
            }
        }

        for (const channel of channels) {
            await page.evaluate(({ channels, selected }) => {
                const ratios = ensurePricingLadderState().ratio_settings;
                ratios.channels = channels.map(item => ({ ...item, daily_policy: { mode: 'flat', factors: [1, 1, 1, 1] } }));
                ratios.selected_channel = selected;
                ratios.drafts = {};
                ratios.daily_drafts = {};
                renderPricingRatioSettings();
            }, { channels, selected: channel.channel });
            await setValue(page, '[data-pricing-ratio-key="hour"]', '1.2');
            const adapter = require(`../price/channel_adapters/${channel.channel}_price_adapter`);
            const build = adapter.buildTierPricesByRatios || adapter.buildTierPrices;
            for (const [basis, hour] of [['2.123', '= ¥2.54'], ['3.255', '= ¥3.9']]) {
                await setValue(page, '#pricingRatioPreviewHour', basis);
                const preview = await readPreview(page);
                assert.strictEqual(preview.hour, hour, `${channel.channel}/${basis}: normalized example must match backend`);
                const prices = build([Number(basis)], { ...channel.ratios, hour: 1.2 })[0].prices;
                const expected = await page.evaluate(prices => Object.fromEntries(Object.entries(prices).map(([key, value]) =>
                    [key, `= ${window.__pricingLadderTest.formatPricingResultMoney(value)}`])), prices);
                for (const row of preview.others) assert.strictEqual(row.text, expected[row.key]);
                const dailyKey = channel.channel === 'uhaozu' ? 'day' : 'p24';
                const expectedDaily = Array(4).fill(`¥${prices[dailyKey].toFixed(2)}`).join(' / ');
                assert(preview.daily.includes(`四档日租示例：${expectedDaily}`));
                basisCases.push({ channel: channel.channel, basis, hour: preview.hour, daily: preview.daily });
            }
            for (const basis of ['0', '0.004']) {
                await setValue(page, '#pricingRatioPreviewHour', basis);
                const preview = await readPreview(page);
                assert.strictEqual(preview.hour, '= -');
                assert(preview.others.every(row => row.text === '= -'));
                assert(preview.daily.includes('请输入有效的首档示例基础时租价'));
                basisCases.push({ channel: channel.channel, basis, unavailable: true });
            }
            await setValue(page, '#pricingRatioPreviewHour', '2');
        }

        for (const channel of channels) {
            saved = clone(channels);
            await page.evaluate(({ channels, selected }) => {
                const ratios = ensurePricingLadderState().ratio_settings;
                ratios.channels = channels;
                ratios.selected_channel = selected;
                ratios.drafts = {};
                ratios.daily_drafts = {};
                renderPricingRatioSettings();
            }, { channels, selected: channel.channel });
            await setValue(page, '[data-pricing-ratio-key="hour"]', '1.2');
            const policyBefore = (await readPreview(page)).daily;
            const postCount = requests.filter(item => item.method === 'POST').length;
            holdSave = true;
            await page.click('#pricingRatioSaveBtn');
            await page.waitForFunction(() => document.querySelector('[data-pricing-ratio-key="hour"]').disabled);
            await page.evaluate(() => savePricingRatioSettings(ensurePricingLadderState().ratio_settings.channels.find(
                item => item.channel === ensurePricingLadderState().ratio_settings.selected_channel)));
            await page.waitForFunction(() => document.getElementById('pricingRatioSaveBtn').textContent.includes('保存中'));
            while (!releaseSave) await new Promise(resolve => setTimeout(resolve, 5));
            holdSave = false;
            releaseSave();
            releaseSave = null;
            await page.waitForFunction(() => !ensurePricingLadderState().ratio_settings.saving);
            assert.strictEqual(requests.filter(item => item.method === 'POST').length, postCount + 1);
            const posted = requests.filter(item => item.method === 'POST').at(-1).body;
            assert.strictEqual(posted.ratios.hour, 1.2);
            for (const key of channel.package_keys.filter(key => key !== 'hour')) assert.strictEqual(posted.ratios[key], channel.ratios[key]);
            await page.evaluate(() => loadPricingRatioSettings());
            assert.strictEqual(await page.$eval('[data-pricing-ratio-key="hour"]', node => node.value), '1.2');
            assert.strictEqual((await readPreview(page)).daily, policyBefore);
            await setValue(page, '[data-pricing-ratio-key="hour"]', '1');
            await page.click('#pricingRatioSaveBtn');
            await page.waitForFunction(() => !ensurePricingLadderState().ratio_settings.saving);
            assert.strictEqual(saved.find(item => item.channel === channel.channel).ratios.hour, 1, 'explicit new-client reset to one');
            await setValue(page, '[data-pricing-ratio-key="hour"]', '1.3');
            failNextSave = true;
            await page.click('#pricingRatioSaveBtn');
            await page.waitForFunction(() => !ensurePricingLadderState().ratio_settings.saving);
            assert.strictEqual(await page.$eval('[data-pricing-ratio-key="hour"]', node => node.value), '1.3');
            assert.strictEqual(saved.find(item => item.channel === channel.channel).ratios.hour, 1);
            await page.click(`[data-pricing-ratio-channel="${channel.channel === 'uhaozu' ? 'uuzuhao' : 'uhaozu'}"]`);
            await page.click(`[data-pricing-ratio-channel="${channel.channel}"]`);
            assert.strictEqual(await page.$eval('[data-pricing-ratio-key="hour"]', node => node.value), '1.3', 'draft survives channel switch');
        }
        assert.deepStrictEqual(unexpected, [], 'all APIs are fixture responses; no external requests');
        assert.deepStrictEqual(errors, [], 'no browser or interception errors');
        fs.writeFileSync(path.join(outputDir, 'visual-results.json'), JSON.stringify({ cases, basisCases, requests, unexpected, errors }, null, 2) + '\n');
        console.log(`[PASS] independent hourly visual: ${cases.length} preview/layout + ${basisCases.length} basis-precision cases, 3 channels x 3 policies x 3 multipliers x 6 viewports; save/reload/reset/failure/draft/duplicate protection; all APIs intercepted`);
    } finally {
        try { await browser.close(); } finally {
            for (const stream of chromeProcess.stdio || []) if (stream && typeof stream.destroy === 'function') stream.destroy();
        }
    }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
