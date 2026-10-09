'use strict';

const assert = require('assert');
const { normalizeDailyPolicy, applyDailyPolicy } = require('../price/daily_price_policy');
const ui = require('../h5/public/js/ui/daily_price_policy');
const adapters = ['uhaozu', 'zuhaowang', 'uuzuhao'].map(name => require(`../price/channel_adapters/${name}_price_adapter`));
const money = (key, value) => Number(value.toFixed(2));
const decrease = { mode: 'decrease', factors: [1, 1, 0.95, 0.9] };
const discounted = { mode: 'decrease', factors: [0.95, 0.9, 0.85, 0.85] };
assert.deepStrictEqual(normalizeDailyPolicy(discounted), discounted);
assert.deepStrictEqual(normalizeDailyPolicy({ mode: 'flat', factors: discounted.factors }).factors, [1, 1, 1, 1]);
assert.strictEqual(normalizeDailyPolicy().mode, 'follow');
assert.deepStrictEqual(normalizeDailyPolicy(null), normalizeDailyPolicy({}));
assert.deepStrictEqual(normalizeDailyPolicy({ mode: 'flat' }).factors, [1, 1, 1, 1]);
for (const invalid of [true, [], 'bad', { mode: 'bad' }, { factors: [] }, { factors: [1,1,1] },
    { factors: [1,1,1,'0.9'] }, { factors: [1,1,1,NaN] }, { factors: [1,1,1,0] },
    { factors: [1,1,1,2] }, { factors: [0.9,0.95,0.8,0.7] }, { factors: [1,0.8,0.9,0.7] },
    { factors: [0,0,0,0] }, { factors: [-0.1,0.1,0.1,0.1] }, { factors: [1.01,1,1,1] },
    { factors: [0.000001,0.000001,0.000001,0.000001] },
    { factors: [1,1,1,0.000001] }]) assert.throws(() => normalizeDailyPolicy(invalid));

for (const adapter of adapters) {
    const key = adapter.channel === 'uhaozu' ? 'day' : 'p24';
    const build = adapter.buildTierPricesByRatios || adapter.buildTierPrices;
    const original = build([2,2.2,2.4,2.6], adapter.default_ratios);
    const normalize = adapter.normalizePackagePrice || money;
    const discountBase = build([2,2.1,2.2,2.3], adapter.default_ratios);
    const discountedTiers = applyDailyPolicy(discountBase, adapter.capability, discounted, normalize);
    for (let i = 0; i < 4; i++) {
        assert.strictEqual(discountedTiers[i].prices[key], normalize(key, discountBase[0].prices[key] * discounted.factors[i]),
            'every tier uses the undiscounted daily base, not the discounted first tier');
        for (const other of adapter.package_keys.filter(k => k !== key)) {
            const expected = adapter.channel === 'uhaozu' && other === 'night'
                ? normalize('night', discountBase[0].prices.night * discounted.factors[i]) : discountBase[i].prices[other];
            assert.strictEqual(discountedTiers[i].prices[other], expected);
        }
    }
    assert.strictEqual(discountedTiers[2].prices[key], discountedTiers[3].prices[key]);
    assert.strictEqual(applyDailyPolicy(original, adapter.capability, {}, normalize), original);
    const flat = applyDailyPolicy(original, adapter.capability, { mode: 'flat' }, normalize);
    const down = applyDailyPolicy(original, adapter.capability, decrease, normalize);
    for (let i = 0; i < 4; i++) {
        assert.strictEqual(flat[i].prices[key], original[0].prices[key]);
        assert.strictEqual(down[i].prices[key], normalize(key, original[0].prices[key] * decrease.factors[i]));
        for (const other of adapter.package_keys.filter(k => k !== key)) {
            const expected = adapter.channel === 'uhaozu' && other === 'night'
                ? normalize('night', original[0].prices.night * decrease.factors[i]) : original[i].prices[other];
            assert.strictEqual(down[i].prices[other], expected);
            assert.strictEqual(flat[i].prices[other], original[i].prices[other]);
        }
    }
    assert.deepStrictEqual(original, build([2,2.2,2.4,2.6], adapter.default_ratios), 'source prices not mutated');
    assert.throws(() => applyDailyPolicy([], adapter.capability, decrease, normalize), /不完整/);
    const missing = original.map(t => ({...t, prices: {...t.prices, [key]: 0}}));
    assert.throws(() => applyDailyPolicy(missing, adapter.capability, decrease, normalize), /不完整/);
    assert.throws(() => applyDailyPolicy(original, adapter.capability, decrease, () => 0), /精度/);
    const conflict = original.map(t => ({...t, prices: {...t.prices, hour: 1000}}));
    assert.throws(() => applyDailyPolicy(conflict, adapter.capability, decrease, normalize), /冲突/);
    const long = adapter.package_keys.at(-1);
    const cheapLong = original.map(t => ({...t, prices: {...t.prices, [long]: 0.1}}));
    assert.throws(() => applyDailyPolicy(cheapLong, adapter.capability, decrease, normalize), /冲突/);
    const zero = original.map(t => ({...t, prices: {...t.prices, [long]: NaN}}));
    assert.throws(() => applyDailyPolicy(zero, adapter.capability, decrease, normalize), /大于0/);
}

const uhaozu = adapters[0];
const actual = uhaozu.buildTierPricesByRatios([1.6,1.9,2.1,2.5], uhaozu.default_ratios);
const repaired = applyDailyPolicy(actual, uhaozu.capability, discounted, money);
assert.deepStrictEqual(repaired.map(t => t.prices.night), [6.08,5.76,5.44,5.44]);
assert.deepStrictEqual(repaired.map(t => t.prices.day), [9.12,8.64,8.16,8.16]);
assert.deepStrictEqual(repaired.map(t => t.prices.hour), [1.6,1.9,2.1,2.5]);
assert.deepStrictEqual(repaired.map(t => t.prices.week), actual.map(t => t.prices.week));
assert.throws(() => applyDailyPolicy(actual, uhaozu.capability, {mode:'flat'}, money), /包夜/);
for (const night of [NaN,0,-1]) {
    const broken = actual.map((t,i) => ({...t,prices:{...t.prices,night:i === 0 ? night : t.prices.night}}));
    assert.throws(() => applyDailyPolicy(broken, uhaozu.capability, discounted, money), /大于0/);
}
assert.throws(() => applyDailyPolicy(actual, uhaozu.capability, discounted,
    (key,value) => key === 'night' ? 0 : money(key,value)), /大于0/);
const inverted = uhaozu.buildTierPricesByRatios([1.6,1.9,2.1,2.5], {...uhaozu.default_ratios,night:7});
assert.throws(() => applyDailyPolicy(inverted, uhaozu.capability, discounted, money), /包夜/);

const draft = ui.draft(decrease);
assert.deepStrictEqual(draft.percentages, ['100','100','95','90']);
assert.deepStrictEqual(ui.parse(draft), decrease);
assert.deepStrictEqual(ui.parse(ui.draft(discounted)), discounted);
assert.strictEqual(ui.draft().mode, 'follow');
assert.deepStrictEqual(ui.parse({mode:'flat',percentages:[]}).factors, [1,1,1,1]);
assert.deepStrictEqual(ui.parse({mode:'follow',percentages:[100,100,100,101]}),
    {mode:'follow',factors:[1,1,0.95,0.9]},'hidden invalid decrease draft cannot prevent restoring the legacy mode');
for (const input of [{mode:'bad'}, {mode:'decrease',percentages:[]},
    {mode:'decrease',percentages:['99',100,95,90]}, {mode:'decrease',percentages:[100,80,90,70]},
    {mode:'decrease',percentages:[0,0,0,0]}, {mode:'decrease',percentages:[101,90,85,85]},
    {mode:'decrease',percentages:['bad',90,85,85]}, {mode:'decrease',percentages:['',90,85,85]},
    {mode:'decrease',percentages:[100,100,'',90]}, {mode:'decrease',percentages:[100,100,'bad',90]}]) assert.throws(()=>ui.parse(input));
const escape = v => String(v).replaceAll('<','&lt;').replaceAll('"','&quot;');
assert(ui.render(draft,false,escape).includes('日租递减'));
assert(!ui.render(draft,false,escape).includes('disabled'), 'all four decrease inputs are editable');
assert.strictEqual((ui.render(draft,true,escape).match(/<input[^>]*disabled/g) || []).length, 4);
assert(ui.render({mode:'flat',percentages:['<bad>',100,100,100]},true,escape).includes('&lt;bad>'));
assert(ui.render(ui.draft(),false,escape).includes('hidden'));
const normalize = (value, rule={}) => rule.rounding==='truncate' ? Math.trunc(Number((value*10).toFixed(8)))/10 : Number(value.toFixed(2));
const channel={channel:'uhaozu',ratios:{day:6,night:4}};
assert(ui.preview(ui.draft(discounted),channel,2,normalize).includes('¥11.40 / ¥10.80 / ¥10.20 / ¥10.20'));
assert(ui.preview(ui.draft(discounted),channel,1.6,normalize).includes('四档包夜示例：¥6.08 / ¥5.76 / ¥5.44 / ¥5.44'));
for (const night of [undefined,0,NaN]) {
    assert(ui.preview(ui.draft(discounted),{...channel,ratios:{day:6,night}},2,normalize).includes('有效的包夜倍率'));
}
assert(!ui.preview(ui.draft({mode:'flat'}),channel,2,normalize).includes('包夜示例'));
assert(!ui.preview(ui.draft(discounted),{channel:'uuzuhao',ratios:{p24:6}},2,normalize).includes('包夜示例'));
assert(ui.preview(draft,channel,2,normalize).includes('¥12.00 / ¥12.00 / ¥11.40 / ¥10.80'));
assert(ui.preview(ui.draft(),channel,2,normalize).includes('各档时租'));
assert(ui.preview(draft,channel,0,normalize).includes('请输入'));
assert(ui.preview({mode:'bad'},channel,2,normalize).includes('有效'));
assert(ui.preview(draft,{channel:'zuhaowang',ratios:{p24:4.5},price_rules:{p24:{rounding:'truncate'}}},2.31,normalize).includes('¥10.30 / ¥10.30 / ¥9.70 / ¥9.20'));
let rerender;
const button={getAttribute:()=> 'flat'},input={getAttribute:()=> '3',value:'85'};
ui.bind({querySelectorAll:s=>s.includes('mode')?[button]:[input]},draft,value=>{rerender=value;});
button.onclick();assert.strictEqual(draft.mode,'flat');assert.strictEqual(rerender,true);
input.oninput();assert.strictEqual(draft.percentages[3],'85');assert.strictEqual(rerender,false);
console.log('[PASS] daily policy calculation, precision, conflicts and frontend component');
