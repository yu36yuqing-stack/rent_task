module.exports = {
    version: '20260519_014',
    name: 'uid8_admin_for_maintenance',
    desc: 'grant UID=8 admin role for system maintenance menu',
    async up({ db, run, all }) {
        const tables = await all(db, `
            SELECT name
            FROM sqlite_master
            WHERE type = 'table' AND name = 'user'
            LIMIT 1
        `);
        if (tables.length <= 0) return;

        await run(db, `
            UPDATE user
            SET user_type = '管理员',
                modify_date = CURRENT_TIMESTAMP,
                desc = 'grant admin for system maintenance'
            WHERE id = 8
              AND is_deleted = 0
        `);
    }
};
