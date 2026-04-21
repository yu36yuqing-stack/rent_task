const { _internal } = require('../user_platform_auth_db');

module.exports = {
    version: '20260421_012',
    name: 'user_platform_auth_channel_enabled',
    desc: 'add channel_enabled to user_platform_auth',
    async up({ db }) {
        await _internal.ensureUserPlatformAuthTableBase(db);
        await _internal.ensureUserPlatformAuthIndexes(db);
    }
};
