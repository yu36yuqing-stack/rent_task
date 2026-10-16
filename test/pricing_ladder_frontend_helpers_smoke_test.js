#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const source = fs.readFileSync(path.join(__dirname, '../h5/public/js/menu_price.js'), 'utf8');
const context = {
    window: {},
    URLSearchParams,
    console,
    state: { pricing: { channel_sheet: { view: 'result' } } }
};
vm.createContext(context);
vm.runInContext(source, context, { filename: path.join(__dirname, '../h5/public/js/menu_price.js') });
const helpers = context.window.__pricingLadderTest;

assert(helpers);
assert.strictEqual(helpers.normalizePricingCountMode(), 'rolling_24h');
assert.strictEqual(helpers.normalizePricingCountMode('invalid'), 'rolling_24h');
assert.strictEqual(helpers.normalizePricingCountMode('business_day'), 'business_day');
assert.strictEqual(helpers.pricingCountWindowLabel('rolling_24h'), '近24小时');
assert.strictEqual(helpers.pricingCountWindowLabel('business_day'), '每日06:00切日');
assert.strictEqual(helpers.pricingCountSummary('business_day', 2), '本周期 2单');
assert.strictEqual(helpers.pricingCountSummary('rolling_24h', 0), '近24h 0单');
assert.strictEqual(helpers.pricingCountWindowRange('2026-10-15T22:00:00.000Z', '2026-10-16T06:00:00.000Z'), '10/16 06:00—10/16 14:00（北京时间）');
assert.strictEqual(helpers.pricingCountWindowRange('', '2026-10-16T06:00:00.000Z'), '');
assert.strictEqual(helpers.pricingCountWindowRange('invalid', 'invalid'), '');
assert.strictEqual(helpers.normalizePricingGameName('CS2'), 'CSGO');
assert.strictEqual(helpers.normalizePricingGameName('和平精英'), '和平精英');
assert.strictEqual(helpers.normalizePricingGameName('穿越火线手游'), 'CFM');
assert.strictEqual(helpers.normalizePricingGameName('unknown'), 'WZRY');
assert.strictEqual(helpers.formatPricingMoney(2.4), '2.4');
assert.strictEqual(helpers.formatPricingMoney(0), '');
assert.strictEqual(helpers.formatPricingMoney('bad'), '');
assert.strictEqual(helpers.formatPricingResultMoney(2.4), '¥2.4');
assert.strictEqual(helpers.formatPricingResultMoney(0), '-');
assert.strictEqual(helpers.pricingApplyStatusText('effective'), '渠道价格与当前档一致');
assert.strictEqual(helpers.pricingApplyStatusText('effective_partial'), '时租价格与当前档一致');
assert.strictEqual(helpers.pricingApplyStatusText('manual'), '渠道手工价（不会自动纠正）');
assert.strictEqual(helpers.pricingApplyStatusText('pending'), '待执行换档');
assert.strictEqual(helpers.pricingApplyStatusText('blocked'), '受上下架安全规则阻塞');
assert.strictEqual(helpers.pricingApplyStatusText('failed'), '上次换档失败');
assert.strictEqual(helpers.pricingApplyStatusText('unknown'), '套餐数据暂不完整');
assert.strictEqual(helpers.pricingTierLabel(1), '1档时租价');
assert.strictEqual(helpers.pricingTierLabel(2), '2档时租价');
assert.strictEqual(helpers.pricingTierLabel(3), '3档时租价');
assert.strictEqual(helpers.pricingTierLabel(9), '4档时租价');
assert.strictEqual(helpers.pricingTierLabel(0), '1档时租价');
assert.strictEqual(helpers.pricingLogStatusText('success'), '成功');
assert.strictEqual(helpers.pricingLogStatusText('fail'), '失败');
assert.strictEqual(helpers.pricingLogTriggerText('rule_saved'), '保存策略');
assert.strictEqual(helpers.pricingLogTriggerText('package_ratio_saved'), '套餐倍率变更');
assert.strictEqual(helpers.pricingLogTriggerText('daily_reset'), '06:00重置');
assert.strictEqual(helpers.pricingLogTriggerText('unknown'), '阶梯调价');
assert.strictEqual(helpers.pricingLogTriggerText('rolling_24h_reconcile'), '近24h换档');
assert.strictEqual(helpers.pricingTierSummary({}), '阶梯调价：未启用');
assert.strictEqual(helpers.pricingTierSummary({ configured: true, current_tier: 0, desired_tier: 3 }), '当前未应用 · 目标第3档 · 待换档');
assert.strictEqual(helpers.pricingTierSummary({ configured: true, current_tier: 2, desired_tier: 3, ladder_status: 'failed' }), '当前第2档 · 目标第3档 · 换档失败');
assert.strictEqual(helpers.pricingTierSummary({ configured: true, current_tier: 3, desired_tier: 3 }), '当前第3档 · 目标第3档');
assert.strictEqual(helpers.pricingTierSummary({ configured: true, current_tier: 3, desired_tier: 3, ladder_status: 'pending' }), '当前第3档 · 目标第3档 · 待换档');
const pendingHtml = helpers.renderPricingChannelResult({ current_tier: 3, desired_tier: 3 }, {
    available: true, current_tier: 0, desired_tier: 3, apply_status: 'failed',
    runtime: { last_error: '<network timeout>' }, tiers: [{ tier: 3, prices: { hour: 4 } }]
});
assert(pendingHtml.includes('当前未应用 · 目标第3档 · 换档失败'));
assert(pendingHtml.includes('&lt;network timeout&gt;'));
assert(!pendingHtml.includes(' · 当前使用'));

const listContainer = { innerHTML: '', querySelectorAll: () => [] };
const windowText = { textContent: '' };
context.els = { pricingView: {}, pricingListContainer: listContainer };
context.document = { getElementById: id => id === 'pricingWindowText' ? windowText : null };
context.applyPricingPayload({ list: [{ game_account: 'demo', configured: true, current_tier: 2, desired_tier: 3, today_order_count: 2, prices: [2,3,4,5] }] });
context.renderPricingView();
assert.strictEqual(windowText.textContent, '');
assert.strictEqual(windowText.hidden, true);
assert(listContainer.innerHTML.includes('近24h 2单'));
assert(listContainer.innerHTML.includes('当前第2档 · 目标第3档 · 待换档'));
assert(listContainer.innerHTML.includes('aria-label="1档时租价"'));
assert(!listContainer.innerHTML.includes('档时租价（'));
assert.strictEqual(context.state.pricing.feature.count_mode, 'rolling_24h');
const businessResultHtml = helpers.renderPricingChannelResult({
    count_mode: 'business_day', count_window: '每日06:00切日', current_order_count: 2,
    window_start: '2026-10-15T22:00:00Z', window_end: '2026-10-16T06:00:00Z'
}, { available: true });
assert(businessResultHtml.includes('每日06:00切日 · 本周期 2单'));
assert(businessResultHtml.includes('10/16 06:00—10/16 14:00（北京时间）'));

const errorDetail = helpers.formatPricingErrorDetail({
    fail_message: '商品更新失败',
    error_detail: {
        stage: 'modify',
        code: 'PRICE_RANGE',
        uhaozu_response: { responseCode: 'PRICE_RANGE', responseMsg: '包夜价超限' }
    }
});
assert(errorDetail.includes('失败阶段：modify'));
assert(errorDetail.includes('错误代码：PRICE_RANGE'));
assert(errorDetail.includes('包夜价超限'));
const logHtml = helpers.renderPricingChannelLogs({
    adjustment_logs: [
        {
            id: 1,
            publish_status: 'success',
            trigger_source: 'daily_reset',
            create_date: '2026-09-20 06:00:00',
            before_prices: { hour: 3 },
            target_prices: { hour: 2.4, night: 9.6, day: 14.4, week: 84 },
            remote_prices: { hour: 2.4 }
        },
        {
            id: 2,
            publish_status: 'fail',
            trigger_source: 'order_finished_changed',
            fail_message: '范围错误',
            target_prices: { hour: 3 }
        }
    ]
});
assert(logHtml.includes('06:00重置'));
assert(logHtml.includes('data-pricing-error-detail="2"'));
assert(!logHtml.includes('data-pricing-error-detail="1"'));
assert(helpers.renderPricingChannelLogs({ adjustment_logs: [] }).includes('暂无 U号租调价记录'));
assert(helpers.renderPricingChannelLogs({
    label: '悠悠租号',
    package_keys: ['hour', 'p2'],
    package_labels: { hour: '时租', p2: '2小时' },
    adjustment_logs: [{
        id: 3,
        publish_status: 'success',
        target_prices: { hour: 2, p2: 3.6 },
        before_prices: { hour: 1.8 },
        remote_prices: { hour: 2 }
    }]
}).includes('2小时 ¥3.6'));
const uuzuhaoResultHtml = helpers.renderPricingChannelResult({ current_tier: 2 }, {
    label: '悠悠租号',
    available: true,
    package_keys: ['hour', 'p2', 'p3', 'p5', 'p7', 'p9', 'p10', 'p24', 'p168'],
    package_labels: {
        hour: '时租',
        p2: '2小时',
        p3: '3小时',
        p5: '5小时',
        p7: '7小时',
        p9: '9小时',
        p10: '10小时',
        p24: '24小时',
        p168: '168小时'
    },
    remote_current: { hour: 3 },
    current_tier: 2,
    apply_status: 'effective_partial',
    goods_id: 'product-1',
    min_rent_hour: 2,
    verification_note: '时租价已回读验证，套餐价以平台成功响应为准',
    tiers: [{ tier: 2, prices: { hour: 3, p2: 5.4, p168: 302.4 } }],
    adjustment_logs: []
});
assert(uuzuhaoResultHtml.includes('package-count-9'));
assert(uuzuhaoResultHtml.includes('时租价已回读验证'));
assert(uuzuhaoResultHtml.includes('起租 2 小时'));
assert(uuzuhaoResultHtml.includes('data-label="2小时"'));
assert(uuzuhaoResultHtml.includes('data-label="24小时"'));
assert(uuzuhaoResultHtml.includes('data-label="168小时"'));
assert(!uuzuhaoResultHtml.includes('包周'));
const uhaozuValuesHtml = helpers.renderPricingPackageValues(
    { hour: 2, night: 8, day: 12, week: 70 },
    ['hour', 'night', 'day', 'week'],
    { hour: '时租', night: '包夜', day: '包天', week: '包周' }
);
assert(uhaozuValuesHtml.includes('data-label="包夜"'));
assert(uhaozuValuesHtml.includes('data-label="包周"'));

const filteredByName = helpers.filterPricingItems([
    { display_name: '呆小姚', game_account: '2630403808' },
    { display_name: '和平一号', game_account: 'hpjy-a' }
], '小姚');
assert.strictEqual(filteredByName.length, 1);
assert.strictEqual(filteredByName[0].game_account, '2630403808');
assert.strictEqual(helpers.filterPricingItems(filteredByName, '2630').length, 1);
assert.strictEqual(helpers.filterPricingItems(filteredByName, '不存在').length, 0);

const draft = helpers.normalizePricingDraft({
    prices: [2.4, 3.4],
    copied_from_game_account: 'source-a'
});
assert.deepStrictEqual(Array.from(draft.prices), ['2.4', '3.4', '', '']);
assert.strictEqual(draft.copied_from_game_account, 'source-a');
assert.deepStrictEqual(Array.from(helpers.validatePricingDraft({ prices: ['2.4', '3.4', '5.4', '10.4'] })), [2.4, 3.4, 5.4, 10.4]);
assert.deepStrictEqual(Array.from(helpers.validatePricingDraft({ prices: ['', ' ', '', ''] })), []);
assert.throws(() => helpers.validatePricingDraft({ prices: [1, 2, 3] }), /第 1 至第 4 单/);
assert.throws(() => helpers.validatePricingDraft({ prices: [1, '', 3, 4] }), /全部填写，或全部清空/);
assert.throws(() => helpers.validatePricingDraft({ prices: [1, 2, 0, 4] }), /大于 0/);
assert.strictEqual(helpers.formatPricingRatio(4.50001), '4.5');
const ratioChannel = {
    package_keys: ['hour', 'p24', 'p72'],
    package_labels: { hour: '时租', p24: '24小时', p72: '72小时' },
    ratios: { hour: 1, p24: 4.5, p72: 13.5 }
};
assert.deepStrictEqual(JSON.parse(JSON.stringify(helpers.normalizePricingRatioDraft(ratioChannel))), {
    hour: '1', p24: '4.5', p72: '13.5'
});
assert.deepStrictEqual(JSON.parse(JSON.stringify(helpers.validatePricingRatioDraft(ratioChannel, {
    hour: '8', p24: '5.25', p72: '14'
}))), { hour: 1, p24: 5.25, p72: 14 });
assert.throws(() => helpers.validatePricingRatioDraft(ratioChannel, { p24: '0', p72: '14' }), /24小时倍率/);
assert.deepStrictEqual(JSON.parse(JSON.stringify(helpers.calculatePricingRatioPreview(
    ratioChannel,
    { hour: '1', p24: '4.5', p72: '13.5' },
    '2.2'
))), [
    { key: 'hour', label: '时租', hour_price: 2.2, ratio: 1, price: 2.2 },
    { key: 'p24', label: '24小时', hour_price: 2.2, ratio: 4.5, price: 9.9 },
    { key: 'p72', label: '72小时', hour_price: 2.2, ratio: 13.5, price: 29.7 }
]);
assert.strictEqual(helpers.calculatePricingRatioPreview(ratioChannel, { p24: 'bad', p72: '13.5' }, '0')[1].price, 0);
const zuhaowangRatioChannel = {
    ...ratioChannel,
    price_rules: {
        hour: { decimals: 2, rounding: 'round' },
        p24: { decimals: 1, rounding: 'truncate' },
        p72: { decimals: 1, rounding: 'truncate' }
    }
};
assert.strictEqual(helpers.normalizePricingPreviewPrice(13.75, { decimals: 1, rounding: 'truncate' }), 13.7);
assert.strictEqual(helpers.normalizePricingPreviewPrice(13.26, { decimals: 1, rounding: 'round' }), 13.3);
assert.deepStrictEqual(JSON.parse(JSON.stringify(helpers.calculatePricingRatioPreview(
    zuhaowangRatioChannel,
    { hour: '1', p24: '5.5', p72: '15' },
    '2.5'
))).map((item) => item.price), [2.5, 13.7, 37.5]);

async function testSavedRuntimeDisplay() {
    const item = context.state.pricing.list[0];
    context.showToast = () => {};
    const card = { querySelectorAll: () => [2, 3, 4, 5].map(value => ({ value: String(value) })) };
    for (const status of ['applied', 'failed']) {
        context.request = async () => ({ rule: {
            prices: [2,3,4,5], version: 2,
            runtime: { applied_tier: status === 'applied' ? 3 : 2, desired_tier: 3, completed_order_count: 2, status, last_error: status === 'failed' ? 'timeout' : '' },
            publish_result: { applied: status === 'applied' ? 1 : 0, failed: status === 'failed' ? 1 : 0 }
        } });
        await context.savePricingAccount('demo', card);
        assert.strictEqual(item.current_tier, status === 'applied' ? 3 : 2);
        assert.strictEqual(item.desired_tier, 3);
        assert.strictEqual(item.ladder_status, status);
        assert(listContainer.innerHTML.includes(status === 'applied' ? '当前第3档 · 目标第3档' : '当前第2档 · 目标第3档 · 换档失败'));
    }
}
async function testCountModeSettings() {
    const select = { value: 'rolling_24h', disabled: false };
    const helpSummary = { textContent: '' };
    const helpDescription = { textContent: '' };
    const status = { textContent: '' };
    const toggle = { checked: false, disabled: false };
    const nodes = { pricingCountMode: select, pricingWindowText: windowText, pricingWindowHelpSummary: helpSummary, pricingWindowHelpDescription: helpDescription };
    context.document.getElementById = id => nodes[id] || null;
    context.els.pricingFeatureStatus = status;
    context.els.pricingFeatureToggle = toggle;
    const list = context.state.pricing.list;
    let feature = { enabled: false, count_mode: 'rolling_24h', reconcile_required: false, version: 3 };
    context.applyPricingPayload({ list, feature });
    context.renderPricingView();
    const requests = [];
    const toasts = [];
    let releaseSave;
    context.showToast = text => toasts.push(text);
    context.request = async (url, options) => {
        requests.push({ url, body: options && JSON.parse(options.body) });
        if (options) {
            await new Promise(resolve => { releaseSave = resolve; });
            feature = { ...feature, ...JSON.parse(options.body), reconcile_required: true, version: feature.version + 1 };
            return { feature };
        }
        return {
            list, feature, count_mode: feature.count_mode, count_window: '每日06:00切日',
            window_start: '2026-10-15T22:00:00Z', window_end: '2026-10-16T06:00:00Z'
        };
    };
    const saving = context.updatePricingCountMode('business_day');
    assert.strictEqual(select.disabled, true);
    assert.strictEqual(toggle.disabled, true);
    assert.strictEqual(select.value, 'business_day');
    assert.strictEqual(status.textContent, '保存中...');
    await context.updatePricingCountMode('rolling_24h');
    assert.strictEqual(requests.length, 1);
    releaseSave();
    await saving;
    assert.deepStrictEqual(JSON.parse(JSON.stringify(requests[0].body)), { enabled: false, count_mode: 'business_day', expected_version: 3 });
    assert(requests[1].url.startsWith('/api/pricing/ladder?'));
    assert.strictEqual(context.state.pricing.count_mode, 'business_day');
    assert.strictEqual(select.disabled, false);
    assert.strictEqual(toggle.checked, false);
    assert.strictEqual(windowText.textContent, '10/16 06:00—10/16 14:00（北京时间）');
    assert.strictEqual(windowText.hidden, false);
    assert.strictEqual(helpSummary.textContent, '档位按每日06:00切日有效订单数计算：');
    assert(helpDescription.textContent.includes('凌晨6点前从前一天06:00算起'));
    assert(listContainer.innerHTML.includes('本周期 2单'));
    assert(toasts.at(-1).includes('开启自动调价后生效'));
    await context.updatePricingCountMode('business_day');
    assert.strictEqual(requests.length, 2);

    context.request = async () => { throw new Error('配置已更新，请刷新后重试'); };
    await context.updatePricingCountMode('rolling_24h');
    assert.strictEqual(select.value, 'business_day');
    assert.strictEqual(select.disabled, false);
    assert.strictEqual(context.state.pricing.feature.version, 4);
    assert.strictEqual(toasts.at(-1), '配置已更新，请刷新后重试');
    context.window.confirm = () => false;
    await context.updatePricingFeature(true);
    assert.strictEqual(toggle.checked, false);

    context.window.confirm = () => true;
    context.request = async (url, options) => {
        if (options) {
            const body = JSON.parse(options.body);
            assert.strictEqual(body.count_mode, 'business_day');
            assert.strictEqual(body.expected_version, 4);
            feature = { ...feature, enabled: true, reconcile_required: true, version: 5 };
            return { feature };
        }
        return { list, feature, count_mode: 'business_day' };
    };
    await context.updatePricingFeature(true);
    assert.strictEqual(status.textContent, '待重算');
    assert.strictEqual(select.value, 'business_day');
    assert.strictEqual(toggle.checked, true);
    assert(toasts.at(-1).includes('已开启'));
    context.request = async (url, options) => {
        if (options) {
            feature = { ...feature, count_mode: 'rolling_24h', version: 6 };
            return { feature };
        }
        return { list, feature };
    };
    await context.updatePricingCountMode('rolling_24h');
    assert.strictEqual(select.value, 'rolling_24h');
    assert(listContainer.innerHTML.includes('近24h 2单'));
    assert(helpDescription.textContent.includes('订单移出窗口'));
    assert(toasts.at(-1).includes('下一轮订单同步成功后重新计算'));
}

testSavedRuntimeDisplay().then(testCountModeSettings).then(() => console.log('[OK] pricing_ladder_frontend_helpers_smoke_test passed')).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
