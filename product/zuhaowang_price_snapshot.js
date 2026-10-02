'use strict';

const PRICE_FIELDS = Object.freeze({
    hourPrice: ['hourPrice', 'hour_price', 'obtainPrice'],
    p24Price: ['p24Price', 'p24_price'],
    p72Price: ['p72Price', 'p72_price'],
    p168Price: ['p168Price', 'p168_price']
});
const META_FIELDS = ['rent_mode', 'price_template_type'];

function pickZuhaowangSyncPriceFields(row = {}) {
    const raw = row.raw && typeof row.raw === 'object' ? row.raw : {};
    const fields = {};
    for (const key of [...Object.values(PRICE_FIELDS).flat(), ...META_FIELDS]) {
        if (Object.hasOwn(row, key)) fields[key] = row[key];
        else if (Object.hasOwn(raw, key)) fields[key] = raw[key];
    }
    return fields;
}

function validPrice(snapshot, aliases) {
    for (const key of aliases) {
        const value = snapshot[key];
        if (typeof value !== 'number' && typeof value !== 'string') continue;
        if (typeof value === 'string' && !value.trim()) continue;
        const price = Number(value);
        if (Number.isFinite(price) && price > 0) return price;
    }
    return null;
}

function mergeZuhaowangSyncPriceSnapshot(previous = {}, incoming = {}) {
    const oldId = String(previous.prd_id || previous.data_id || '').trim();
    const newId = String(incoming.prd_id || incoming.data_id || '').trim();
    const sameProduct = Boolean(oldId && newId && oldId === newId);
    // Retain only pricing fields, never stale status, reasons or other product facts.
    const merged = { ...incoming };
    for (const [key, aliases] of Object.entries(PRICE_FIELDS)) {
        for (const alias of aliases) delete merged[alias];
        const nextPrice = validPrice(incoming, aliases);
        const price = nextPrice === null && sameProduct ? validPrice(previous, aliases) : nextPrice;
        if (price !== null) merged[key] = price;
    }
    for (const key of META_FIELDS) {
        if (sameProduct && !Object.hasOwn(incoming, key) && Object.hasOwn(previous, key)) {
            merged[key] = previous[key];
        }
    }
    // day_only still retains the historical hourly basis used to calculate day prices.
    return merged;
}

module.exports = { pickZuhaowangSyncPriceFields, mergeZuhaowangSyncPriceSnapshot };
