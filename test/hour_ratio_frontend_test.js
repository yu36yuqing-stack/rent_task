'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { applyDailyPolicy } = require('../price/daily_price_policy');

const root = path.resolve(__dirname, '..');
const plain = value => JSON.parse(JSON.stringify(value));
const channels = ['uhaozu', 'uuzuhao', 'zuhaowang'].map(name => {
    const adapter = require(`../price/channel_adapters/${name}_price_adapter`);
    return { ...plain(adapter.capability), ratios: { ...adapter.capability.default_ratios },
        daily_policy: { mode: 'decrease', factors: [1, 1, 0.95, 0.9] }, source: 'saved', version: 1 };
});

function node(attributes = {}) {
    return { attributes, textContent: '', value: attributes.value || '', disabled: attributes.disabled === true,
        getAttribute(key) { return this.attributes[key]; } };
}

function createFixture() {
    const nodes = { pricingRatioPreviewHour: node({ value: '2' }) };
    let results = [];
    let inputs = [];
    let buttons = [];
    const panel = { html: '', querySelector: selector => selector === '[data-daily-preview]' ? nodes.dailyPreview : null,
        querySelectorAll: selector => selector === '[data-pricing-ratio-key]' ? inputs : [] };
    Object.defineProperty(panel, 'innerHTML', {
        get() { return this.html; },
        set(html) {
            this.html = html;
            inputs = [...html.matchAll(/<input\b[^>]*data-pricing-ratio-key="([^"]+)"[^>]*>/g)].map(match =>
                node({ 'data-pricing-ratio-key': match[1], value: /value="([^"]*)"/.exec(match[0])[1],
                    disabled: /\bdisabled\b/.test(match[0]) }));
            results = [...html.matchAll(/data-pricing-ratio-result-key="([^"]+)"/g)].map(match =>
                node({ 'data-pricing-ratio-result-key': match[1] }));
            nodes.pricingRatioSaveBtn = /id="pricingRatioSaveBtn"/.test(html) ? node() : null;
            nodes.dailyPreview = node();
        }
    });
    const tabs = { html: '', querySelectorAll: () => buttons };
    Object.defineProperty(tabs, 'innerHTML', {
        get() { return this.html; },
        set(html) {
            this.html = html;
            buttons = [...html.matchAll(/data-pricing-ratio-channel="([^"]+)"/g)].map(match =>
                node({ 'data-pricing-ratio-channel': match[1] }));
        }
    });
    nodes.pricingRatioPanel = panel;
    nodes.pricingRatioChannelTabs = tabs;
    const calls = [], toasts = [];
    let saved = plain(channels);
    const context = { window: {}, console, URLSearchParams, AbortController, setTimeout, clearTimeout,
        state: { user: { id: 123 }, currentMenu: 'pricing_ratios' },
        document: { activeElement: null, getElementById: key => nodes[key] || null,
            querySelectorAll: () => results },
        showToast: text => toasts.push(text),
        request: async (url, options) => {
            calls.push({ url, ...options });
            if (!options) return { channels: plain(saved) };
            const body = JSON.parse(options.body);
            const current = saved.find(channel => channel.channel === body.channel);
            Object.assign(current, { ratios: body.ratios, daily_policy: body.daily_policy, version: current.version + 1 });
            return { setting: { ...plain(current), queued_count: 2 } };
        } };
    vm.createContext(context);
    for (const file of ['h5/public/js/ui/daily_price_policy.js', 'h5/public/js/menu_price.js']) {
        vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: path.join(root, file) });
    }
    const ratioState = context.ensurePricingLadderState().ratio_settings;
    ratioState.channels = plain(saved);
    return { context, nodes, panel, ratioState, calls, toasts,
        input: key => inputs.find(input => input.attributes['data-pricing-ratio-key'] === key),
        result: key => results.find(result => result.attributes['data-pricing-ratio-result-key'] === key),
        button: key => buttons.find(button => button.attributes['data-pricing-ratio-channel'] === key) };
}

async function main() {
    const f = createFixture();
    const helpers = f.context.window.__pricingLadderTest;
    assert.deepStrictEqual(plain(helpers.normalizePricingRatioDraft()), {});
    for (const channel of channels) {
        assert.strictEqual(helpers.normalizePricingRatioDraft({ ...channel, ratios: { ...channel.ratios, hour: 1.2 } }).hour, '1.2');
        const withoutHour = { ...channel.ratios };
        delete withoutHour.hour;
        assert.strictEqual(helpers.normalizePricingRatioDraft({ ...channel, ratios: withoutHour }).hour, '1');
        const original = helpers.calculatePricingRatioPreview(channel, helpers.normalizePricingRatioDraft(channel), '2');
        for (const multiplier of [0.9, 1, 1.2, 0.3333]) {
            const draft = { ...helpers.normalizePricingRatioDraft(channel), hour: String(multiplier) };
            const parsed = helpers.validatePricingRatioDraft(channel, draft);
            assert.strictEqual(parsed.hour, multiplier);
            const next = helpers.calculatePricingRatioPreview(channel, draft, '2');
            assert.strictEqual(next[0].price, Number((2 * multiplier).toFixed(2)));
            assert.deepStrictEqual(plain(next.slice(1)), plain(original.slice(1)), `${channel.channel}: other packages cannot compound hourly multiplier`);
            for (const mode of ['follow', 'flat', 'decrease']) {
                const policy = f.context.window.DailyPricePolicy.draft({ mode, factors: [1, 1, 0.95, 0.9] });
                const preview = ratios => f.context.window.DailyPricePolicy.preview(policy, { ...channel, ratios }, '2', helpers.normalizePricingPreviewPrice);
                assert.strictEqual(preview(parsed), preview(channel.ratios), `${channel.channel}/${mode}: daily preview stays based on raw hourly basis`);
            }
        }
        for (const bad of ['', ' ', 'NaN', 'Infinity', '-1', '0', '0.00001']) {
            assert.throws(() => helpers.validatePricingRatioDraft(channel, { ...channel.ratios, hour: bad }), /时租倍率必须大于 0/);
        }
        assert.strictEqual(helpers.validatePricingRatioDraft(channel, { ...channel.ratios, hour: '1.23456' }).hour, 1.2346);
        assert.strictEqual(helpers.calculatePricingRatioPreview(channel, { ...channel.ratios, hour: '0.00001' }, '2')[0].price, 0);
        assert.strictEqual(helpers.calculatePricingRatioPreview(channel, { ...channel.ratios, hour: 'bad' }, '2')[0].price, 0);
        assert(helpers.calculatePricingRatioPreview(channel, channel.ratios, 'bad').every(row => row.price === 0));
        const adapter = require(`../price/channel_adapters/${channel.channel}_price_adapter`);
        const build = adapter.buildTierPricesByRatios || adapter.buildTierPrices;
        const ratios = { ...channel.ratios, hour: 1.2 };
        const normalizeBackend = (key, value) => adapter.normalizePackagePrice
            ? adapter.normalizePackagePrice(key, value) : Number(value.toFixed(2));
        for (const [basis, normalizedBasis, expectedHour] of [[2.123, 2.12, 2.54], [3.255, 3.25, 3.9]]) {
            const backend = build([basis, basis, basis, basis], ratios);
            const preview = helpers.calculatePricingRatioPreview(channel, ratios, String(basis));
            assert.strictEqual(preview[0].hour_price, normalizedBasis, `${channel.channel}: normalize base before multiplication`);
            assert.strictEqual(preview[0].price, expectedHour);
            assert.deepStrictEqual(plain(preview).map(row => row.price),
                channel.package_keys.map(key => backend[0].prices[key]),
                `${channel.channel}/${basis}: inline preview matches real adapter prices`);
            for (const mode of ['flat', 'decrease']) {
                const ui = f.context.window.DailyPricePolicy;
                const draft = ui.draft({ mode, factors: [1, 1, 0.95, 0.9] });
                const effective = applyDailyPolicy(backend, adapter.capability, plain(ui.parse(draft)), normalizeBackend);
                const dailyKey = channel.channel === 'uhaozu' ? 'day' : 'p24';
                const expectedDaily = effective.map(row => `¥${row.prices[dailyKey].toFixed(2)}`).join(' / ');
                const text = ui.preview(draft, { ...channel, ratios }, basis, helpers.normalizePricingPreviewPrice);
                assert(text.includes(`四档日租示例：${expectedDaily}`), `${channel.channel}/${basis}/${mode}: daily preview matches real policy`);
                const shortKeys = channel.channel === 'uhaozu' ? ['night']
                    : channel.channel === 'uuzuhao' ? ['p2', 'p3', 'p5', 'p7', 'p9', 'p10'] : [];
                if (mode === 'decrease') for (const key of shortKeys) {
                    assert(text.includes(effective.map(row => `¥${row.prices[key].toFixed(2)}`).join(' / ')),
                        `${channel.channel}/${basis}/${key}: related discount uses normalized basis`);
                }
            }
        }
        for (const basis of ['0', '0.004', '-1', '', 'NaN', 'Infinity']) {
            assert(helpers.calculatePricingRatioPreview(channel, ratios, basis).every(row => row.price === 0),
                `${channel.channel}/${basis}: invalid or rounded-zero basis cannot produce a quote`);
            for (const mode of ['follow', 'flat', 'decrease']) {
                const ui = f.context.window.DailyPricePolicy;
                const text = ui.preview(ui.draft({ mode }), { ...channel, ratios }, basis, helpers.normalizePricingPreviewPrice);
                assert(text.includes('请输入有效的首档示例基础时租价'), `${channel.channel}/${mode}/${basis}`);
                assert(!text.includes('¥'), 'invalid example must not display a calculated amount');
            }
        }
    }

    f.context.renderPricingRatioSettings();
    assert.strictEqual(f.input('hour').disabled, false);
    assert(!f.panel.innerHTML.includes('时租固定为1倍'));
    assert(f.panel.innerHTML.includes('各套餐独立乘原始基础时租价'));
    const first = f.ratioState.channels[0];
    const baselineOther = f.result('day').textContent;
    const baselineDaily = f.nodes.dailyPreview.textContent;
    f.input('hour').value = '1.2';
    f.input('hour').oninput();
    assert.strictEqual(f.result('hour').textContent, '= ¥2.4');
    assert.strictEqual(f.result('day').textContent, baselineOther);
    assert.strictEqual(f.nodes.dailyPreview.textContent, baselineDaily);
    f.button('uuzuhao').onclick();
    assert.strictEqual(f.input('hour').value, '1');
    f.input('hour').value = '0.9';
    f.input('hour').oninput();
    f.button('uhaozu').onclick();
    assert.strictEqual(f.input('hour').value, '1.2', 'drafts must remain isolated across channels');

    let release;
    const request = f.context.request;
    f.context.request = async (...args) => {
        await new Promise(resolve => { release = resolve; });
        return request(...args);
    };
    const saving = f.context.savePricingRatioSettings(first);
    assert.strictEqual(f.ratioState.saving, true);
    assert.strictEqual(f.input('hour').disabled, true);
    await f.context.savePricingRatioSettings(first);
    release();
    await saving;
    assert.strictEqual(f.calls.length, 1, 'duplicate save must not submit twice');
    const body = JSON.parse(f.calls[0].body);
    assert.strictEqual(body.hour_ratio_editable, true);
    assert.strictEqual(body.ratios.hour, 1.2);
    assert.strictEqual(body.ratios.day, 6);
    assert.strictEqual(body.expected_version, 1);
    assert.strictEqual(f.input('hour').disabled, false);
    assert(f.toasts.at(-1).includes('下次同步生效'));
    f.context.request = request;
    await f.context.loadPricingRatioSettings();
    assert.strictEqual(f.input('hour').value, '1.2', 'server save/reload must not reset to one');
    assert.strictEqual(f.ratioState.preview_hour, '2', 'example basis is local-only');
    assert(!Object.hasOwn(body, 'preview_hour'));

    f.input('hour').value = '0';
    f.input('hour').oninput();
    const count = f.calls.length;
    await f.context.savePricingRatioSettings(f.ratioState.channels[0]);
    assert.strictEqual(f.calls.length, count);
    assert(f.toasts.at(-1).includes('时租倍率必须大于 0'));
    f.input('hour').value = '1.3';
    f.input('hour').oninput();
    f.context.request = async () => { throw new Error('fixture save failure'); };
    await f.context.savePricingRatioSettings(f.ratioState.channels[0]);
    assert.strictEqual(f.input('hour').value, '1.3', 'failed saves preserve the editable draft');
    assert.strictEqual(f.input('hour').disabled, false);
    assert.strictEqual(f.toasts.at(-1), 'fixture save failure');
    console.log('[PASS] independent hourly frontend: three channels, normalization, inline preview, other-package/daily invariance, legacy default, isolated drafts, guarded save, reload and failure');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
