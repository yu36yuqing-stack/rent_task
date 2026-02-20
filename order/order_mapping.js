const CHANNEL_UUZUHAO = 'uuzuhao';

// 渠道 -> 平台订单表 字段映射定义（后续可按渠道继续扩展）
const UUZUHAO_ORDER_FIELD_MAPPING = {
    channel: { from: '(fixed)', value: CHANNEL_UUZUHAO },
    order_no: { from: 'purchaseOrderNo' },
    game_id: { from: 'gameId' },
    game_name: { from: 'map(gameName)' },
    game_account: { from: '(lookup by productId -> user_game_account.channel_prd_info.uuzuhao.prd_id, fallback accountNo)' },
    role_name: { from: '(lookup by productId -> user_game_account.account_remark, fallback remarkName)' },
    order_status: { from: 'map(orderStatus)' },
    create_date: { from: 'createTime -> yyyy-MM-dd HH:mm:ss' },
    order_amount: { from: 'rentPrice * rentHour' },
    rent_hour: { from: 'rentHour' },
    ren_way: { from: '(fixed) 时租' },
    rec_amount: { from: 'settlementAmount' },
    start_time: { from: 'rentStartTime' },
    end_time: { from: 'rentEndTime' }
};

const UHAOZU_ORDER_FIELD_MAPPING = {
    channel: { from: '(fixed)', value: 'uhaozu' },
    order_no: { from: 'id' },
    game_id: { from: 'gameId' },
    game_name: { from: 'map(gameName)' },
    game_account: { from: '(lookup by goodsId -> user_game_account.channel_prd_info.uhaozu.prd_id)' },
    role_name: { from: '(lookup by goodsId -> user_game_account.account_remark)' },
    order_status: { from: 'map(status) or raw status' },
    order_amount: { from: 'rent / 100' },
    rent_hour: { from: 'rentNum + rentWay rule' },
    ren_way: { from: 'map(rentWay)' },
    rec_amount: { from: 'actualRent / 100' },
    create_date: { from: 'createTime -> yyyy-MM-dd HH:mm:ss' },
    start_time: { from: 'startTime -> yyyy-MM-dd HH:mm:ss' },
    end_time: { from: 'endTime -> yyyy-MM-dd HH:mm:ss' }
};

const ZUHAOWANG_ORDER_FIELD_MAPPING = {
    channel: { from: '(fixed)', value: 'zuhaowang' },
    order_no: { from: 'orderNo' },
    game_id: { from: 'gameId' },
    game_name: { from: 'map(gameId/gameName)' },
    game_account: { from: 'accountNo' },
    role_name: { from: '(lookup by accountNo -> user_game_account.account_remark, fallback roleName/remark)' },
    order_status: { from: 'map(status) or raw status' },
    order_amount: { from: 'unitPrice * rentHourModel' },
    rent_hour: { from: 'parse(rentHourModel)' },
    ren_way: { from: 'map(unit/rentHourModel)' },
    rec_amount: { from: 'income' },
    create_date: { from: 'startTime -> yyyy-MM-dd HH:mm:ss' },
    start_time: { from: 'startTime -> yyyy-MM-dd HH:mm:ss' },
    end_time: { from: 'endTime -> yyyy-MM-dd HH:mm:ss' }
};

function toNumberSafe(value, defaultValue = 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : defaultValue;
}

function roundTo2(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 0;
    return Number(n.toFixed(2));
}

function mapGameNameToCanonical(rawName) {
    const raw = String(rawName || '').trim();
    if (!raw) return 'WZRY';
    if (raw === '王者荣耀' || raw.toUpperCase() === 'WZRY') return 'WZRY';
    return raw;
}

function mapOrderStatusToZh(rawStatus) {
    const raw = String(rawStatus ?? '').trim();
    const code = Number(rawStatus);
    if (code === 3000) return '租赁中';
    if (code === 4000) return '已完成';
    if (code === 4100) return '退款中';
    if (code === 4200) return '已退款';
    if (code === 8000) return '结算中';
    if (code === 9900) return '投诉/撤单';
    return raw;
}

function mapUhaozuStatus(rawStatus) {
    const code = Number(rawStatus);
    if (code === 30) return '预约中';
    if (code === 40) return '租赁中';
    if (code === 50) return '已完成';
    if (code === 52) return '部分完成';
    if (code === 60) return '已撤单';
    const raw = String(rawStatus ?? '').trim();
    return raw;
}

function mapZuhaowangStatus(rawStatus) {
    const code = Number(rawStatus);
    if (code === 0) return '租赁中';
    if (code === 2) return '已完成';
    const raw = String(rawStatus ?? '').trim();
    return raw;
}

function parseRentHourModel(rawModel) {
    const text = String(rawModel || '').trim();
    if (!text) return 0;
    const m = text.match(/(\d+(?:\.\d+)?)/);
    if (!m) return 0;
    const n = Number(m[1]);
    if (!Number.isFinite(n)) return 0;
    return n;
}

function mapZuhaowangRenWay(unit, rentHourModel) {
    const u = String(unit || '').trim();
    const m = String(rentHourModel || '').trim();
    if (u.includes('天') || m.includes('天')) return '包天';
    if (u.includes('夜') || m.includes('夜')) return '包夜';
    return '时租';
}

function mapUhaozuRenWay(rawWay) {
    const code = Number(rawWay);
    if (code === 20) return '包天';
    if (code === 30) return '包夜';
    return '时租';
}

function calcUhaozuRentHour(rentNum, rentWay) {
    const n = toNumberSafe(rentNum, 0);
    const way = Number(rentWay);
    if (way === 20) return n * 24;
    if (way === 30) return n * 10;
    return n;
}

function mapUuzuhaoOrderToUserOrder(raw = {}, options = {}) {
    const gameAccount = String(options.game_account || raw.accountNo || '').trim();
    const roleName = String(options.role_name || raw.remarkName || '').trim();
    const rentPrice = toNumberSafe(raw.rentPrice, 0);
    const rentHour = toNumberSafe(raw.rentHour, 0);
    return {
        channel: CHANNEL_UUZUHAO,
        order_no: String(raw.purchaseOrderNo || '').trim(),
        game_id: String(raw.gameId ?? '').trim(),
        game_name: mapGameNameToCanonical(raw.gameName),
        game_account: gameAccount,
        role_name: roleName,
        order_status: mapOrderStatusToZh(raw.orderStatus),
        create_date: toNumberSafe(raw.createTime, 0),
        order_amount: roundTo2(rentPrice * rentHour),
        rent_hour: rentHour,
        ren_way: '时租',
        rec_amount: toNumberSafe(raw.settlementAmount, 0),
        start_time: toNumberSafe(raw.rentStartTime, 0),
        end_time: toNumberSafe(raw.rentEndTime, 0),
        // 原始单价保留在映射层可追溯，不入平台订单主字段。
        raw_rent_price: rentPrice
    };
}

function mapUhaozuOrderToOrder(raw = {}, options = {}) {
    const gameAccount = String(options.game_account || '').trim();
    const roleName = String(options.role_name || '').trim();
    const rentWay = Number(raw.rentWay);
    const rentNum = toNumberSafe(raw.rentNum, 0);
    return {
        channel: 'uhaozu',
        order_no: String(raw.id || '').trim(),
        game_id: String(raw.gameId ?? '').trim(),
        game_name: mapGameNameToCanonical(raw.gameName),
        game_account: gameAccount,
        role_name: roleName,
        order_status: mapUhaozuStatus(raw.status),
        create_date: toNumberSafe(raw.createTime, 0),
        order_amount: roundTo2(toNumberSafe(raw.rent, 0) / 100),
        rent_hour: calcUhaozuRentHour(rentNum, rentWay),
        ren_way: mapUhaozuRenWay(rentWay),
        rec_amount: roundTo2(toNumberSafe(raw.actualRent, 0) / 100),
        start_time: toNumberSafe(raw.startTime, 0),
        end_time: toNumberSafe(raw.endTime, 0)
    };
}

function mapZuhaowangOrderToOrder(raw = {}, options = {}) {
    const gameAccount = String(options.game_account || raw.accountNo || '').trim();
    const roleName = String(options.role_name || raw.roleName || raw.remark || '').trim();
    const gameId = String(raw.gameId ?? '').trim();
    const gameName = raw.gameName || (gameId === '1104466820' ? 'WZRY' : gameId);
    const rentHour = parseRentHourModel(raw.rentHourModel);
    const unitPrice = toNumberSafe(raw.unitPrice, 0);
    const income = roundTo2(toNumberSafe(raw.income, 0));
    const computedAmount = roundTo2(unitPrice * rentHour);
    return {
        channel: 'zuhaowang',
        order_no: String(raw.orderNo || raw.orderId || '').trim(),
        game_id: gameId,
        game_name: mapGameNameToCanonical(gameName),
        game_account: gameAccount,
        role_name: roleName,
        order_status: mapZuhaowangStatus(raw.status),
        create_date: toNumberSafe(raw.startTime, 0),
        order_amount: computedAmount > 0 ? computedAmount : income,
        rent_hour: rentHour,
        ren_way: mapZuhaowangRenWay(raw.unit, raw.rentHourModel),
        rec_amount: income,
        start_time: toNumberSafe(raw.startTime, 0),
        end_time: toNumberSafe(raw.endTime, 0)
    };
}

module.exports = {
    CHANNEL_UUZUHAO,
    UUZUHAO_ORDER_FIELD_MAPPING,
    UHAOZU_ORDER_FIELD_MAPPING,
    ZUHAOWANG_ORDER_FIELD_MAPPING,
    mapUuzuhaoOrderToUserOrder,
    mapUhaozuOrderToOrder,
    mapZuhaowangOrderToOrder
};
