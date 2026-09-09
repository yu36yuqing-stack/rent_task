const CHANNEL_UUZUHAO = 'uuzuhao';
const CHANNEL_5E = '5e';
const { normalizeGameProfile } = require('../common/game_profile');

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
    order_amount: { from: 'receivableAmount (fallback rentPrice * rentHour)' },
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

const FIVE_E_ORDER_FIELD_MAPPING = {
    channel: { from: '(fixed)', value: CHANNEL_5E },
    order_no: { from: 'orderChildNo (fallback orderNo)' },
    game_id: { from: '(fixed)', value: '4' },
    game_name: { from: '(fixed)', value: 'CSGO' },
    game_account: { from: '(lookup accountNo -> user_game_account.channel_prd_info.5e.account_no)' },
    role_name: { from: '(lookup accountNo -> user_game_account.account_remark)' },
    order_status: { from: 'isRefund + rentExpireTime' },
    order_amount: { from: 'realAmount' },
    rent_hour: { from: 'totalTimeLength / 3600' },
    ren_way: { from: 'buyTimeType', value: '时租' },
    rec_amount: { from: 'isRefund ? 0 : channelRevenue' },
    create_date: { from: 'orderCreateTime' },
    start_time: { from: 'paySuccessTime' },
    end_time: { from: 'rentExpireTime' }
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
    return normalizeGameProfile('', rawName, { preserveUnknown: true }).game_name;
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
    if (code === 10) return '待支付';
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
    const normalizedGame = normalizeGameProfile(
        options.game_id === undefined ? raw.gameId : options.game_id,
        options.game_name === undefined ? raw.gameName : options.game_name,
        { preserveUnknown: true }
    );
    const rentPrice = toNumberSafe(raw.rentPrice, 0);
    const rentHour = toNumberSafe(raw.rentHour, 0);
    const receivableAmount = toNumberSafe(raw.receivableAmount, 0);
    const computedAmount = roundTo2(rentPrice * rentHour);
    const orderAmount = receivableAmount > 0 ? roundTo2(receivableAmount) : computedAmount;
    return {
        channel: CHANNEL_UUZUHAO,
        order_no: String(raw.purchaseOrderNo || '').trim(),
        game_id: normalizedGame.game_id,
        game_name: normalizedGame.game_name,
        game_account: gameAccount,
        role_name: roleName,
        order_status: mapOrderStatusToZh(raw.orderStatus),
        create_date: toNumberSafe(raw.createTime, 0),
        order_amount: orderAmount,
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
    const normalizedGame = normalizeGameProfile(raw.gameId, raw.gameName, { preserveUnknown: true });
    const rentWay = Number(raw.rentWay);
    const rentNum = toNumberSafe(raw.rentNum, 0);
    return {
        channel: 'uhaozu',
        order_no: String(raw.id || '').trim(),
        game_id: normalizedGame.game_id,
        game_name: normalizedGame.game_name,
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
    const gameName = raw.gameName || gameId;
    const normalizedGame = normalizeGameProfile(gameId, gameName, { preserveUnknown: true });
    const rentHour = parseRentHourModel(raw.rentHourModel);
    const unitPrice = toNumberSafe(raw.unitPrice, 0);
    const income = roundTo2(toNumberSafe(raw.income, 0));
    const computedAmount = roundTo2(unitPrice * rentHour);
    return {
        channel: 'zuhaowang',
        order_no: String(raw.orderNo || raw.orderId || '').trim(),
        game_id: normalizedGame.game_id,
        game_name: normalizedGame.game_name,
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

function mapFiveEOrderToOrder(raw = {}, options = {}) {
    const nowSec = toNumberSafe(options.now_sec, Math.floor(Date.now() / 1000));
    const expireSec = toNumberSafe(raw.rent_expire_time ?? raw.rentExpireTime, 0);
    const refunded = raw.is_refund === true || Number(raw.is_refund_raw ?? raw.isRefund) === 1;
    const rawStatus = Number(raw.order_status ?? raw.orderStatus);
    let orderStatus = '';
    if (refunded) orderStatus = '已退款';
    else if (expireSec > nowSec) orderStatus = '租赁中';
    else if (expireSec > 0 || rawStatus === 2) orderStatus = '已完成';
    else orderStatus = Number.isFinite(rawStatus) ? String(rawStatus) : '';

    return {
        channel: CHANNEL_5E,
        order_no: String(raw.order_id || raw.order_child_no || raw.orderChildNo || raw.order_no || raw.orderNo || '').trim(),
        parent_order_no: String(raw.order_no || raw.orderNo || '').trim(),
        game_id: '4',
        game_name: 'CSGO',
        game_account: String(options.game_account || '').trim(),
        role_name: String(options.role_name || '').trim(),
        order_status: orderStatus,
        create_date: toNumberSafe(raw.order_create_time ?? raw.orderCreateTime, 0),
        order_amount: roundTo2(toNumberSafe(raw.paid_amount ?? raw.realAmount, 0)),
        rent_hour: toNumberSafe(raw.duration_hours, toNumberSafe(raw.totalTimeLength, 0) / 3600),
        ren_way: '时租',
        rec_amount: refunded ? 0 : roundTo2(toNumberSafe(raw.income_amount ?? raw.channelRevenue, 0)),
        start_time: toNumberSafe(raw.pay_success_time ?? raw.paySuccessTime, 0),
        end_time: expireSec,
        raw_order_status: rawStatus,
        raw_cash_status: Number(raw.cash_status ?? raw.cashStatus)
    };
}

module.exports = {
    CHANNEL_UUZUHAO,
    CHANNEL_5E,
    UUZUHAO_ORDER_FIELD_MAPPING,
    UHAOZU_ORDER_FIELD_MAPPING,
    ZUHAOWANG_ORDER_FIELD_MAPPING,
    FIVE_E_ORDER_FIELD_MAPPING,
    mapUuzuhaoOrderToUserOrder,
    mapUhaozuOrderToOrder,
    mapZuhaowangOrderToOrder,
    mapFiveEOrderToOrder
};
