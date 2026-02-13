const { getGoodsList } = require('../zuhaowang/zuhaowang_api');
const { collectUhaozuData } = require('../uhaozu/uhaozu_api');
const { collectYoupinData } = require('../uuzuhao/uuzuhao_api');
const {
    upsertUserGameAccount,
    clearPlatformStatusForUser,
    softDeleteEmptyAccountsByUser
} = require('../database/user_game_account_db');
const { listValidPlatformsByUser } = require('../database/user_platform_auth_db');

const PLATFORM_ZHW = 'zuhaowang';
const PLATFORM_UHZ = 'uhaozu';
const PLATFORM_YYZ = 'youyouzuhao';

function keyOf(gameName, gameAccount) {
    return `${String(gameName || 'WZRY')}::${String(gameAccount || '')}`;
}

function normalizeGameName(raw) {
    const v = String(raw || '').trim();
    return v || 'WZRY';
}

async function pullPlatformData(platform) {
    if (platform === PLATFORM_ZHW) {
        const list = await getGoodsList();
        return list.map((x) => ({
            game_account: String(x.account || '').trim(),
            game_name: normalizeGameName(x.gameName || 'WZRY'),
            status: String(x.status || '未知')
        })).filter((x) => x.game_account);
    }

    if (platform === PLATFORM_UHZ) {
        const result = await collectUhaozuData(null, '');
        const list = Array.isArray(result?.data) ? result.data : [];
        return list.map((x) => ({
            game_account: String(x.account || '').trim(),
            game_name: 'WZRY',
            status: String(x.status || '未知')
        })).filter((x) => x.game_account);
    }

    if (platform === PLATFORM_YYZ) {
        const result = await collectYoupinData(null, '');
        const list = Array.isArray(result?.data) ? result.data : [];
        return list.map((x) => ({
            game_account: String(x.account || '').trim(),
            game_name: 'WZRY',
            status: String(x.status || '未知')
        })).filter((x) => x.game_account);
    }

    throw new Error(`不支持的平台: ${platform}`);
}

async function syncUserAccountsByAuth(userId) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');

    const validPlatforms = await listValidPlatformsByUser(uid);
    if (validPlatforms.length === 0) {
        throw new Error('当前用户没有可用的平台授权，请先 upsert 平台授权');
    }

    for (const platform of validPlatforms) {
        await clearPlatformStatusForUser(uid, platform);
    }

    const merged = new Map();
    const errors = [];
    const pulled = {};

    for (const platform of validPlatforms) {
        try {
            const rows = await pullPlatformData(platform);
            pulled[platform] = rows.length;
            for (const row of rows) {
                const k = keyOf(row.game_name, row.game_account);
                const cur = merged.get(k) || {
                    game_account: row.game_account,
                    game_name: row.game_name,
                    channel_status: {}
                };
                cur.channel_status[platform] = row.status;
                merged.set(k, cur);
            }
        } catch (e) {
            errors.push(`${platform}: ${e.message}`);
        }
    }

    let upserted = 0;
    for (const item of merged.values()) {
        await upsertUserGameAccount({
            user_id: uid,
            game_account: item.game_account,
            game_name: item.game_name,
            channel_status: item.channel_status,
            desc: 'sync by accounts/sync'
        });
        upserted += 1;
    }

    const cleaned = await softDeleteEmptyAccountsByUser(uid);

    return {
        ok: errors.length === 0,
        user_id: uid,
        platforms: validPlatforms,
        pulled,
        upserted,
        cleaned,
        errors
    };
}

module.exports = {
    syncUserAccountsByAuth
};
