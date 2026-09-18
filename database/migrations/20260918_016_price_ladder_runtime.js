const { initAccountPriceLadderRuntimeDb } = require('../account_price_ladder_runtime_db');
const { initPriceLadderJobStateDb } = require('../price_ladder_job_state_db');

module.exports = {
    version: '20260918_016',
    name: 'price_ladder_runtime',
    desc: 'create account price ladder runtime and daily reset job state tables in price db',
    use_transaction: false,
    async up() {
        await initAccountPriceLadderRuntimeDb();
        await initPriceLadderJobStateDb();
    }
};
