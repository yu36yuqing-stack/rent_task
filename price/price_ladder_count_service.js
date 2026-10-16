'use strict';

const { getPriceLadderFeatureConfig } = require('../database/price_ladder_feature_config_db');
const { listPaidCountByAccounts } = require('../order/service/order_query_service');
const { resolvePriceLadderCountWindow } = require('../common/price_ladder_count_mode');

async function getPriceLadderCountContext(userId, options = {}) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    const feature = options.feature || await getPriceLadderFeatureConfig(uid);
    return { feature, ...resolvePriceLadderCountWindow(feature.count_mode, options.now) };
}

async function listPriceLadderOrderCounts(userId, accounts = [], options = {}) {
    const context = options.context || await getPriceLadderCountContext(userId, options);
    const counts = await listPaidCountByAccounts(userId, accounts, {
        mode: context.count_mode,
        now: context.window_end
    });
    return { ...context, counts };
}

module.exports = { getPriceLadderCountContext, listPriceLadderOrderCounts };
