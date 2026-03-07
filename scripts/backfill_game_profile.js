#!/usr/bin/env node
const { openDatabase } = require('../database/sqlite_client');
const { normalizeGameProfile } = require('../common/game_profile');

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

function run(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.run(sql, params, function onRun(err) {
            if (err) return reject(err);
            resolve(this);
        });
    });
}

function parseJsonObject(raw) {
    try {
        const parsed = JSON.parse(String(raw || '{}')) || {};
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        return parsed;
    } catch {
        return {};
    }
}

function nowText() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function inferAccountGameProfile(row = {}) {
    const candidates = [];
    candidates.push({ game_id: row.game_id, game_name: row.game_name, source: 'row' });
    const prd = parseJsonObject(row.channel_prd_info);
    for (const platform of ['uuzuhao', 'uhaozu', 'zuhaowang']) {
        const one = prd && prd[platform] && typeof prd[platform] === 'object' ? prd[platform] : {};
        candidates.push({
            game_id: one.game_id,
            game_name: one.game_name,
            source: platform
        });
    }
    for (const candidate of candidates) {
        const normalized = normalizeGameProfile(candidate.game_id, candidate.game_name, { preserveUnknown: true });
        if (normalized.canonical) return normalized;
    }
    return normalizeGameProfile(row.game_id, row.game_name, { preserveUnknown: true });
}

async function backfillUserGameAccount(db) {
    const rows = await all(db, `
        SELECT id, game_id, game_name, channel_prd_info
        FROM user_game_account
        WHERE is_deleted = 0
    `);
    let updated = 0;
    for (const row of rows) {
        const next = inferAccountGameProfile(row);
        const currentId = String(row.game_id || '').trim();
        const currentName = String(row.game_name || '').trim();
        if (currentId === next.game_id && currentName === next.game_name) continue;
        await run(db, `
            UPDATE user_game_account
            SET game_id = ?, game_name = ?, modify_date = ?, desc = ?
            WHERE id = ?
        `, [
            next.game_id,
            next.game_name,
            nowText(),
            'backfill canonical game profile',
            Number(row.id)
        ]);
        updated += 1;
    }
    return updated;
}

async function backfillOrder(db) {
    const rows = await all(db, `
        SELECT id, game_id, game_name
        FROM "order"
        WHERE is_deleted = 0
    `);
    let updated = 0;
    for (const row of rows) {
        const next = normalizeGameProfile(row.game_id, row.game_name, { preserveUnknown: true });
        const currentId = String(row.game_id || '').trim();
        const currentName = String(row.game_name || '').trim();
        if (currentId === next.game_id && currentName === next.game_name) continue;
        await run(db, `
            UPDATE "order"
            SET game_id = ?, game_name = ?, modify_date = ?, desc = ?
            WHERE id = ?
        `, [
            next.game_id,
            next.game_name,
            nowText(),
            'backfill canonical game profile',
            Number(row.id)
        ]);
        updated += 1;
    }
    return updated;
}

async function main() {
    const db = openDatabase();
    try {
        const accountUpdated = await backfillUserGameAccount(db);
        const orderUpdated = await backfillOrder(db);
        console.log(JSON.stringify({ ok: true, account_updated: accountUpdated, order_updated: orderUpdated }));
    } finally {
        db.close();
    }
}

main().catch((err) => {
    console.error(JSON.stringify({ ok: false, error: String(err && err.message ? err.message : err) }));
    process.exit(1);
});
