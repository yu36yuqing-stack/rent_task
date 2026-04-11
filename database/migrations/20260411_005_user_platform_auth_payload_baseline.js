const { _internal } = require('../user_platform_auth_db');

module.exports = {
    version: '20260411_005',
    name: 'user_platform_auth_payload_baseline',
    desc: 'normalize platform auth payload storage once',
    async up({ db }) {
        await _internal.ensureUserPlatformAuthTableBase(db);
        await _internal.ensureUserPlatformAuthIndexes(db);
        await _internal.migrateAuthPayloadToPlaintext(db);
        await _internal.migrateZuhaowangPayloadToYuanbaoOnly(db);
        await _internal.migrateUhaozuPayloadToDefaultHeaders(db);
    }
};
