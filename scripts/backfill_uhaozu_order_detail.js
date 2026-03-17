#!/usr/bin/env node

const { openDatabase } = require('../database/sqlite_client');
const { getOrderDetailViewByUser } = require('../order/order');

function parseArgs(argv = []) {
    const out = {
        sleep_ms: 100,
        limit: 0,
        user_id: 0
    };
    for (let i = 0; i < argv.length; i += 1) {
        const key = String(argv[i] || '').trim();
        const value = String(argv[i + 1] || '').trim();
        if (key === '--sleep_ms' && value) {
            out.sleep_ms = Math.max(0, Number(value || 0) || 0);
            i += 1;
            continue;
        }
        if (key === '--limit' && value) {
            out.limit = Math.max(0, Number(value || 0) || 0);
            i += 1;
            continue;
        }
        if (key === '--user_id' && value) {
            out.user_id = Math.max(0, Number(value || 0) || 0);
            i += 1;
        }
    }
    return out;
}

function sleep(ms) {
    const waitMs = Math.max(0, Number(ms || 0) || 0);
    return new Promise((resolve) => setTimeout(resolve, waitMs));
}

function all(db, sql, params = []) {
    return new Promise((resolve, reject) => {
        db.all(sql, params, (err, rows) => {
            if (err) return reject(err);
            resolve(rows || []);
        });
    });
}

async function listMissingOrders({ user_id = 0, limit = 0 } = {}) {
    const db = openDatabase();
    try {
        const params = [];
        let whereUser = '';
        if (Number(user_id || 0) > 0) {
            whereUser = 'AND o.user_id = ?';
            params.push(Number(user_id));
        }
        let limitSql = '';
        if (Number(limit || 0) > 0) {
            limitSql = 'LIMIT ?';
            params.push(Number(limit));
        }
        return await all(db, `
            SELECT
                o.user_id,
                o.order_no,
                o.order_status,
                o.rec_amount,
                o.modify_date
            FROM "order" o
            LEFT JOIN order_detail d
              ON d.user_id = o.user_id
             AND d.channel = o.channel
             AND d.order_no = o.order_no
             AND d.is_deleted = 0
            WHERE o.is_deleted = 0
              AND o.channel = 'uhaozu'
              AND o.order_status IN ('已完成', '部分完成')
              AND d.id IS NULL
              ${whereUser}
            ORDER BY o.user_id ASC, o.modify_date ASC, o.id ASC
            ${limitSql}
        `, params);
    } finally {
        db.close();
    }
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const rows = await listMissingOrders(args);
    console.log(`[backfill_uhaozu_order_detail] pending=${rows.length} sleep_ms=${args.sleep_ms} user_id=${args.user_id || 'all'} limit=${args.limit || 'all'}`);
    let ok = 0;
    let failed = 0;
    for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i] || {};
        const uid = Number(row.user_id || 0);
        const orderNo = String(row.order_no || '').trim();
        if (!uid || !orderNo) continue;
        try {
            const result = await getOrderDetailViewByUser(uid, { channel: 'uhaozu', order_no: orderNo });
            if (result && result.detail) {
                ok += 1;
                console.log(`[OK] ${i + 1}/${rows.length} user_id=${uid} order_no=${orderNo} status=${result.detail.detail_status || ''} net_rent_amount=${result.detail.net_rent_amount}`);
            } else {
                failed += 1;
                console.log(`[MISS] ${i + 1}/${rows.length} user_id=${uid} order_no=${orderNo} detail_still_empty`);
            }
        } catch (e) {
            failed += 1;
            console.log(`[FAIL] ${i + 1}/${rows.length} user_id=${uid} order_no=${orderNo} err=${String(e && e.message ? e.message : e)}`);
        }
        if (i < rows.length - 1 && args.sleep_ms > 0) {
            await sleep(args.sleep_ms);
        }
    }
    console.log(`[backfill_uhaozu_order_detail] done pending=${rows.length} ok=${ok} failed=${failed}`);
}

main().catch((err) => {
    console.error(`[backfill_uhaozu_order_detail] fatal=${String(err && err.message ? err.message : err)}`);
    process.exit(1);
});
