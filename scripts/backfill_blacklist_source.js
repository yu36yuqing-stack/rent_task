#!/usr/bin/env node
const { openDatabase } = require('../database/sqlite_client');
const { upsertBlacklistSource, initUserBlacklistSourceDb } = require('../database/user_blacklist_source_db');
const { reasonFromLegacy, SOURCE_RULES } = require('../blacklist/blacklist_reconciler');

function parseArgs(argv = []) {
    const out = {
        apply: false,
        user_id: 0,
        limit: 0,
        verbose: false,
        retry: 6
    };
    for (const raw of argv) {
        const v = String(raw || '').trim();
        if (!v) continue;
        if (v === '--apply') out.apply = true;
        else if (v === '--dry-run') out.apply = false;
        else if (v === '--verbose') out.verbose = true;
        else if (v.startsWith('--user-id=')) out.user_id = Number(v.slice('--user-id='.length) || 0);
        else if (v.startsWith('--limit=')) out.limit = Number(v.slice('--limit='.length) || 0);
        else if (v.startsWith('--retry=')) out.retry = Math.max(0, Number(v.slice('--retry='.length) || 0));
    }
    return out;
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row || null);
        });
    });
}

function safeJsonParse(text) {
    try {
        const obj = JSON.parse(String(text || '').trim() || '{}');
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
        return obj;
    } catch {
        return {};
    }
}

function normalizeLegacySource(raw = '') {
    const s = String(raw || '').trim().toLowerCase();
    if (!s) return '';
    if (s === 'order_cooldown' || s === 'order_cooldown_guard') return 'order_cooldown';
    if (s === 'order_3_off' || s === 'order_3_off_guard') return 'order_n_off';
    if (s === 'prod_guard') return 'guard_online';
    if (s === 'h5_maintenance' || s === 'h5_maintenance_guard') return 'manual_maintenance';
    if (s === 'h5' || s === 'manual' || s === 'manual_cli') return 'manual_block';
    return '';
}

function inferSourceFromDesc(desc = '', reason = '') {
    const info = safeJsonParse(desc);
    const type = String(info.type || '').trim();
    if (type === 'order_cooldown') return 'order_cooldown';
    if (type === 'release_guard_block') {
        if (String(reason || '').trim() === '禁玩中') return 'guard_forbidden';
        return 'guard_online';
    }
    const text = String(desc || '');
    if (text.includes('order_3_off')) return 'order_n_off';
    if (text.includes('maintenance')) return 'manual_maintenance';
    if (text.includes('manual')) return 'manual_block';
    return '';
}

function inferByReason(reason = '') {
    const x = reasonFromLegacy(String(reason || '').trim());
    return {
        source: x.source,
        reason: x.reason,
        priority: Number(x.priority || 0),
        hit: 'reason_fallback'
    };
}

function sourceToPriority(source = '', reason = '') {
    const key = String(source || '').trim().toLowerCase();
    const rule = SOURCE_RULES[key] || null;
    if (rule && Number(rule.priority || 0) > 0) return Number(rule.priority || 0);
    return Number(inferByReason(reason).priority || 0);
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function isBusyError(err) {
    const msg = String(err && err.message ? err.message : err || '');
    return msg.includes('SQLITE_BUSY');
}

async function upsertWithRetry(userId, gameAccount, source, payload, options = {}) {
    const retry = Math.max(0, Number(options.retry || 0));
    for (let i = 0; i <= retry; i += 1) {
        try {
            return await upsertBlacklistSource(userId, gameAccount, source, payload, { desc: options.desc || '' });
        } catch (e) {
            if (!isBusyError(e) || i >= retry) throw e;
            const backoff = 60 * (i + 1);
            await sleep(backoff);
        }
    }
    return null;
}

async function findLatestHistorySource(db, userId, gameAccount) {
    const row = await get(db, `
        SELECT source, desc, event_type, modify_date
        FROM user_blacklist_history
        WHERE user_id = ?
          AND game_account = ?
          AND is_deleted = 0
          AND event_type IN ('upsert_insert', 'upsert_update')
        ORDER BY id DESC
        LIMIT 1
    `, [Number(userId || 0), String(gameAccount || '').trim()]);
    if (!row) return null;
    return {
        source: String(row.source || '').trim(),
        desc: String(row.desc || '').trim(),
        event_type: String(row.event_type || '').trim(),
        modify_date: String(row.modify_date || '').trim()
    };
}

function resolveSourceBySignals(input = {}) {
    const reason = String(input.reason || '').trim();
    const history = input.history || null;
    const rowDesc = String(input.row_desc || '').trim();
    const byReason = inferByReason(reason);

    // 当前表内 reason 是在线真实结果，优先级高于历史 source，避免把已覆盖后的状态写回旧来源。
    if (String(byReason.source || '') !== 'legacy_carryover') {
        return byReason;
    }

    const fromHistorySource = normalizeLegacySource(history && history.source);
    if (fromHistorySource) {
        return {
            source: fromHistorySource,
            reason: reason || String((SOURCE_RULES[fromHistorySource] || {}).reason || '').trim(),
            priority: sourceToPriority(fromHistorySource, reason),
            hit: 'history_source'
        };
    }

    const fromHistoryDesc = inferSourceFromDesc(history && history.desc, reason);
    if (fromHistoryDesc) {
        return {
            source: fromHistoryDesc,
            reason: reason || String((SOURCE_RULES[fromHistoryDesc] || {}).reason || '').trim(),
            priority: sourceToPriority(fromHistoryDesc, reason),
            hit: 'history_desc'
        };
    }

    const fromRowDesc = inferSourceFromDesc(rowDesc, reason);
    if (fromRowDesc) {
        return {
            source: fromRowDesc,
            reason: reason || String((SOURCE_RULES[fromRowDesc] || {}).reason || '').trim(),
            priority: sourceToPriority(fromRowDesc, reason),
            hit: 'row_desc'
        };
    }

    return byReason;
}

async function loadActiveBlacklistRows(db, options = {}) {
    const where = ['is_deleted = 0'];
    const params = [];
    if (Number(options.user_id || 0) > 0) {
        where.push('user_id = ?');
        params.push(Number(options.user_id));
    }
    const limit = Number(options.limit || 0) > 0 ? ` LIMIT ${Number(options.limit)}` : '';
    return all(db, `
        SELECT user_id, game_account, reason, create_date, modify_date, desc
        FROM user_blacklist
        WHERE ${where.join(' AND ')}
        ORDER BY user_id ASC, game_account ASC
        ${limit}
    `, params);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const db = openDatabase();
    try {
        await initUserBlacklistSourceDb();
        const rows = await loadActiveBlacklistRows(db, args);
        const summary = {
            scanned: rows.length,
            upserted: 0,
            dry_run: args.apply ? 0 : 1,
            by_hit: {},
            by_source: {}
        };
        const samples = [];

        for (const row of rows) {
            const uid = Number(row.user_id || 0);
            const acc = String(row.game_account || '').trim();
            if (!uid || !acc) continue;
            const reason = String(row.reason || '').trim();
            const history = await findLatestHistorySource(db, uid, acc);
            const resolved = resolveSourceBySignals({
                reason,
                history,
                row_desc: row.desc
            });
            const source = String(resolved.source || '').trim().toLowerCase() || 'legacy_carryover';
            const priority = Number(resolved.priority || 0);
            const finalReason = String(resolved.reason || reason || '').trim();
            const hit = String(resolved.hit || 'unknown').trim();

            summary.by_hit[hit] = Number(summary.by_hit[hit] || 0) + 1;
            summary.by_source[source] = Number(summary.by_source[source] || 0) + 1;

            const payload = {
                active: 1,
                reason: finalReason,
                priority,
                detail: {
                    from: 'bootstrap_legacy_blacklist',
                    bootstrap: true,
                    hit,
                    history_source: history ? String(history.source || '') : '',
                    history_event_type: history ? String(history.event_type || '') : '',
                    history_modify_date: history ? String(history.modify_date || '') : ''
                },
                expire_at: ''
            };
            const desc = `bootstrap from user_blacklist reason=${reason || 'EMPTY'} hit=${hit}`;

            if (args.apply) {
                await upsertWithRetry(uid, acc, source, payload, {
                    desc,
                    retry: args.retry
                });
                summary.upserted += 1;
            } else if (samples.length < 20) {
                samples.push({
                    user_id: uid,
                    game_account: acc,
                    reason,
                    source,
                    priority,
                    hit
                });
            }
        }

        console.log(`[BlacklistSourceBootstrap] mode=${args.apply ? 'apply' : 'dry-run'} scanned=${summary.scanned} upserted=${summary.upserted}`);
        console.log(`[BlacklistSourceBootstrap] by_hit=${JSON.stringify(summary.by_hit)}`);
        console.log(`[BlacklistSourceBootstrap] by_source=${JSON.stringify(summary.by_source)}`);
        if (!args.apply) {
            console.log(`[BlacklistSourceBootstrap] dry-run samples=${JSON.stringify(samples)}`);
            console.log('[BlacklistSourceBootstrap] dry-run only; add --apply to persist');
        }
    } finally {
        db.close();
    }
}

main().catch((e) => {
    console.error(`[BlacklistSourceBootstrap] failed: ${String(e && e.message ? e.message : e)}`);
    process.exit(1);
});
