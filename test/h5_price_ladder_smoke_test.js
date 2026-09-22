#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rent-h5-price-ladder-'));
process.env.MAIN_DB_FILE_PATH = path.join(tempDir, 'rent_robot.db');
process.env.RUNTIME_DB_FILE_PATH = path.join(tempDir, 'rent_robot_runtime.db');
process.env.ORDER_DB_FILE_PATH = path.join(tempDir, 'rent_robot_order.db');
process.env.STATS_DB_FILE_PATH = path.join(tempDir, 'rent_robot_stats.db');
process.env.PRICE_DB_FILE_PATH = path.join(tempDir, 'rent_robot_price.db');
process.env.SHEEP_FIX_ENABLE = '0';
process.env.BL_V2_INSPECTOR_ENABLE = '0';
process.env.ORDER_COUNT_TRACE = 'false';
process.env.H5_PORT = String(24080 + Math.floor(Math.random() * 1000));

const { createUserByAdmin } = require('../database/user_db');
const { upsertUserGameAccount } = require('../database/user_game_account_db');
const { createAccessToken } = require('../user/auth_token');
const { bootstrap } = require('../h5/local_h5_server');
const { stopProdRiskTaskWorker } = require('../product/prod_status_guard');

async function main() {
    const user = await createUserByAdmin({
        account: 'h5_price_ladder_user',
        password: '123456',
        name: '阶梯定价测试用户',
        user_type: '内部',
        status: 'enabled'
    });
    await upsertUserGameAccount({
        user_id: user.id,
        game_id: '2',
        game_name: '和平精英',
        game_account: 'ladder-a',
        account_remark: '测试账号A',
        channel_prd_info: {
            uhaozu: {
                prd_id: 'uhaozu-ladder-a',
                rentalByHour: 2.4,
                rentalByNight: 9.6,
                rentalByDay: 14.4,
                rentalByWeek: 84
            },
            uuzuhao: {
                prd_id: 'uuzuhao-ladder-a',
                hourPrice: 2.4,
                minRentHour: 2
            }
        }
    });

    const server = await bootstrap();
    const baseUrl = `http://127.0.0.1:${process.env.H5_PORT}`;
    const headers = {
        Authorization: `Bearer ${createAccessToken(user)}`,
        'Content-Type': 'application/json'
    };
    try {
        const unauthorized = await fetch(`${baseUrl}/api/pricing/ladder?game_name=${encodeURIComponent('和平精英')}`);
        assert.strictEqual(unauthorized.status, 401);

        const getRes = await fetch(`${baseUrl}/api/pricing/ladder?game_name=${encodeURIComponent('和平精英')}`, { headers });
        const getJson = await getRes.json();
        assert.strictEqual(getRes.status, 200);
        assert.strictEqual(getJson.ok, true);
        assert.strictEqual(getJson.count_window, '06:00～次日06:00');
        assert.strictEqual(getJson.list.length, 1);
        assert.strictEqual(getJson.feature.enabled, false);
        assert.deepStrictEqual(getJson.list[0].prices, ['', '', '', '']);

        const featureRes = await fetch(`${baseUrl}/api/pricing/ladder/feature`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ enabled: true, expected_version: 0 })
        });
        const featureJson = await featureRes.json();
        assert.strictEqual(featureRes.status, 200);
        assert.strictEqual(featureJson.feature.enabled, true);
        assert.strictEqual(featureJson.feature.reconcile_required, true);

        const staleFeatureRes = await fetch(`${baseUrl}/api/pricing/ladder/feature`, {
            method: 'POST',
            headers,
            body: JSON.stringify({ enabled: false, expected_version: 0 })
        });
        assert.strictEqual(staleFeatureRes.status, 409);

        const saveRes = await fetch(`${baseUrl}/api/pricing/ladder/account`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                game_name: '和平精英',
                game_account: 'ladder-a',
                prices: [2.4, 3.4, 5.4, 10.4],
                expected_version: 0
            })
        });
        const saveJson = await saveRes.json();
        assert.strictEqual(saveRes.status, 200);
        assert.strictEqual(saveJson.rule.version, 1);
        assert.strictEqual(saveJson.rule.baseline_created, true);

        const channelRes = await fetch(`${baseUrl}/api/pricing/ladder/channel-result?game_name=${encodeURIComponent('和平精英')}&game_account=ladder-a`, { headers });
        const channelJson = await channelRes.json();
        assert.strictEqual(channelRes.status, 200);
        assert.strictEqual(channelJson.channel_result.baseline_status, 'default');
        assert.strictEqual(channelJson.channel_result.tiers.length, 4);
        assert.strictEqual(channelJson.channels.length, 3);
        assert.strictEqual(channelJson.channels.find((item) => item.channel === 'uuzuhao').enabled, true);
        assert.strictEqual(channelJson.channel_results.uuzuhao.tiers[0].prices.p2, 4.32);
        assert.strictEqual(channelJson.channel_results.uuzuhao.verification_note, '时租价已回读验证，套餐价以平台成功响应为准');
        assert.strictEqual(channelJson.channel_result.adjustment_logs.length, 1);
        assert.strictEqual(channelJson.channel_result.adjustment_logs[0].publish_status, 'fail');
        assert.strictEqual(channelJson.channel_result.adjustment_logs[0].error_detail.stage, 'authorization');

        const uuzuhaoChannelRes = await fetch(`${baseUrl}/api/pricing/ladder/channel-result?game_name=${encodeURIComponent('和平精英')}&game_account=ladder-a&channel=uuzuhao`, { headers });
        const uuzuhaoChannelJson = await uuzuhaoChannelRes.json();
        assert.strictEqual(uuzuhaoChannelJson.selected_channel, 'uuzuhao');
        assert.strictEqual(uuzuhaoChannelJson.channel_result.package_keys.length, 9);
        assert.strictEqual(uuzuhaoChannelJson.channel_result.adjustment_logs[0].error_detail.stage, 'authorization');

        const ratioGetRes = await fetch(`${baseUrl}/api/pricing/ladder/package-ratios`, { headers });
        const ratioGetJson = await ratioGetRes.json();
        assert.strictEqual(ratioGetRes.status, 200);
        assert.deepStrictEqual(ratioGetJson.channels.map((item) => item.channel), ['uhaozu', 'zuhaowang', 'uuzuhao']);
        assert.strictEqual(ratioGetJson.channels.find((item) => item.channel === 'zuhaowang').ratios.p24, 4.5);
        assert.deepStrictEqual(ratioGetJson.channels.find((item) => item.channel === 'zuhaowang').price_rules.p24, {
            decimals: 1,
            rounding: 'truncate'
        });
        const ratioSaveRes = await fetch(`${baseUrl}/api/pricing/ladder/package-ratios`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                channel: 'uhaozu',
                ratios: { hour: 1, night: 4.2, day: 6.2, week: 35.2 },
                expected_version: 0
            })
        });
        const ratioSaveJson = await ratioSaveRes.json();
        assert.strictEqual(ratioSaveRes.status, 200);
        assert.strictEqual(ratioSaveJson.setting.ratios.night, 4.2);
        assert.strictEqual(ratioSaveJson.setting.queued_count, 1);

        const missingAccountRes = await fetch(`${baseUrl}/api/pricing/ladder/channel-result?game_name=${encodeURIComponent('和平精英')}`, { headers });
        assert.strictEqual(missingAccountRes.status, 400);

        const removedBaselineRes = await fetch(`${baseUrl}/api/pricing/ladder/channel-baseline`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                game_name: '和平精英',
                game_account: 'ladder-a',
                channel: 'uhaozu'
            })
        });
        assert.strictEqual(removedBaselineRes.status, 404);

        const conflictRes = await fetch(`${baseUrl}/api/pricing/ladder/account`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                game_name: '和平精英',
                game_account: 'ladder-a',
                prices: [2.5, 3.5, 5.5, 10.5],
                expected_version: 0
            })
        });
        const conflictJson = await conflictRes.json();
        assert.strictEqual(conflictRes.status, 409);
        assert(/配置已变化/.test(conflictJson.message));

        const clearRes = await fetch(`${baseUrl}/api/pricing/ladder/account`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                game_name: '和平精英',
                game_account: 'ladder-a',
                action: 'clear',
                prices: [],
                expected_version: 1
            })
        });
        const clearJson = await clearRes.json();
        assert.strictEqual(clearRes.status, 200);
        assert.strictEqual(clearJson.rule.configured, false);
        const clearedGetRes = await fetch(`${baseUrl}/api/pricing/ladder?game_name=${encodeURIComponent('和平精英')}`, { headers });
        const clearedGetJson = await clearedGetRes.json();
        assert.strictEqual(clearedGetJson.list[0].configured, false);
        assert.deepStrictEqual(clearedGetJson.list[0].prices, ['', '', '', '']);

        const staticRes = await fetch(`${baseUrl}/?menu=pricing_uhaozu`);
        const staticHtml = await staticRes.text();
        assert.strictEqual(staticRes.status, 200);
        assert(staticHtml.includes('账号阶梯价格'));
        assert(staticHtml.includes('pricingFeatureToggle'));
        assert(staticHtml.includes('pricingSearchInput'));
        assert(staticHtml.includes('统一时租基准价生效渠道：U号租、租号王、悠悠租号'));
        assert(staticHtml.includes('套餐比例设置'));
        assert(staticHtml.includes('pricingRatioPanel'));
        assert(staticHtml.includes('pricingChannelSheet'));
        assert(staticHtml.includes('渠道价格'));

        console.log('[OK] h5_price_ladder_smoke_test passed');
    } finally {
        await new Promise((resolve) => server.close(resolve));
        stopProdRiskTaskWorker();
    }
}

main().catch((err) => {
    stopProdRiskTaskWorker();
    console.error('[FAIL] h5_price_ladder_smoke_test failed:', err);
    process.exit(1);
});
