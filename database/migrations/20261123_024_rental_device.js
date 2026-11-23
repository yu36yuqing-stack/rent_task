'use strict';
const { initRentalDeviceDb } = require('../rental_device_db');
module.exports = {
    version: '20261123_024', name: 'rental_device', desc: 'isolated read-only console inventory',
    use_transaction: false, up: initRentalDeviceDb
};
