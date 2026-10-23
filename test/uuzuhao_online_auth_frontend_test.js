'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const common = require('../common/uuzuhao_auth_state');
const context = vm.createContext({ window: {} });
for (const file of ['ui/channel_price_summary.js', 'ui/uuzuhao_auth_status.js', 'menu_products.js']) {
    const source = path.resolve(__dirname, '../h5/public/js', file);
    vm.runInContext(fs.readFileSync(source, 'utf8'), context, { filename: source });
}
const ui = context.window.UuzuhaoAuthStatus;
assert.strictEqual(ui.isRequired(null), false);
assert.strictEqual(ui.isRequired({ uuzuhao_auth_state: { required: 'true' } }), false);
assert.strictEqual(ui.mainLabel({}, '状态正常', false), '状态正常');
assert.ok(Object.isFrozen(ui));
assert.strictEqual(ui.message, common.REAUTHORIZE_MESSAGE, 'legacy callers retain the QQ authorization message');
assert.strictEqual(ui.messageFor(null), common.REAUTHORIZE_MESSAGE);
assert.strictEqual(ui.messageFor({}), common.REAUTHORIZE_MESSAGE);
assert.strictEqual(ui.messageFor({ uuzuhao_auth_state: {} }), common.REAUTHORIZE_MESSAGE);
assert.strictEqual(ui.messageFor({ uuzuhao_auth_state: { error_code: 12101001 } }), common.PRODUCT_NOT_FOUND_MESSAGE);
for (const game_id of ['1', '2', '3', '4']) {
  for (const error_code of ['201010027', ' 12101001 ', '12115014', '12115012']) {
    const item = { game_id, game_name: game_id === '4' ? 'CSGO' : 'WZRY',
        uuzuhao_auth_state: { required: true, version: 2, error_code },
        channel_status: { uuzuhao: '上架', uhaozu: '上架', zuhaowang: '租赁中' },
        price_ladder: { uuzuhao: { current_tier: 3, desired_tier: 4, hour_price: 2.9 },
            uhaozu: { current_tier: 1, hour_price: 2 }, zuhaowang: { current_tier: 2, hour_price: 3 } } };
    assert.strictEqual(ui.mainLabel(item, '状态正常', false), '需重新授权');
    assert.strictEqual(ui.mainLabel(item, '', false), '需重新授权');
    assert.strictEqual(ui.mainLabel(item, '冷却中 · 10-22 20:00', false), '冷却中 · 10-22 20:00');
    assert.strictEqual(ui.mainLabel(item, '维护中', false), '维护中');
    assert.strictEqual(ui.mainLabel(item, '已售', true), '已售');
    const badges = context.platformBadges(item);
    assert.strictEqual(badges[0].text, '悠悠: 授权异常 · 3档 · ¥2.90/时');
    assert.strictEqual(badges[0].code, 'auth_abnormal');
    assert.strictEqual(badges[0].auth_required, true);
    assert.strictEqual(badges[0].reason, common.pausedOnlineError(item.uuzuhao_auth_state).message,
        'the backend and card must explain the same stored failure');
    if (error_code.trim() === '12101001') {
        assert.ok(badges[0].reason.includes('悠悠商品不存在'));
        assert.ok(badges[0].reason.includes('恢复商品'));
        assert.ok(!badges[0].reason.includes('QQ鉴权失败'));
    } else if (common.SHELF_AUTH_ERROR_CODES.includes(error_code)) {
        assert.strictEqual(badges[0].reason, common.SHELF_REAUTHORIZE_MESSAGES[error_code]);
        assert.ok(!badges[0].reason.includes('QQ鉴权失败'));
        assert.ok(!badges[0].reason.includes('点击“状态查询”恢复'));
    } else {
        assert.ok(badges[0].reason.includes('号主前往悠悠租号重新授权'));
    }
    assert.strictEqual(badges[1].text, 'U号: 上架 · 1档 · ¥2.00/时');
    assert.strictEqual(badges[2].text, 'ZHW: 租赁中 · 2档 · ¥3.00/时');
    assert.strictEqual(ui.applyState(item, { data: { uuzuhao_auth_state: { required: false, version: 1 } } }), false);
    assert.strictEqual(ui.isRequired(item), true);
    assert.strictEqual(ui.applyState(item, { data: { uuzuhao_auth_state: { required: false, version: 3 } } }), true);
    assert.strictEqual(ui.isRequired(item), false);
    assert.strictEqual(context.platformBadges(item)[0].text, '悠悠: 上架 · 3档 · ¥2.90/时');
    assert.strictEqual(ui.applyState(item, { data: { uuzuhao_auth_state: { required: true } } }), false);
    assert.strictEqual(ui.applyState(item, {}), false);
    assert.strictEqual(ui.applyState(item, { data: { uuzuhao_auth_state: { required: 'false' } } }), false);
  }
}
assert.strictEqual(ui.applyState(null, { data: { uuzuhao_auth_state: { required: true } } }), false);
assert.strictEqual(ui.applyState({}, { data: { uuzuhao_auth_state: { required: false } } }), true);
console.log('[PASS] online auth frontend: top priority, blacklist preservation, four games, pricing retention and stale-response protection');
