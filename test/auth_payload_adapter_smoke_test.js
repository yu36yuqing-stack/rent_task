/**
 * auth_payload_adapter_smoke_test.js
 *
 * 用途：
 * 1) 固化“平台授权结构兼容”契约，避免 future 改 auth_payload 结构时遗漏自动执行链路。
 * 2) 验证 buildAuthMap 对租号王(zuhaowang)统一按 yuanbao 结构输出可直接调用 API 的扁平凭据。
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
    assertEqual(map.zuhaowang.token_get, 'yb_a', 'buildAuthMap 应优先使用 yuanbao token 生成 token_get');
    assertEqual(map.zuhaowang.token_post, 'yb_a', 'buildAuthMap 应优先使用 yuanbao token 生成 token_post');
    assertEqual(map.zuhaowang.token_yuanbao, 'yb_a', 'buildAuthMap 应读取 yuanbao token');
    assertEqual(map.zuhaowang.package_name, 'com.duodian.merchant', 'buildAuthMap 应为元宝 token 补齐 merchant 包名');
    assertEqual(map.uuzuhao.app_key, 'k', '非租号王平台保持原样');

    const legacyYuanbaoOnly = resolveAuthPayloadByPlatform('zuhaowang', {
        yuanbao: {
            token: 'legacy_yb',
            deviceId: 'legacy_dev',
            package_name: 'legacy_pkg'
        }
    });
    assertEqual(legacyYuanbaoOnly.token_yuanbao, 'legacy_yb', '租号王应从 yuanbao 结构读取 token');
    assertEqual(legacyYuanbaoOnly.token_get, 'legacy_yb', '租号王应使用 yuanbao token 生成 token_get');
    assertEqual(legacyYuanbaoOnly.device_id, 'legacy_dev', '租号王应读取 yuanbao 设备号');

    const wrapped = resolveAuthPayloadByPlatform('zuhaowang', {
        zuhaowang: {
            token_get: 'nested_get',
            token_post: 'nested_post',
            device_id: 'nested_dev',
            package_name: 'com.duodian.freehire'
        },
        yuanbao: {
            data: {
                token: 'wrapped_yb_token',
                deviceId: 'wrapped_dev'
            }
        }
    });
    assertEqual(wrapped.token_yuanbao, 'wrapped_yb_token', '应兼容 yuanbao.data.token');
    assertEqual(wrapped.device_id, 'wrapped_dev', '应优先使用 yuanbao.data.deviceId');
    assertEqual(wrapped.package_name, 'com.duodian.merchant', '应为 yuanbao.data.token 自动切换 merchant 包名');

    assertTrue(!map.zuhaowang.yuanbao, '自动上下架授权不应把 yuanbao 子结构原样透传到调用侧');
    console.log('[PASS] auth_payload_adapter_smoke_test');
}

run();
