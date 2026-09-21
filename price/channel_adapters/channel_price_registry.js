'use strict';

const uhaozu = require('./uhaozu_price_adapter');
const zuhaowang = require('./zuhaowang_price_adapter');
const uuzuhao = require('./uuzuhao_price_adapter');

const adapters = Object.freeze([uhaozu, zuhaowang, uuzuhao]);
const disabledCapabilities = Object.freeze([]);

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
        { ...zuhaowang.capability },
        { ...uuzuhao.capability }
    ];
}

module.exports = {
    getPriceChannelAdapter,
    listEnabledPriceChannelAdapters,
    listPriceChannelCapabilities,
    _internal: { adapters, disabledCapabilities }
};
