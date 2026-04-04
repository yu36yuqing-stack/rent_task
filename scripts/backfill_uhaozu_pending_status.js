#!/usr/bin/env node

const { openDatabase } = require('../database/sqlite_client');
const { initOrderDb } = require('../database/order_db');

function parseArgs(argv = []) {
    const out = {
        user_id: 0,
        dry_run: false
    };
    for (let i = 0; i < argv.length; i += 1) {
        const key = String(argv[i] || '').trim();
        const value = String(argv[i + 1] || '').trim();
        if (key === '--user_id' && value) {
            out.user_id = Math.max(0, Number(value || 0) || 0);
            i += 1;
            continue;
        }
        if (key === '--dry-run' || key === '--dry_run') {
            out.dry_run = true;
        }
    }
    return out;
}

function get(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.get(sql, params, (err, row) => {
            if (err) return reject(err);
            resolve(row || null);
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

async function main() {
    const args = parseArgs(process.argv.slice(2));
    await initOrderDb();
    const db = openDatabase();
    try {
        const whereUser = Number(args.user_id || 0) > 0 ? 'AND user_id = ?' : '';
        const params = Number(args.user_id || 0) > 0 ? [Number(args.user_id)] : [];
        const row = await get(db, `
            SELECT COUNT(*) AS total
            FROM "order"
            WHERE is_deleted = 0
              AND channel = 'uhaozu'
              AND order_status = '10'
              ${whereUser}
        `, params);
        const matched = Number((row && row.total) || 0);
        let updated = 0;
        if (!args.dry_run && matched > 0) {
            const result = await run(db, `
                UPDATE "order"
                SET order_status = '待支付'
                WHERE is_deleted = 0
                  AND channel = 'uhaozu'
                  AND order_status = '10'
                  ${whereUser}
            `, params);
            updated = Number((result && result.changes) || 0);
        }
        process.stdout.write(JSON.stringify({
            ok: true,
            dry_run: args.dry_run,
            user_id: Number(args.user_id || 0) || 0,
            matched,
            updated
        }));
    } finally {
        db.close();
    }
}

main().catch((err) => {
    console.error(JSON.stringify({
        ok: false,
        error: String(err && err.message ? err.message : err)
    }));
    process.exit(1);
});
