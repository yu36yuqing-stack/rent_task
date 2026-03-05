#!/usr/bin/env node
const { openDatabase } = require('../database/sqlite_client');
const { upsertSourceAndReconcile } = require('../blacklist/blacklist_source_gateway');
const { getBlacklistV2Mode } = require('../blacklist/blacklist_reconciler');

function parseArgs(argv = []) {
    const out = {
        user_id: 0,
        game_account: '',
        dry_run: false
    };
    for (let i = 0; i < argv.length; i += 1) {
        const a = String(argv[i] || '').trim();
        if (!a) continue;
        if (a === '--dry-run' || a === '--dry_run') {
            out.dry_run = true;
            continue;
        }
        if (a.startsWith('--user_id=')) {
            out.user_id = Number(a.slice('--user_id='.length) || 0);
            continue;
        }
        if (a === '--user_id' && i + 1 < argv.length) {
            out.user_id = Number(argv[i + 1] || 0);
            i += 1;
            continue;
        }
        if (a.startsWith('--game_account=')) {
            out.game_account = String(a.slice('--game_account='.length) || '').trim();
            continue;
        }
        if (a === '--game_account' && i + 1 < argv.length) {
            out.game_account = String(argv[i + 1] || '').trim();
            i += 1;
            continue;
        }
    }
    return out;
}

function parseJsonObject(text) {
    try {
        const obj = JSON.parse(String(text || '{}'));
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
        return {};
    } catch {
        return {};
    }
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

async function listTargets(filters = {}) {
    const uid = Number(filters.user_id || 0);
    const acc = String(filters.game_account || '').trim();
    const db = openDatabase();
    try {
        const where = [
            `is_deleted = 0`,
            `source = 'order_cooldown'`,
            `active = 1`
        ];
        const params = [];
        if (uid > 0) {
            where.push('user_id = ?');
            params.push(uid);
        }
        if (acc) {
            where.push('game_account = ?');
            params.push(acc);
        }
        const sql = `
            SELECT id, user_id, game_account, source, active, reason, detail, expire_at, modify_date, desc
            FROM user_blacklist_source
            WHERE ${where.join(' AND ')}
            ORDER BY user_id ASC, game_account ASC
        `;
        const rows = await all(db, sql, params);
        return rows.filter((row) => {
            const detail = parseJsonObject(row && row.detail);
            const cooldownUntil = Number((detail && detail.cooldown_until) || 0);
            return !(cooldownUntil > 0);
        });
    } finally {
        db.close();
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const mode = Number(getBlacklistV2Mode());
    const targets = await listTargets(args);
    console.log(`[FixOrderCooldownSource] mode=${mode} dry_run=${args.dry_run} targets=${targets.length}`);
    if (targets.length === 0) return;

    let fixed = 0;
    for (const row of targets) {
        const uid = Number(row.user_id || 0);
        const acc = String(row.game_account || '').trim();
        if (!uid || !acc) continue;
        const detail = parseJsonObject(row.detail);
        const patchDetail = {
            ...detail,
            fixed_by: 'fix_order_cooldown_source',
            fixed_at: new Date().toISOString(),
            fixed_reason: 'missing_cooldown_until'
        };
        console.log(`[FixOrderCooldownSource] target user_id=${uid} account=${acc} reason=${String(row.reason || '')} modify_date=${String(row.modify_date || '')}`);
        if (args.dry_run) continue;
        await upsertSourceAndReconcile(uid, acc, 'order_cooldown', {
            active: false,
            reason: String(row.reason || '冷却期下架').trim() || '冷却期下架',
            detail: patchDetail
        }, {
            source: 'fix_order_cooldown_source',
            operator: 'script',
            desc: 'fix dirty order_cooldown source without cooldown_until'
        });
        fixed += 1;
    }
    console.log(`[FixOrderCooldownSource] done fixed=${fixed} total=${targets.length} dry_run=${args.dry_run}`);
}

main().catch((e) => {
    console.error(`[FixOrderCooldownSource] failed: ${e && e.message ? e.message : e}`);
    process.exitCode = 1;
});
