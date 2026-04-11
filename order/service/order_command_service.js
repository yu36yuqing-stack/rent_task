const {
    initOrderDb,
    upsertOrder,
    getOrderByKey,
    updateOrderRecAmount
} = require('../../database/order_db');
const {
    initOrderDetailDb,
    upsertOrderDetail,
    getOrderDetailByOrder,
    listPendingUhaozuOrderDetailsByUser
} = require('../../database/order_detail_db');
const {
    initOrderComplaintDb,
    upsertOrderComplaint,
    getOrderComplaintByOrder
} = require('../../database/order_complaint_db');
const {
    initOrderSyncDb,
    getLastSyncTimestamp,
    setLastSyncTimestamp
} = require('../../database/order_sync_db');

async function initOrderCommandService() {
    await initOrderDb();
    await initOrderDetailDb();
    await initOrderComplaintDb();
    await initOrderSyncDb();
}

module.exports = {
    initOrderCommandService,
    initOrderDb,
    upsertOrder,
    getOrderByKey,
    updateOrderRecAmount,
    initOrderDetailDb,
    upsertOrderDetail,
    getOrderDetailByOrder,
    listPendingUhaozuOrderDetailsByUser,
    initOrderComplaintDb,
    upsertOrderComplaint,
    getOrderComplaintByOrder,
    initOrderSyncDb,
    getLastSyncTimestamp,
    setLastSyncTimestamp
};
