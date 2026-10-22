'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const context = vm.createContext({ window: {} });
for (const file of ['h5/public/js/ui/product_income_summary.js', 'h5/public/js/menu_products.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: path.join(root, file) });
}
const render = context.window.ProductIncomeSummary.render;
const income = (amount, status = 'ready') => ({ rental_income: { amount, status } });
const slot = (html, name) => new RegExp(`data-slot="${name}">([^<]*)</span>`).exec(html)?.[1];

for (const missing of [undefined, null, {}, { total_cost_amount: 0 }]) {
    const html = render(missing);
    assert.strictEqual(slot(html, 'total-cost'), '总成本 --');
    assert.strictEqual(slot(html, 'rental-income'), '累计租金 --');
}
for (const invalid of [undefined, null, '', '5.2', NaN, Infinity, -Infinity, false, {}, '<img src=x>']) {
    assert.strictEqual(slot(render(income(invalid)), 'rental-income'), '累计租金 --');
}
for (const status of [undefined, null, '', 'unavailable', 'failed', 'loading']) {
    assert.strictEqual(slot(render({ rental_income: { status, amount: 20 } }), 'rental-income'), '累计租金 --');
}
assert.strictEqual(slot(render(income(0)), 'rental-income'), '累计租金 ¥0.00');
assert.strictEqual(slot(render(income(-12.5)), 'rental-income'), '累计租金 ¥-12.50');
assert.strictEqual(slot(render(income(12.345)), 'rental-income'), '累计租金 ¥12.35');
assert.strictEqual(slot(render(income(123456789.12)), 'rental-income'), '累计租金 ¥123456789.12');
for (const invalidCost of [undefined, null, '', 0, -1, NaN, Infinity, '<script>']) {
    assert.strictEqual(slot(render({ total_cost_amount: invalidCost }), 'total-cost'), '总成本 --');
}
assert.strictEqual(slot(render({ total_cost_amount: '500' }), 'total-cost'), '总成本 ¥500.00');

for (const [game_id, game_name] of [['1', 'WZRY'], ['2', '和平精英'], ['3', 'CFM'], ['4', 'CSGO']]) {
    const item = { game_id, game_name, purchase_price: 500, purchase_date: '2026-01-01 12:00:00',
        total_cost_amount: 500, ...income(368.5) };
    const html = context.buildPurchaseBriefHtml(item, false);
    assert(html.includes('采购价 ¥500.00'));
    assert(html.includes('采购日期 2026-01-01'));
    assert.strictEqual(slot(html, 'total-cost'), '总成本 ¥500.00');
    assert.strictEqual(slot(html, 'rental-income'), '累计租金 ¥368.50');
    assert(/data-slot="total-cost">总成本 ¥500\.00<\/span><span class="purchase-brief-line" data-slot="rental-income">/.test(html));
    assert.strictEqual((html.match(/总成本/g) || []).length, 1);
    assert(!/待回本|已回本|差额|<button|<input|style=/.test(html));
    const sold = context.buildPurchaseBriefHtml(item, true);
    assert(sold.includes('采购价 ¥500.00'));
    assert(!sold.includes('总成本') && !sold.includes('累计租金'));
    assert(!sold.includes('product-income-brief'));
}

assert.strictEqual(render(undefined, { soldView: true }), '');
assert.strictEqual(render({ purchase_price: 500, purchase_date: 'invalid' }, { soldView: true }), '');
assert.strictEqual(render({ purchase_price: 500, purchase_date: 'invalid', total_cost_amount: 500 }, { soldView: true }), '<div class="purchase-brief"></div>');
assert(render({ total_cost_amount: 700 }, { soldView: true }).includes('总成本 ¥700.00'));
assert(render({ purchase_price: 'bad', total_cost_amount: 700 }, { soldView: true }).includes('总成本 ¥700.00'));
assert(render({ purchase_price: 500, purchase_date: '2026-01-01', total_cost_amount: 700 }, { soldView: true }).includes('总成本 ¥700.00'));
assert(!render({ purchase_price: 500, total_cost_amount: 500.001 }, { soldView: true }).includes('总成本'));
assert(!render({ purchase_price: 0, purchase_date: '2026-01-01', ...income(5) }).includes('采购日期'));
assert.strictEqual(slot(render({ purchase_price: 500, purchase_date: 'invalid', ...income(8) }), 'rental-income'), '累计租金 ¥8.00');
assert(Object.isFrozen(context.window.ProductIncomeSummary));

// Execute the actual list renderer as well as the formatter. Existing unrelated
// controls are lightweight DOM stubs; the full browser suite verifies their layout.
const renderedCards = [];
context.document = {
    createElement: () => ({
        style: {}, innerHTML: '', addEventListener() {}, contains: () => true,
        querySelector: selector => selector === '.copy-btn' ? null : { addEventListener() {} }
    })
};
context.els = {
    listContainer: { innerHTML: '', appendChild: card => renderedCards.push(card) },
    pageInfo: {}, prevPage: {}, nextPage: {}
};
Object.assign(context, {
    renderFilters() {}, startRentCountdownTicker() {},
    platformBadges: () => [], isCs2Product: () => false,
    productIdentityKey: item => `${item.game_id}::${item.game_account}`,
    formatBlacklistTimeForCard: () => '', hasAnyNormalChannel: () => true,
    buildGameAvatarHtml: () => '', buildOnlineChipHtml: () => '',
    buildForbiddenChipHtml: () => '', buildAuthRevokeStatusHtml: () => '', buildRentCountdownHtml: () => '',
    escapeAttr: value => String(value || ''), orderCountLabelByMode: () => '近24h订单'
});
for (const soldView of [false, true]) {
    renderedCards.length = 0;
    context.state = {
        currentMenu: soldView ? 'products_sold' : 'products', page: 1, pageSize: 20, total: 1,
        rentCountdownTimer: 0, onlineLoadingMap: {}, forbiddenLoadingMap: {}, steamGuardLoadingMap: {},
        list: [{ game_id: '1', game_name: 'WZRY', game_account: 'rendered-demo',
            purchase_price: 500, purchase_date: '2026-01-01', total_cost_amount: 500,
            rental_income: { amount: 368.5, status: 'ready' }, today_paid_count: 2,
            sold_price: 700, lifecycle_profit_amount: 568.5 }]
    };
    context.renderList();
    assert.strictEqual(renderedCards.length, 1);
    const html = renderedCards[0].innerHTML;
    if (soldView) {
        assert(!html.includes('累计租金'));
        assert(html.includes('售出价：¥700.00') && html.includes('生命周期总收益：¥568.50'));
    } else {
        assert.strictEqual(slot(html, 'total-cost'), '总成本 ¥500.00');
        assert.strictEqual(slot(html, 'rental-income'), '累计租金 ¥368.50');
        assert(html.includes('近24h订单：2'));
        assert(html.includes('data-op="online-query"') && html.includes('data-op="more-ops"'));
    }
    assert.strictEqual(context.els.pageInfo.textContent, '第 1 / 1 页 · 每页 20 条');
}
console.log('[PASS] product income summary: adjacent cost/income, four games, zero, unknown, invalid and unchanged sold cards');
