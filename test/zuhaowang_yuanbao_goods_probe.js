#!/usr/bin/env node
const { getGoodsListByEncryptedPayload } = require('../zuhaowang/zuhaowang_api');

function mask(value, keep = 6) {
    const v = String(value || '');
    if (!v) return '';
    if (v.length <= keep * 2) return `${v.slice(0, 2)}***${v.slice(-2)}`;
    return `${v.slice(0, keep)}***${v.slice(-keep)}`;
}

async function main() {
    const auth = {
        token_get: process.env.ZHW_TOKEN_GET || 'placeholder-token-get',
        token_post: process.env.ZHW_TOKEN_POST || 'placeholder-token-post',
        token_yuanbao: process.env.ZHW_TOKEN_YUANBAO || process.env.ZHW_TOKEN_GET || '',
        device_id: process.env.ZHW_DEVICE_ID || '9f37bcaeba8e4a0392aead9388d0a255',
        package_name: process.env.ZHW_PACKAGE_NAME || 'com.duodian.merchant',
        app_version: process.env.ZHW_APP_VERSION || '2.1.6',
        main_version: process.env.ZHW_MAIN_VERSION || '2.1.6',
        x_versioncode: process.env.ZHW_X_VERSIONCODE || '2.1.6',
        x_versionnumber: process.env.ZHW_X_VERSIONNUMBER || '216',
        x_channel: process.env.ZHW_X_CHANNEL || 'ybxiaomi',
        user_agent: process.env.ZHW_USER_AGENT
            || 'Mozilla/5.0 (Linux; Android 14; 2206123SC Build/UKQ1.231003.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/118.0.0.0 Mobile Safari/537.36'
    };

    const payload = { biz_params: {} };
    const result = await getGoodsListByEncryptedPayload(payload, auth);
    const list = Array.isArray(result.goods_list) ? result.goods_list : [];

    const statusCount = list.reduce((acc, x) => {
        const k = String(x.status || '未知');
        acc[k] = Number(acc[k] || 0) + 1;
        return acc;
    }, {});

    const sample = list.slice(0, 5).map((x) => ({
        account: x.account,
        gameName: x.gameName,
        roleName: x.roleName,
        status: x.status,
        rawStatus: x.rawStatus,
        gameId: x.gameId,
        id: x.id,
        exceptionMsg: x.exceptionMsg
    }));

    const has987437118 = list.find((x) => String(x.account) === '987437118');

    const report = {
        request: {
            endpoint: 'https://api-game.duodian.cn/api/ybzs/accountManage/getAccountList',
            method: 'POST',
            headers: {
                token: mask(auth.token_yuanbao || auth.token_get),
                deviceid: auth.device_id,
                packagename: auth.package_name,
                appversion: auth.app_version,
                mainversion: auth.main_version,
                'x-versioncode': auth.x_versioncode,
                'x-versionnumber': auth.x_versionnumber,
                'x-channel': auth.x_channel,
                'content-type': 'application/json; charset=UTF-8'
            },
            encrypted_payload_model: { ak: 'base64(rsa(aes_key))', data: 'base64(aes(param+timestamp))' },
            biz_params: payload.biz_params
        },
        response: {
            code: result.raw && result.raw.code,
            desc: result.raw && result.raw.desc,
            total_count: list.length,
            status_count: statusCount
        },
        mapping_sample: sample,
        account_987437118: has987437118
            ? {
                account: has987437118.account,
                status: has987437118.status,
                rawStatus: has987437118.rawStatus,
                id: has987437118.id,
                gameId: has987437118.gameId
            }
            : null
    };

    console.log(JSON.stringify(report, null, 2));
}

main().catch((err) => {
    console.error('[probe-failed]', err && err.message ? err.message : err);
    process.exit(1);
});

