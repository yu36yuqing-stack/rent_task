#!/usr/bin/env node
'use strict';

const probePath = require.resolve('../product/prod_probe_cache_service');
const guardPath = require.resolve('../product/prod_status_guard');

function assertEqual(actual, expected, msg) {
    if (actual !== expected) {
        throw new Error(`${msg}: expected=${expected}, actual=${actual}`);
    }
}

async function main() {
    delete require.cache[probePath];
    delete require.cache[guardPath];

    const calls = [];
    require.cache[probePath] = {
        id: probePath,
        filename: probePath,
        loaded: true,
        exports: {
            resolveUuzuhaoAuthByUser: async () => ({ app_key: 'k', app_secret: 's' }),
            queryOnlineStatusCached: async (_uid, gameAccount) => {
                calls.push(String(gameAccount || '').trim());
                return {
                    game_account: String(gameAccount || '').trim(),
                    online: true,
                    query_time: '2026-03-15 21:00:00'
                };
            },
            setForbiddenPlayWithSnapshot: async () => ({ enabled: true, skipped: false })
        }
    };

    // eslint-disable-next-line global-require
    const { probeProdOnlineStatus } = require('../product/prod_status_guard');
    const ret = await probeProdOnlineStatus({ id: 8 }, [
        {
            account: 'enabled_acc',
            youpin: '下架',
            uhaozu: '下架',
            zuhaowan: '下架',
            switch: {
                prod_guard: {
                    label: '在线风控',
                    enabled: true
                }
            }
        },
        {
            account: 'disabled_acc',
            youpin: '下架',
            uhaozu: '下架',
            zuhaowan: '下架',
            switch: {
                prod_guard: {
                    label: '在线风控',
                    enabled: false
                }
            }
        }
    ], {
        force_probe: true,
        include_rows: true,
        logger: { log() {}, warn() {}, error() {} }
    });

    assertEqual(ret.skipped, false, 'probe 不应被整体跳过');
    assertEqual(ret.total_accounts, 1, '关闭在线风控的账号不应进入探测列表');
    assertEqual(calls.length, 1, '只应探测启用在线风控的账号');
    assertEqual(calls[0], 'enabled_acc', '被探测账号错误');

    console.log('[PASS] prod_guard_account_switch_smoke_test');
}

main().catch((err) => {
    console.error(`[FAIL] prod_guard_account_switch_smoke_test: ${err.message}`);
    process.exit(1);
});
