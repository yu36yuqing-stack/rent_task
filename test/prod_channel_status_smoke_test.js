#!/usr/bin/env node
'use strict';

/**
 * Smoke Test - 渠道状态归一化与自动上架闸门
 *
 * 用途：
 * 1) 快速验证本次 PRD 落地的核心逻辑是否可用（几秒内完成，不依赖外部平台网络）。
 * 2) 作为“改完立刻跑”的最小回归脚本，避免把明显错误带到联调阶段。
 *
 * 这个脚本重点覆盖：
 * - product/prod_channel_status.js
 *   - 三平台状态映射（U号租/租号王）
 *   - overall 优先级是否按异常优先
 *   - 上架能力位（异常态不可自动上架）
 * - action_engine/action_engine.js
 *   - 自动补上架(on_y/on_u/on_z)前是否接入渠道状态闸门
 *
 * 这个脚本不覆盖：
 * - 实际 HTTP 接口联调（/api/products 等）
 * - 真实平台授权、真实上下架调用
 * - 前端渲染样式
 *
 * 运行方式：
 *   node test/prod_channel_status_smoke_test.js
 *
 * 预期结果：
 * - 所有检查输出 [PASS]
 * - 最终输出 "Smoke passed"
 * - 任意检查失败会输出 [FAIL] 并以非 0 退出码结束
 */

const {
    buildPlatformStatusNorm,
    buildNormalizedStatus,
    pickOverallStatusNorm,
    isOnAllowedByCode
} = require('../product/prod_channel_status');
const { detectConflictsAndBuildSnapshot } = require('../action_engine/action_engine');

function fail(msg) {
    console.error(`[FAIL] ${msg}`);
    process.exit(1);
}

function pass(msg) {
    console.log(`[PASS] ${msg}`);
}

function assertEqual(actual, expected, msg) {
    if (actual !== expected) {
        fail(`${msg} | expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`);
    }
    pass(msg);
}

function assertTrue(cond, msg) {
    if (!cond) fail(msg);
    pass(msg);
}

function testProdChannelStatus() {
    const normU = buildPlatformStatusNorm(
        { uhaozu: '上架' },
        { uhaozu: { audit_reason: '账号异常', goods_status: 3, rent_status: 1 } },
        {}
    );
    assertEqual(normU.uhaozu.code, 'auth_abnormal', 'U号租 audit_reason 命中 auth_abnormal');
    assertEqual(normU.uhaozu.label, '授权异常', 'U号租普通异常文案保持授权异常');
    assertEqual(normU.uhaozu.reason, '账号异常', 'U号租 reason 透传');

    const normUOnline = buildPlatformStatusNorm(
        { uhaozu: '上架' },
        { uhaozu: { audit_reason: '检测游戏在线，请确认游戏离线后手动上架', goods_status: 3, rent_status: 1 } },
        {}
    );
    assertEqual(normUOnline.uhaozu.code, 'auth_abnormal', 'U号租在线检测仍保持 auth_abnormal code');
    assertEqual(normUOnline.uhaozu.label, '检测在线', 'U号租命中特定在线文案映射为检测在线');

    const normZ = buildPlatformStatusNorm(
        { zuhaowang: '上架' },
        { zuhaowang: { exception_msg: '解除异常', raw_status: 1 } },
        {}
    );
    assertEqual(normZ.zuhaowang.code, 'auth_abnormal', '租号王 exception_msg 命中 auth_abnormal');

    const overall = pickOverallStatusNorm({
        uuzuhao: buildNormalizedStatus('listed'),
        uhaozu: buildNormalizedStatus('auth_abnormal', '账号异常'),
        zuhaowang: buildNormalizedStatus('off_shelf')
    });
    assertEqual(overall.code, 'auth_abnormal', 'overall 按优先级取异常优先');

    assertEqual(isOnAllowedByCode('auth_abnormal'), false, 'auth_abnormal 不允许自动上架');
    assertEqual(isOnAllowedByCode('review_fail'), false, 'review_fail 不允许自动上架');
    assertEqual(isOnAllowedByCode('restricted'), false, 'restricted 不允许自动上架');
    assertEqual(isOnAllowedByCode('listed'), true, 'listed 允许自动上架');
}

function testActionEngineOnGate() {
    const out = detectConflictsAndBuildSnapshot({
        youpinData: [{ account: 'A100', status: '下架', remark: 'r1', reason: '' }],
        uhaozuData: [{ account: 'A100', status: '下架', reason: '' }],
        zhwData: [{ account: 'A100', status: '下架', gameId: 1 }],
        blacklistAccounts: new Set(),
        platformRestrictSet: new Set(),
        platformStatusNormMap: {
            A100: {
                uuzuhao: { code: 'auth_abnormal' }, // 应阻断 on_y
                uhaozu: { code: 'listed' }, // 允许 on_u
                zuhaowang: { code: 'listed' } // 允许 on_z
            }
        }
    });

    const actions = Array.isArray(out.actions) ? out.actions : [];
    const hasOnY = actions.some((a) => String(a && a.type || '') === 'on_y');
    const hasOnU = actions.some((a) => String(a && a.type || '') === 'on_u');
    const hasOnZ = actions.some((a) => String(a && a.type || '') === 'on_z');

    assertEqual(hasOnY, false, '异常渠道不生成 on_y 自动补上架');
    assertTrue(hasOnU || hasOnZ, '非异常渠道仍可生成自动补上架动作');
}

function main() {
    testProdChannelStatus();
    testActionEngineOnGate();
    console.log('Smoke passed');
}

main();
