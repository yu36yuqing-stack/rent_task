const { getOrderComplaintDetailByUser } = require('../../order/order');

function createOrderBff(deps = {}) {
    const requireAuth = deps.requireAuth;
    const json = deps.json;

    if (typeof requireAuth !== 'function' || typeof json !== 'function') {
        throw new Error('createOrderBff 缺少必要依赖: requireAuth/json');
    }

    async function handleGetOrderComplaint(req, res, urlObj) {
        const user = await requireAuth(req);
        const channel = String(urlObj.searchParams.get('channel') || '').trim().toLowerCase();
        const orderNo = String(urlObj.searchParams.get('order_no') || '').trim();
        if (!channel) return json(res, 400, { ok: false, message: 'channel 不能为空' });
        if (!orderNo) return json(res, 400, { ok: false, message: 'order_no 不能为空' });
        const data = await getOrderComplaintDetailByUser(user.id, { channel, order_no: orderNo });
        return json(res, 200, { ok: true, data });
    }

    async function init() {
        return true;
    }

    return {
        init,
        handleGetOrderComplaint
    };
}

module.exports = {
    createOrderBff
};
