/**
 * auth_payload_adapter_smoke_test.js
 *
 * 用途：
 * 1) 固化“平台授权结构兼容”契约，避免 future 改 auth_payload 结构时遗漏自动执行链路。
 * 2) 验证 buildAuthMap 对租号王(zuhaowang)新旧两种结构都能返回可直接调用 API 的扁平凭据。
 *
 * 运行：
 *   node test/auth_payload_adapter_smoke_test.js
 */

const { buildAuthMap, resolveAuthPayloadByPlatform } = require('../user/user');

function assertEqual(actual, expected, msg) {
    if (actual !== expected) {
        throw new Error(`${msg}: expected=${expected}, actual=${actual}`);
    }
}

function assertTrue(cond, msg) {
    if (!cond) throw new Error(msg);
}

function run() {
    const rows = [
        {
            platform: 'zuhaowang',
            auth_status: 'valid',
            auth_payload: {
                zuhaowang: {
                    token_get: 'get_a',
                    token_post: 'post_a',
                    device_id: 'dev_a',
                    package_name: 'pkg_a'
                },
                yuanbao: {
                    token_yuanbao: 'yb_a'
                }
            }
        },
        {
            platform: 'uuzuhao',
            auth_status: 'valid',
            auth_payload: {
                app_key: 'k',
                app_secret: 's'
            }
        }
    ];

    const map = buildAuthMap(rows);
    assertEqual(map.zuhaowang.token_get, 'get_a', 'buildAuthMap 应读取 zuhaowang nested token_get');
    assertEqual(map.zuhaowang.token_post, 'post_a', 'buildAuthMap 应读取 zuhaowang nested token_post');
    assertEqual(map.uuzuhao.app_key, 'k', '非租号王平台保持原样');

    const legacy = resolveAuthPayloadByPlatform('zuhaowang', {
        token_get: 'legacy_get',
        token_post: 'legacy_post',
        device_id: 'legacy_dev',
        package_name: 'legacy_pkg'
    });
    assertEqual(legacy.token_get, 'legacy_get', '租号王旧结构仍兼容');

    assertTrue(!map.zuhaowang.yuanbao, '自动上下架授权不应误用 yuanbao 子结构');
    console.log('[PASS] auth_payload_adapter_smoke_test');
}

run();
