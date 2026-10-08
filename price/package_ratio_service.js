'use strict';

const {
    getUserChannelPackageRatio,
    saveUserChannelPackageRatio
} = require('../database/user_channel_package_ratio_db');
const { normalizeRatios, resolvePackageRatios } = require('./channel_package_ratio');
const { normalizeDailyPolicy, applyDailyPolicy } = require('./daily_price_policy');
const { listAccountPriceLadderRulesByUser } = require('../database/account_price_ladder_rule_db');
const {
    getPriceChannelAdapter,
    listPriceChannelCapabilities
} = require('./channel_adapters/channel_price_registry');

function validateDailyPolicyForRules(adapter, ratios, dailyPolicy, rules, accounts) {
    if (dailyPolicy.mode === 'follow') return;
    const live = new Map(accounts.filter((row) => !Number(row.is_deleted || 0) && row.asset_status !== 'sold'
        && adapter.isAvailable(row)).map((row) => [`${row.game_id}::${row.game_account}`, row]));
    for (const rule of rules) {
        if (!live.has(`${rule.game_id}::${rule.game_account}`)) continue;
        const tiers = adapter.buildTierPricesByRatios
            ? adapter.buildTierPricesByRatios(rule.prices, ratios) : adapter.buildTierPrices(rule.prices, ratios);
        try {
            applyDailyPolicy(tiers, adapter.capability, dailyPolicy,
                adapter.normalizePackagePrice || ((key, value) => Number(value.toFixed(2))));
        } catch (error) {
            const wrapped = new Error(`${rule.game_name} / ${rule.game_account}：${error.message}`);
            wrapped.code = error.code;
            throw wrapped;
        }
    }
}

async function getPackageRatioSettingsByUser(userId) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    const capabilities = listPriceChannelCapabilities().filter((item) => item.enabled === true);
    const channels = await Promise.all(capabilities.map(async (capability) => {
        const resolved = await resolvePackageRatios(uid, capability);
        return {
            channel: capability.channel,
            label: capability.label,
            enabled: capability.enabled,
            package_keys: capability.package_keys.slice(),
            package_labels: { ...capability.package_labels },
            price_rules: { ...(capability.price_rules || {}) },
            ratios: resolved.ratios,
            daily_policy: resolved.daily_policy,
            source: resolved.source,
            version: resolved.version,
            modify_date: resolved.modify_date
        };
    }));
    return { channels };
}

async function savePackageRatioSettingsByUser(userId, input = {}) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    const channel = String(input.channel || '').trim();
    const adapter = getPriceChannelAdapter(channel);
    if (!adapter || !adapter.capability || adapter.capability.enabled !== true) {
        throw new Error(`不支持的调价渠道: ${channel || '-'}`);
    }
    const ratios = normalizeRatios(adapter.capability, input.ratios, { strict: true });
    const current = await getUserChannelPackageRatio(uid, channel);
    const dailyPolicy = normalizeDailyPolicy(input.daily_policy === undefined ? current && current.daily_policy : input.daily_policy);
    if (dailyPolicy.mode !== 'follow') {
        const { _internal: { listAllAccountsByUser } } = require('./price_ladder_service');
        validateDailyPolicyForRules(adapter, ratios, dailyPolicy,
            await listAccountPriceLadderRulesByUser(uid), await listAllAccountsByUser(uid));
    }
    const saved = await saveUserChannelPackageRatio(uid, {
        channel,
        ratios,
        daily_policy: dailyPolicy
    }, {
        expected_version: input.expected_version,
        desc: 'saved by h5 package ratio settings'
    });
    const { enqueueChannelPackageRatioChange } = require('./price_ladder_reconcile_service');
    const queued = await enqueueChannelPackageRatioChange(uid, channel, {
        trigger_source: 'package_ratio_saved'
    });
    return {
        channel,
        label: adapter.capability.label,
        package_keys: adapter.capability.package_keys.slice(),
        package_labels: { ...adapter.capability.package_labels },
        price_rules: { ...(adapter.capability.price_rules || {}) },
        ratios: saved.ratios,
        daily_policy: saved.daily_policy,
        source: 'saved',
        version: saved.version,
        modify_date: saved.modify_date,
        queued_count: Number(queued && queued.queued || 0)
    };
}

module.exports = {
    getPackageRatioSettingsByUser,
    savePackageRatioSettingsByUser,
    validateDailyPolicyForRules,
    _internal: { getUserChannelPackageRatio }
};
