'use strict';

const { initUserGameAccountDb } = require('../user_game_account_db');

module.exports = {
    version: '20261022_021',
    name: 'uuzuhao_online_auth_state',
    desc: 'persist per-user/game/account QQ authorization failures without changing channel shelf status',
    use_transaction: false,
    async up() {
        await initUserGameAccountDb();
    }
};
