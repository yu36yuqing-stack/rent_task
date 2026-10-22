'use strict';

function money(value) {
    const number = Number(value);
    return Number.isFinite(number) ? Number(number.toFixed(2)) : 0;
}

// Weekly snapshots are cumulative. Only add daily totals strictly after the
// latest snapshot; adding the snapshot's own day would count it twice.
// The dashboard retains its historical zero fallback. Product cards opt into
// strict mode so missing/corrupt statistics cannot masquerade as known zero.
function buildHistoricalIncomeTotals(accounts, snapshotRows, dailyRows, options = {}) {
    const strict = options.strict === true;
    const keys = new Set(accounts);
    const latest = new Map();
    for (const row of snapshotRows) {
        const account = String(row.game_account || '').trim();
        if (!keys.has(account)) continue;
        const old = latest.get(account);
        if (!old || String(row.snapshot_date) > String(old.snapshot_date)
            || (String(row.snapshot_date) === String(old.snapshot_date) && Number(row.id || 0) > Number(old.id || 0))) {
            latest.set(account, row);
        }
    }
    const valid = (value) => value !== null && value !== '' && Number.isFinite(Number(value));
    const validDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
    const totals = new Map();
    for (const account of keys) {
        const base = latest.get(account);
        totals.set(account, base ? (strict && (!valid(base.total_rec_amount) || !validDate(base.snapshot_date)) ? null : money(base.total_rec_amount)) : (strict ? null : 0));
    }
    const invalid = new Set();
    for (const row of dailyRows) {
        const account = String(row.game_account || '').trim();
        if (!keys.has(account)) continue;
        const base = latest.get(account);
        const snapshotDate = String(base && base.snapshot_date || '').slice(0, 10);
        if (snapshotDate && String(row.stat_date || '').slice(0, 10) <= snapshotDate) continue;
        const next = Number(totals.get(account) || 0) + Number(row.amount_rec_sum || 0);
        if (strict && (!valid(row.amount_rec_sum) || !validDate(row.stat_date) || !Number.isFinite(next)
            || Number(row.invalid_count || 0) > 0 || (base && totals.get(account) === null))) {
            invalid.add(account);
            continue;
        }
        totals.set(account, money(next));
    }
    for (const account of invalid) totals.set(account, null);
    return totals;
}

module.exports = { buildHistoricalIncomeTotals };
