'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const root = path.resolve(__dirname, '..');
const context = vm.createContext({ window: {} });
for (const file of ['h5/public/js/ui/channel_price_summary.js', 'h5/public/js/menu_products.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: path.join(root, file) });
}
const format = context.window.ChannelPriceSummary.formatSuffix;
for (const empty of [undefined, null, 'bad', 2]) assert.strictEqual(format(empty), '');
for (let tier = 1; tier <= 4; tier += 1) {
    assert.strictEqual(format({ current_tier: tier, hour_price: '2.3' }), ` · ${tier}档 · ¥2.30/时`);
}
for (const tier of [undefined, 0, -1, 5, 1.5, 'bad']) {
    assert.strictEqual(format({ current_tier: tier, hour_price: 2 }), ' · 未应用 · ¥2.00/时');
}
for (const price of [undefined, null, 0, -1, 'bad', Infinity]) {
    assert.strictEqual(format({ current_tier: 2, hour_price: price }), ' · 2档 · --');
}
assert.strictEqual(format({}), ' · 未应用 · --');
assert.strictEqual(format({ current_tier: '<img>', hour_price: '<script>' }), ' · 未应用 · --');
assert(Object.isFrozen(context.window.ChannelPriceSummary));
for (const [game_id, game_name] of [['1', 'WZRY'], ['2', '和平精英'], ['3', 'CFM'], ['4', 'CSGO']]) {
    const item = {
        game_id, game_name,
        channel_status: { uuzuhao: '下架', uhaozu: '上架', zuhaowang: '租赁中' },
        price_ladder: {
            uuzuhao: { current_tier: 1, desired_tier: 4, hour_price: 1.9, status: 'failed', last_error: 'secret' },
            uhaozu: { current_tier: 2, hour_price: 2.3 },
            zuhaowang: { current_tier: 3, hour_price: 2.5 }
        }
    };
    const badges = context.platformBadges(item);
    assert.strictEqual(badges[0].text, '悠悠: 下架 · 1档 · ¥1.90/时');
    assert.strictEqual(badges[1].text, 'U号: 上架 · 2档 · ¥2.30/时');
    assert.strictEqual(badges[2].text, 'ZHW: 租赁中 · 3档 · ¥2.50/时');
    assert(!badges.some((badge) => /调价失败|目标|secret|4档/.test(badge.text)));
    if (game_name === 'CSGO') assert.strictEqual(badges[3].text, '5E: 未发布');
    item.price_ladder = {};
    assert.strictEqual(context.platformBadges(item)[0].text, '悠悠: 下架');
    item.platform_status_norm = { uuzuhao: { code: 'auth_abnormal', label: '授权异常', reason: '授权失效' } };
    assert.strictEqual(context.platformBadges(item)[0].text, '悠悠: 需重新授权');
}
console.log('[PASS] product_channel_price_frontend: shared formatting, four games, status preservation and no error/target text');
