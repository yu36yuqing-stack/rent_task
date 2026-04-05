'use strict';

const { listUserGameAccounts, upsertUserGameAccount } = require('../database/user_game_account_db');
const { listUserPlatformAuth } = require('../database/user_platform_auth_db');
const {
    modifyUhaozuGoods,
    _internals: { queryGoodsModifyPayloadByGoodsId }
} = require('../uhaozu/uhaozu_api');
const { getUhaozuPricingDashboardByUser } = require('./price_h5_service');
const {
    createPricePublishBatchLog,
    updatePricePublishBatchLog,
    createPricePublishItemLog,
    listPricePublishBatchLogsByUser,
    getPricePublishBatchLogByBatchId,
    listPricePublishItemLogsByBatchId
} = require('../database/price_publish_log_db');

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function randomDelayMs(min = 100, max = 200) {
    const low = Math.max(0, Number(min || 0));
    const high = Math.max(low, Number(max || low));
    return Math.floor(Math.random() * (high - low + 1)) + low;
}

async function listAllAccountsByUser(userId) {
    const out = [];
    let page = 1;
    const pageSize = 200;
    for (;;) {
        const one = await listUserGameAccounts(userId, page, pageSize);
        const list = Array.isArray(one && one.list) ? one.list : [];
        out.push(...list);
        if (list.length < pageSize || out.length >= Number(one && one.total || 0)) break;
        page += 1;
    }
    return out;
}

function isAuthRowUsable(row = {}) {
    if (!row || typeof row !== 'object') return false;
    if (String(row.platform || '').trim() !== 'uhaozu') return false;
    if (String(row.auth_status || '').trim() !== 'valid') return false;
    const exp = String(row.expire_at || '').trim();
    if (!exp) return true;
    const ts = Date.parse(exp);
    return !Number.isFinite(ts) || ts > Date.now();
}

async function getUhaozuAuthPayloadByUser(userId) {
    const rows = await listUserPlatformAuth(userId, { with_payload: true });
    const row = rows.find(isAuthRowUsable);
    if (!row || !row.auth_payload || typeof row.auth_payload !== 'object') {
        throw new Error('当前用户没有可用的 U号租授权');
    }
    return row.auth_payload;
}

function nowText() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function buildPublishBatchId(userId, channel) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    const tail = Math.random().toString(36).slice(2, 8);
    return `${String(channel || 'pricing').trim()}_${Number(userId || 0)}_${stamp}_${tail}`;
}

function pickPriceFields(payload = {}) {
    const info = payload && payload.info && typeof payload.info === 'object' ? payload.info : {};
    return {
        rentalByHour: Number(info.rentalByHour || 0),
        rentalByNight: Number(info.rentalByNight || 0),
        rentalByDay: Number(info.rentalByDay || 0),
        rentalByWeek: Number(info.rentalByWeek || 0)
    };
}

function resolvePublishDeposit(options = {}, pricing = {}) {
    const optionValue = options ? options.deposit : undefined;
    if (optionValue !== undefined && optionValue !== null && String(optionValue).trim() !== '') {
        const parsed = Number(optionValue);
        if (!Number.isFinite(parsed) || parsed < 0) throw new Error('deposit 不合法');
        return parsed;
    }
    const configValue = pricing && pricing.config ? pricing.config.deposit : undefined;
    const parsedConfig = Number(configValue);
    if (Number.isFinite(parsedConfig) && parsedConfig >= 0) return parsedConfig;
    return 100;
}

async function publishUhaozuPricingByUser(userId, options = {}) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');

    const gameName = String(options.game_name || 'WZRY').trim() || 'WZRY';
    const pricing = await getUhaozuPricingDashboardByUser(uid, { game_name: gameName });
    const publishDeposit = resolvePublishDeposit(options, pricing);
    const auth = await getUhaozuAuthPayloadByUser(uid);
    const batchId = buildPublishBatchId(uid, 'uhaozu');
    const batchStartTime = nowText();
    await createPricePublishBatchLog({
        batch_id: batchId,
        user_id: uid,
        channel: 'uhaozu',
        game_name: pricing.game_name,
        trigger_source: String(options.trigger_source || 'pricing_h5').trim() || 'pricing_h5',
        request_snapshot: {
            game_name: pricing.game_name,
            options
        },
        total_count: pricing.list.length,
        success_count: 0,
        fail_count: 0,
        status: 'running',
        start_time: batchStartTime,
        desc: 'publish pricing batch'
    });
    const accountRows = await listAllAccountsByUser(uid);
    const accountMap = new Map(
        accountRows
            .filter((row) => String((row && row.game_name) || '').trim() === pricing.game_name)
            .map((row) => [String((row && row.game_account) || '').trim(), row])
    );

    const results = [];
    for (let i = 0; i < pricing.list.length; i += 1) {
        const item = pricing.list[i] || {};
        const gameAccount = String(item.game_account || '').trim();
        const row = accountMap.get(gameAccount) || {};
        const info = row && row.channel_prd_info && row.channel_prd_info.uhaozu && typeof row.channel_prd_info.uhaozu === 'object'
            ? row.channel_prd_info.uhaozu
            : {};
        const goodsId = String(info.prd_id || '').trim();
        const targetPrice = Number(item.suggested_listing_hourly_price || 0);
        const itemStartTime = nowText();

        if (!gameAccount || !goodsId || !Number.isFinite(targetPrice) || targetPrice <= 0) {
            const result = {
                game_account: gameAccount,
                goods_id: goodsId,
                suggested_listing_hourly_price: targetPrice,
                ok: false,
                message: !goodsId ? '缺少 U号租商品ID' : '建议价格不合法'
            };
            results.push(result);
            await createPricePublishItemLog({
                batch_id: batchId,
                user_id: uid,
                channel: 'uhaozu',
                game_name: pricing.game_name,
                game_account: gameAccount,
                goods_id: goodsId,
                publish_status: 'fail',
                fail_message: result.message,
                price_target_hour: targetPrice,
                start_time: itemStartTime,
                end_time: nowText(),
                desc: 'publish pricing item'
            });
        } else {
            try {
                const beforePayload = await queryGoodsModifyPayloadByGoodsId(goodsId, auth);
                const out = await modifyUhaozuGoods(goodsId, {
                    info: {
                        rentalByHour: targetPrice,
                        deposit: publishDeposit
                    }
                }, auth);
                const afterPayload = await queryGoodsModifyPayloadByGoodsId(goodsId, auth);
                const payloadInfo = out && out.payload && out.payload.info && typeof out.payload.info === 'object'
                    ? out.payload.info
                    : {};
                await upsertUserGameAccount({
                    user_id: uid,
                    game_account: gameAccount,
                    game_id: String(row.game_id || '').trim() || '',
                    game_name: String(row.game_name || pricing.game_name).trim() || pricing.game_name,
                    account_remark: String(row.account_remark || '').trim(),
                    channel_prd_info: {
                        uhaozu: {
                            ...info,
                            rentalByHour: Number(payloadInfo.rentalByHour || targetPrice),
                            rentalByNight: Number(payloadInfo.rentalByNight || info.rentalByNight || 0),
                            rentalByDay: Number(payloadInfo.rentalByDay || info.rentalByDay || 0),
                            rentalByWeek: Number(payloadInfo.rentalByWeek || info.rentalByWeek || 0),
                            deposit: Number(payloadInfo.deposit != null ? payloadInfo.deposit : publishDeposit)
                        }
                    },
                    desc: 'publish pricing to uhaozu'
                });
                const result = {
                    game_account: gameAccount,
                    goods_id: goodsId,
                    suggested_listing_hourly_price: targetPrice,
                    current_listing_hourly_price: Number(payloadInfo.rentalByHour || targetPrice),
                    batch_id: batchId,
                    ok: true,
                    message: 'ok'
                };
                results.push(result);
                const beforePrices = pickPriceFields(beforePayload);
                const requestPrices = pickPriceFields(out && out.payload);
                const afterPrices = pickPriceFields(afterPayload);
                await createPricePublishItemLog({
                    batch_id: batchId,
                    user_id: uid,
                    channel: 'uhaozu',
                    game_name: pricing.game_name,
                    game_account: gameAccount,
                    goods_id: goodsId,
                    publish_status: 'success',
                    fail_message: '',
                    before_data: beforePayload,
                    request_data: out && out.payload,
                    response_data: out && out.result,
                    after_data: afterPayload,
                    price_before_hour: beforePrices.rentalByHour,
                    price_before_night: beforePrices.rentalByNight,
                    price_before_day: beforePrices.rentalByDay,
                    price_before_week: beforePrices.rentalByWeek,
                    price_target_hour: requestPrices.rentalByHour,
                    price_target_night: requestPrices.rentalByNight,
                    price_target_day: requestPrices.rentalByDay,
                    price_target_week: requestPrices.rentalByWeek,
                    price_after_hour: afterPrices.rentalByHour,
                    price_after_night: afterPrices.rentalByNight,
                    price_after_day: afterPrices.rentalByDay,
                    price_after_week: afterPrices.rentalByWeek,
                    start_time: itemStartTime,
                    end_time: nowText(),
                    desc: 'publish pricing item'
                });
            } catch (e) {
                const result = {
                    game_account: gameAccount,
                    goods_id: goodsId,
                    suggested_listing_hourly_price: targetPrice,
                    batch_id: batchId,
                    ok: false,
                    message: String(e && e.message ? e.message : e)
                };
                results.push(result);
                await createPricePublishItemLog({
                    batch_id: batchId,
                    user_id: uid,
                    channel: 'uhaozu',
                    game_name: pricing.game_name,
                    game_account: gameAccount,
                    goods_id: goodsId,
                    publish_status: 'fail',
                    fail_message: result.message,
                    price_target_hour: targetPrice,
                    start_time: itemStartTime,
                    end_time: nowText(),
                    desc: 'publish pricing item'
                });
            }
        }

        if (i < pricing.list.length - 1) {
            await sleep(randomDelayMs(100, 200));
        }
    }

    const successCount = results.filter((x) => x.ok).length;
    const failCount = results.length - successCount;
    await updatePricePublishBatchLog(batchId, {
        total_count: results.length,
        success_count: successCount,
        fail_count: failCount,
        status: failCount === 0 ? 'success' : (successCount > 0 ? 'partial_fail' : 'fail'),
        end_time: nowText(),
        desc: 'publish pricing batch completed'
    });
    return {
        batch_id: batchId,
        channel: 'uhaozu',
        game_name: pricing.game_name,
        total_count: results.length,
        success_count: successCount,
        fail_count: failCount,
        list: results
    };
}

module.exports = {
    publishUhaozuPricingByUser,
    listPricePublishBatchLogsByUser,
    getPricePublishBatchLogByBatchId,
    listPricePublishItemLogsByBatchId,
    _internals: {
        randomDelayMs,
        isAuthRowUsable,
        buildPublishBatchId,
        pickPriceFields
    }
};
