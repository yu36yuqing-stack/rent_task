'use strict';

const { getUserChannelPackageRatio } = require('../database/user_channel_package_ratio_db');

function roundRatio(value) {
    const n = Number(value);
    return Number.isFinite(n) ? Number(n.toFixed(4)) : 0;
}

function normalizeRatios(capability = {}, input = {}, options = {}) {
    const keys = Array.isArray(capability.package_keys) ? capability.package_keys : [];
    const defaults = capability.default_ratios && typeof capability.default_ratios === 'object'
        ? capability.default_ratios
        : {};
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const strict = options.strict === true;
    const out = {};
    for (const key of keys) {
        if (key === 'hour') {
            out.hour = 1;
            continue;
        }
        const raw = source[key] === undefined ? defaults[key] : source[key];
        const value = roundRatio(raw);
        if (strict && (!Number.isFinite(value) || value <= 0)) {
            throw new Error(`${capability.package_labels && capability.package_labels[key] || key}倍率必须大于 0`);
        }
        out[key] = value;
    }
    return out;
}

async function resolvePackageRatios(userId, capability = {}) {
    const saved = await getUserChannelPackageRatio(userId, capability.channel);
    const ratios = normalizeRatios(capability, saved && saved.ratios || {}, { strict: true });
    return {
        ratios,
        version: Number(saved && saved.version || 0),
        source: saved ? 'saved' : 'default',
        modify_date: String(saved && saved.modify_date || '').trim()
    };
}

module.exports = {
    roundRatio,
    normalizeRatios,
    resolvePackageRatios
};
