'use strict';

const { openMainDatabase } = require('./sqlite_client');

// Read a guarded JSON value even if a legacy row contains invalid JSON.
const SAFE_INFO = "CASE WHEN json_valid(channel_prd_info) THEN channel_prd_info ELSE '{}' END";

async function updateZuhaowangRentMode(userId, identity, goodsId, rentMode, expectedRentMode) {
    const uid = Number(userId);
    const gameId = String(identity?.game_id || '').trim();
    const account = String(identity?.game_account || '').trim();
    const product = String(goodsId || '').trim();
    const mode = String(rentMode || '').trim();
    const expected = String(expectedRentMode || '').trim();
    if (!Number.isInteger(uid) || uid <= 0 || !gameId || !account || !product
        || !['day_only', 'hour_only', 'hour_and_day'].includes(mode)) return false;
    const db = openMainDatabase();
    try {
        const result = await new Promise((resolve, reject) => db.run(`
            UPDATE user_game_account
            SET channel_prd_info = json_set(channel_prd_info, '$.zuhaowang.rent_mode', ?),
                modify_date = datetime('now', 'localtime')
            WHERE user_id = ? AND game_id = ? AND game_account = ? AND is_deleted = 0
                AND COALESCE(asset_status, 'active') <> 'sold'
                AND json_type(${SAFE_INFO}, '$.zuhaowang') = 'object'
                AND COALESCE(NULLIF(trim(CAST(json_extract(${SAFE_INFO}, '$.zuhaowang.prd_id') AS TEXT)), ''),
                    trim(CAST(json_extract(${SAFE_INFO}, '$.zuhaowang.data_id') AS TEXT))) = ?
                AND COALESCE(trim(CAST(json_extract(${SAFE_INFO}, '$.zuhaowang.rent_mode') AS TEXT)), '') = ?
        `, [mode, uid, gameId, account, product, expected], function complete(error) {
            if (error) return reject(error);
            resolve(this);
        }));
        return result.changes === 1;
    } finally {
        await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
    }
}

module.exports = { updateZuhaowangRentMode };
