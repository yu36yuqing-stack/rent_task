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
    console
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
assert.strictEqual(helpers.pricingApplyStatusText('manual'), '渠道手工价（不会自动纠正）');
assert.strictEqual(helpers.pricingApplyStatusText('pending'), '待执行换档');
assert.strictEqual(helpers.pricingApplyStatusText('blocked'), '受上下架安全规则阻塞');
assert.strictEqual(helpers.pricingApplyStatusText('failed'), '上次换档失败');
assert.strictEqual(helpers.pricingApplyStatusText('unknown'), '套餐数据暂不完整');
assert.strictEqual(helpers.pricingTierLabel(1), '第 1 单价（完成 0 单）');
assert.strictEqual(helpers.pricingTierLabel(2), '第 2 单价（完成 1 单后）');
assert.strictEqual(helpers.pricingTierLabel(9), '第 4 单价（完成 3 单后）');

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
