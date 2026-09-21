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
vm.runInContext(source, context, { filename: 'menu_price.js' });
const helpers = context.window.__pricingLadderTest;

assert(helpers);
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
assert.strictEqual(helpers.pricingTierLabel(1), '第 1 单价（完成 0 单）');
assert.strictEqual(helpers.pricingTierLabel(2), '第 2 单价（完成 1 单后）');
assert.strictEqual(helpers.pricingTierLabel(9), '第 4 单价（完成 3 单后）');
assert.strictEqual(helpers.pricingLogStatusText('success'), '成功');
assert.strictEqual(helpers.pricingLogStatusText('fail'), '失败');
assert.strictEqual(helpers.pricingLogTriggerText('rule_saved'), '保存策略');
assert.strictEqual(helpers.pricingLogTriggerText('daily_reset'), '06:00重置');
assert.strictEqual(helpers.pricingLogTriggerText('unknown'), '阶梯调价');

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

console.log('[OK] pricing_ladder_frontend_helpers_smoke_test passed');
