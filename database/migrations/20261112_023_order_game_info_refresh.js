'use strict';

const { initOrderGameInfoRefreshDb } = require('../order_game_info_refresh_db');

module.exports = {
    version: '20261112_023',
    name: 'order_game_info_refresh',
    desc: 'persist order-scoped game info refresh attempts and seed disabled uid8 rollout policy',
    use_transaction: false,
    async up({ db, run }) {
        // This initializer owns the order-database transaction; the runner connection is the main database.
        await initOrderGameInfoRefreshDb();
        const key = 'uuzuhao.order_game_info_refresh';
        const value = JSON.stringify({ enabled: false, user_ids: [8], activated_at: '' });
        await run(db, `INSERT INTO system_config
            (config_key,config_value,version,create_date,modify_date,is_deleted,desc)
            SELECT ?,?,1,datetime('now','localtime'),datetime('now','localtime'),0,?
            WHERE NOT EXISTS (SELECT 1 FROM system_config WHERE config_key=?)`,
        [key, value, '订单结束后刷新悠悠账号信息；默认关闭，启用时明确生效时间', key]);
    }
};
