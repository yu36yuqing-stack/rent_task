const {
    initAccountCostRecordDb,
    createAccountCostRecord,
    getActivePurchaseCostRecord,
    upsertPurchaseCostRecord,
    sumAccountCostAmountByUserAndAccount,
    softDeleteAccountCostRecordById
} = require('../database/account_cost_record_db');
const {
    initUserGameAccountDb,
    getLatestUserGameAccountByUserAndAccount,
    updateUserGameAccountPurchaseByUserAndAccount,
    clearUserGameAccountPurchaseByUserAndAccount,
    updateUserGameAccountTotalCostByUserAndAccount
} = require('../database/user_game_account_db');
const { canonicalGameId, canonicalGameNameById } = require('../common/game_profile');

function normalizeCostType(v, fallback = 'other') {
    const text = String(v || '').trim().toLowerCase();
    if (text === 'purchase') return 'purchase';
    if (text === 'maintenance') return 'maintenance';
    if (text === 'other') return 'other';
    return fallback;
}

async function ensureAccountExists(userId, gameAccount, gameId = '', gameName = '') {
    await initUserGameAccountDb();
    const row = await getLatestUserGameAccountByUserAndAccount(userId, gameAccount, gameId, gameName || 'WZRY');
    if (!row) throw new Error(`找不到账号: ${String(gameAccount || '').trim()}`);
    return row;
}

async function syncAccountTotalCost(userId, gameAccount, gameId = '', gameName = '') {
    const total = await sumAccountCostAmountByUserAndAccount(userId, gameId, gameAccount);
    const account = await updateUserGameAccountTotalCostByUserAndAccount(
        userId,
        gameAccount,
        total,
        'sync total cost by account_cost_record',
        gameId,
        gameName
    );
    return {
        account,
        total_cost_amount: Number(total.toFixed(2))
    };
}

async function savePurchaseCostByUserAndAccount(userId, payload = {}) {
    await initAccountCostRecordDb();
    const gameAccount = String(payload.game_account || '').trim();
    const gameId = canonicalGameId(payload.game_id, payload.game_name || 'WZRY');
    const gameName = canonicalGameNameById(gameId, payload.game_name || 'WZRY');
    const purchasePrice = Number(payload.purchase_price);
    const purchaseDate = String(payload.purchase_date || '').trim();
    const purchaseDesc = String(payload.purchase_desc || '').trim();
    if (!Number.isFinite(purchasePrice) || purchasePrice < 0) throw new Error('purchase_price 不合法');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(purchaseDate)) throw new Error('purchase_date 格式不合法');

    await ensureAccountExists(userId, gameAccount, gameId, gameName);
    const account = await updateUserGameAccountPurchaseByUserAndAccount(
        userId,
        gameAccount,
        purchasePrice,
        purchaseDate,
        'manual purchase config by h5',
        gameId,
        gameName
    );
    const record = await upsertPurchaseCostRecord({
        user_id: Number(userId || 0),
        game_id: gameId,
        game_name: gameName,
        game_account: gameAccount,
        cost_amount: purchasePrice,
        cost_date: purchaseDate,
        cost_desc: purchaseDesc,
        desc: 'purchase config by h5'
    });
    const summary = await syncAccountTotalCost(userId, gameAccount, gameId, gameName);
    return {
        account: {
            ...account,
            total_cost_amount: summary.total_cost_amount
        },
        record,
        total_cost_amount: summary.total_cost_amount
    };
}

async function createAccountCostByUserAndAccount(userId, payload = {}) {
    await initAccountCostRecordDb();
    const gameAccount = String(payload.game_account || '').trim();
    const gameId = canonicalGameId(payload.game_id, payload.game_name || 'WZRY');
    const gameName = canonicalGameNameById(gameId, payload.game_name || 'WZRY');
    const costAmount = Number(payload.cost_amount);
    const costDate = String(payload.cost_date || '').trim();
    const costType = normalizeCostType(payload.cost_type, 'maintenance');
    const costDesc = String(payload.cost_desc || '').trim();
    if (!Number.isFinite(costAmount) || costAmount < 0) throw new Error('cost_amount 不合法');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(costDate)) throw new Error('cost_date 格式不合法');

    const account = await ensureAccountExists(userId, gameAccount, gameId, gameName);
    const record = await createAccountCostRecord({
        user_id: Number(userId || 0),
        game_id: gameId,
        game_name: gameName,
        game_account: gameAccount,
        cost_amount: costAmount,
        cost_date: costDate,
        cost_type: costType,
        cost_desc: costDesc,
        desc: `account cost create by h5:${costType}`
    });
    const summary = await syncAccountTotalCost(userId, gameAccount, gameId, gameName);
    return {
        account: {
            ...account,
            total_cost_amount: summary.total_cost_amount
        },
        record,
        total_cost_amount: summary.total_cost_amount
    };
}

async function deleteAccountCostByUserAndAccount(userId, payload = {}) {
    await initAccountCostRecordDb();
    const recordId = Number(payload.record_id || 0);
    const gameAccount = String(payload.game_account || '').trim();
    const gameId = canonicalGameId(payload.game_id, payload.game_name || 'WZRY');
    const gameName = canonicalGameNameById(gameId, payload.game_name || 'WZRY');
    if (!recordId) throw new Error('record_id 不合法');
    if (!gameAccount) throw new Error('game_account 不能为空');

    await ensureAccountExists(userId, gameAccount, gameId, gameName);
    const record = await softDeleteAccountCostRecordById(userId, recordId, {
        game_id: gameId,
        game_account: gameAccount,
        desc: 'account cost delete by h5'
    });
    if (String(record.cost_type || '').trim() === 'purchase') {
        const activePurchase = await getActivePurchaseCostRecord(userId, gameId, gameAccount);
        if (activePurchase) {
            await updateUserGameAccountPurchaseByUserAndAccount(
                userId,
                gameAccount,
                Number(activePurchase.cost_amount || 0),
                String(activePurchase.cost_date || '').slice(0, 10),
                'sync purchase by account_cost_record delete',
                gameId,
                gameName
            );
        } else {
            await clearUserGameAccountPurchaseByUserAndAccount(
                userId,
                gameAccount,
                'clear purchase by account_cost_record delete',
                gameId,
                gameName
            );
        }
    }
    const summary = await syncAccountTotalCost(userId, gameAccount, gameId, gameName);
    return {
        record,
        total_cost_amount: summary.total_cost_amount,
        account: {
            ...summary.account,
            total_cost_amount: summary.total_cost_amount
        }
    };
}

module.exports = {
    initAccountCostRecordDb,
    normalizeCostType,
    savePurchaseCostByUserAndAccount,
    createAccountCostByUserAndAccount,
    deleteAccountCostByUserAndAccount
};
