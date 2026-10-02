'use strict';

const { listAccountPriceLadderRuntimesByUser } = require('../database/account_price_ladder_runtime_db');
const { listUserPlatformAuth } = require('../database/user_platform_auth_db');
const { listEnabledPriceChannelAdapters } = require('./channel_adapters/channel_price_registry');

function accountKey(row) {
    return `${String(row.game_id || '1').trim()}::${String(row.game_account || '').trim()}`;
}

async function getProductChannelPriceSummaries(userId, accountRows = []) {
    const uid = Number(userId);
    if (!Number.isInteger(uid) || uid <= 0) throw new Error('user_id 不合法');
    const accounts = accountRows.filter((row) => row
        && (!row.user_id || Number(row.user_id) === uid)
        && !Number(row.is_deleted || 0)
        && String(row.asset_status || 'active').trim().toLowerCase() !== 'sold'
        && String(row.game_account || '').trim());
    if (!accounts.length) return {};

    let auths;
    try {
        auths = await listUserPlatformAuth(uid, { with_payload: false });
    } catch (error) {
        console.warn(`[ProductChannelPrice] user_id=${uid} stage=auth error_code=${error.code || 'READ_FAILED'}`);
        return {};
    }
    const disabled = new Set(auths.filter((row) => row.channel_enabled === false).map((row) => row.platform));
    let runtimes = [];
    try {
        runtimes = await listAccountPriceLadderRuntimesByUser(uid);
    } catch (error) {
        // Snapshot prices remain usable; never infer an applied tier from a target or rule.
        console.warn(`[ProductChannelPrice] user_id=${uid} stage=runtime error_code=${error.code || 'READ_FAILED'}`);
    }
    const runtimeMap = new Map(runtimes
        .filter((row) => Number(row.user_id) === uid && !Number(row.is_deleted || 0))
        .map((row) => [`${accountKey(row)}::${row.channel}`, row]));
    const summaries = {};
    for (const account of accounts) {
        const key = accountKey(account);
        const channels = {};
        for (const adapter of listEnabledPriceChannelAdapters(account)) {
            if (disabled.has(adapter.channel)) continue;
            const runtime = runtimeMap.get(`${key}::${adapter.channel}`);
            const tier = Number(runtime && runtime.applied_tier);
            const price = Number(adapter.pickCurrentPriceSet(account).prices.hour);
            channels[adapter.channel] = {
                current_tier: Number.isInteger(tier) && tier >= 1 && tier <= 4 ? tier : 0,
                hour_price: Number.isFinite(price) && price > 0 ? price : null
            };
        }
        summaries[key] = channels;
    }
    return summaries;
}

module.exports = { getProductChannelPriceSummaries };
