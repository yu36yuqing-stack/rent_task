'use strict';
const { initRentalDeviceOrderDb } = require('../rental_device_order_db');
module.exports = {
    version: '20261123_025', name: 'rental_device_order', desc: 'isolated console orders and pending statistics dates',
    use_transaction: false, up: initRentalDeviceOrderDb
};
