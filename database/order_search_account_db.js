'use strict';

const { openMainDatabase } = require('./sqlite_client');

async function listOrderSearchAccountNames(userId) {
    if (!Number.isSafeInteger(userId) || userId <= 0) throw new Error('user_id 不合法');
    const db = openMainDatabase();
    try {
        return await new Promise((resolve, reject) => db.all(`
            SELECT game_id,game_account,account_remark,
              CASE WHEN json_valid(channel_prd_info)
                THEN json_extract(channel_prd_info,'$.uuzuhao.remark') ELSE NULL END AS uuzuhao_remark
            FROM user_game_account WHERE user_id=? AND is_deleted=0
            ORDER BY id DESC
        `, [userId], (error, rows) => error ? reject(error) : resolve(rows)));
    } finally {
        await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
    }
}

module.exports = { listOrderSearchAccountNames };
