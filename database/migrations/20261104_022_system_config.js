'use strict';

module.exports = {
    version: '20261104_022',
    name: 'system_config',
    desc: 'add global JSON configuration with versioned updates and seed Uhaozu auto-reshelf reasons',
    async up({ db, run }) {
        await run(db, `
            CREATE TABLE IF NOT EXISTS system_config (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                config_key TEXT NOT NULL CHECK(length(trim(config_key)) > 0),
                config_value TEXT NOT NULL CHECK(json_valid(config_value)),
                version INTEGER NOT NULL DEFAULT 1 CHECK(version > 0),
                create_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
                is_deleted INTEGER NOT NULL DEFAULT 0,
                desc TEXT NOT NULL DEFAULT ''
            )
        `);
        await run(db, `
            CREATE UNIQUE INDEX IF NOT EXISTS uq_system_config_alive
            ON system_config(config_key) WHERE is_deleted = 0
        `);
        const key = 'uhaozu.auto_reshelf_reasons';
        const value = JSON.stringify({ reasons: [
            '检测游戏在线，请确认游戏离线后手动上架',
            '账号人脸识别',
            '商品开启禁玩,已自动下架'
        ] });
        // A removed key is an explicit configuration choice, including on migration retries.
        await run(db, `
            INSERT INTO system_config
                (config_key, config_value, version, create_date, modify_date, is_deleted, desc)
            SELECT ?, ?, 1, datetime('now', 'localtime'), datetime('now', 'localtime'), 0, ?
            WHERE NOT EXISTS (SELECT 1 FROM system_config WHERE config_key = ?)
        `, [key, value, 'U号租允许自动恢复的原因；空 reasons 列表关闭该类恢复', key]);
    }
};
