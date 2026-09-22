'use strict';

const {
    getUserChannelPackageRatio,
    saveUserChannelPackageRatio
} = require('../database/user_channel_package_ratio_db');
const { normalizeRatios, resolvePackageRatios } = require('./channel_package_ratio');
const {
    getPriceChannelAdapter,
    listPriceChannelCapabilities
} = require('./channel_adapters/channel_price_registry');

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
    const saved = await saveUserChannelPackageRatio(uid, {
        channel,
        ratios
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
        source: 'saved',
        version: saved.version,
        modify_date: saved.modify_date,
        queued_count: Number(queued && queued.queued || 0)
    };
}

module.exports = {
    getPackageRatioSettingsByUser,
    savePackageRatioSettingsByUser,
    _internal: { getUserChannelPackageRatio }
};
