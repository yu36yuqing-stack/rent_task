'use strict';
const { ensureRentalDeviceOrderGameColumns } = require('../rental_device_order_db');
module.exports = {
    version: '20261123_026', name: 'rental_device_order_games', desc: 'preserve upstream game metadata in console orders',
    use_transaction: false, up: ensureRentalDeviceOrderGameColumns
};
