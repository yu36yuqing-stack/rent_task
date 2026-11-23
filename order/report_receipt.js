'use strict';

// Persist source evidence alongside the existing sync description. Old orders without
// a marker can still be verified from their saved platform detail.
function receiptNote(description, sourceAmount, settled = true) {
    if (!settled) return description + ' [receipt:pending]';
    const value = typeof sourceAmount === 'number' || typeof sourceAmount === 'string'
        ? String(sourceAmount).trim() : '';
    if (!/^\d+(?:\.\d+)?$/.test(value)) return description + ' [receipt:missing]';
    return description + ' [receipt:' + Number(value).toFixed(2) + ']';
}
module.exports = { receiptNote };
