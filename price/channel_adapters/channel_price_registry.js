'use strict';

const uhaozu = require('./uhaozu_price_adapter');
const uuzuhao = require('./uuzuhao_price_adapter');

const adapters = Object.freeze([uhaozu, uuzuhao]);
const disabledCapabilities = Object.freeze([
    {
        channel: 'zuhaowang',
        label: '租号玩',
        enabled: false,
        package_keys: ['hour', 'day'],
        package_labels: { hour: '时租', day: '日租' }
    }
]);

function getPriceChannelAdapter(channel) {
    const name = String(channel || '').trim();
    return adapters.find((adapter) => adapter.channel === name) || null;
}

function listEnabledPriceChannelAdapters(accountRow = null) {
    if (!accountRow) return adapters.slice();
    return adapters.filter((adapter) => adapter.isAvailable(accountRow));
}

function listPriceChannelCapabilities() {
    return [
        { ...uhaozu.capability },
        ...disabledCapabilities.map((item) => ({ ...item })),
        { ...uuzuhao.capability }
    ];
}

module.exports = {
    getPriceChannelAdapter,
    listEnabledPriceChannelAdapters,
    listPriceChannelCapabilities,
    _internal: { adapters, disabledCapabilities }
};
