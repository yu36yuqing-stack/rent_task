async function reconcileOrderOffByUser(user, options = {}) {
    const { reconcileOrderOffByUser: reconcile } = require('../order');
    return reconcile(user, options);
}

async function reconcileOrderNOffByUser(user, options = {}) {
    const { reconcileOrder3OffBlacklistByUser: reconcile } = require('../order');
    return reconcile(user, options);
}

async function reconcileOrderCooldownEntryByUser(userId, options = {}) {
    const { reconcileOrderCooldownEntryByUser: reconcile } = require('../order_cooldown');
    return reconcile(userId, options);
}

async function releaseOrderCooldownBlacklistByUser(userId, options = {}) {
    const { releaseOrderCooldownBlacklistByUser: release } = require('../order_cooldown');
    return release(userId, options);
}

module.exports = {
    reconcileOrderOffByUser,
    reconcileOrderNOffByUser,
    reconcileOrder3OffBlacklistByUser: reconcileOrderNOffByUser,
    reconcileOrderCooldownEntryByUser,
    releaseOrderCooldownBlacklistByUser
};
