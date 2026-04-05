'use strict';

const assert = require('assert');
const { _internals } = require('../product/product');

(async () => {
    const info = _internals.buildPlatformPrdInfo('uhaozu', {
        id: '1132566414',
        remark: '萌鱼脚',
        raw: {
            gameId: 'CJZC001',
            gameRoleName: '萌鱼脚',
            auditReason: '',
            authStatus: 1,
            goodsStatus: 3,
            rentStatus: 1,
            customerUnshelves: false,
            concreteRentalByHour: 610,
            concreteRentalByNight: 2396,
            concreteRentalByDay: 3743,
            concreteRentalByWeek: 24950
        }
    });

    assert.strictEqual(info.prd_id, '1132566414');
    assert.strictEqual(info.role_name, '萌鱼脚');
    assert.strictEqual(info.rentalByHour, 6.1);
    assert.strictEqual(info.rentalByNight, 23.96);
    assert.strictEqual(info.rentalByDay, 37.43);
    assert.strictEqual(info.rentalByWeek, 249.5);

    console.log('[OK] product_uhaozu_prd_info_smoke_test passed');
})().catch((err) => {
    console.error('[FAIL] product_uhaozu_prd_info_smoke_test failed:', err);
    process.exit(1);
});
