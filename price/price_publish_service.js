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

function deriveUhaozuPackagePriceSet(targetHour, baseline = {}) {
    const hour = Number(targetHour || 0);
    const baseHour = Number(baseline.rentalByHour || 0);
    if (!Number.isFinite(hour) || hour <= 0) throw new Error('目标时租价不合法');
    if (!Number.isFinite(baseHour) || baseHour <= 0) throw new Error('U号租当前时租价不完整');
    const derive = (key) => {
        const value = Number(baseline[key] || 0);
        if (!Number.isFinite(value) || value <= 0) throw new Error(`U号租当前${key}价格不完整`);
        return Number((hour * value / baseHour).toFixed(2));
    };
    return {
        rentalByHour: Number(hour.toFixed(2)),
        rentalByNight: derive('rentalByNight'),
        rentalByDay: derive('rentalByDay'),
        rentalByWeek: derive('rentalByWeek')
    };
}

function samePublishPriceSet(target = {}, actual = {}) {
    return ['rentalByHour', 'rentalByNight', 'rentalByDay', 'rentalByWeek'].every((key) => (
        Number(Number(target[key] || 0).toFixed(2)) === Number(Number(actual[key] || 0).toFixed(2))
    ));
}

function sanitizePriceLogPayload(value, depth = 0) {
    if (value === null || value === undefined) return value;
    if (depth > 6) return '[truncated]';
    if (Array.isArray(value)) return value.map((item) => sanitizePriceLogPayload(item, depth + 1));
    if (typeof value !== 'object') return value;
    const sensitive = /(cookie|authorization|token|password|passwd|pwd|mobile|phone|idcard|identity|randstr)/i;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
        key,
        sensitive.test(key) ? '[redacted]' : sanitizePriceLogPayload(item, depth + 1)
    ]));
}

function normalizeUhaozuTargetPriceSet(prices = {}) {
    const target = {
        rentalByHour: Number(prices.hour ?? prices.rentalByHour ?? 0),
        rentalByNight: Number(prices.night ?? prices.rentalByNight ?? 0),
        rentalByDay: Number(prices.day ?? prices.rentalByDay ?? 0),
        rentalByWeek: Number(prices.week ?? prices.rentalByWeek ?? 0)
    };
    if (Object.values(target).some((value) => !Number.isFinite(value) || value <= 0)) {
        throw new Error('U号租目标套餐价格不完整');
    }
    return Object.fromEntries(Object.entries(target).map(([key, value]) => [key, Number(value.toFixed(2))]));
}

async function publishUhaozuAccountPriceSetByUser(userId, input = {}, options = {}) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    const gameId = String(input.game_id || '').trim();
    const gameName = String(input.game_name || '').trim();
    const gameAccount = String(input.game_account || '').trim();
    if (!gameId || !gameName || !gameAccount) throw new Error('调价账号信息不完整');
    const targetPrices = normalizeUhaozuTargetPriceSet(input.prices || {});
    const accountRows = await listAllAccountsByUser(uid);
    const row = accountRows.find((item) => (
        String(item.game_id || '').trim() === gameId
        && String(item.game_account || '').trim() === gameAccount
    ));
    if (!row) throw new Error('调价账号不存在');
    const info = row.channel_prd_info && row.channel_prd_info.uhaozu && typeof row.channel_prd_info.uhaozu === 'object'
        ? row.channel_prd_info.uhaozu
        : {};
    const goodsId = String(input.goods_id || info.prd_id || info.goods_id || '').trim();
    if (!goodsId) throw new Error('缺少 U号租商品ID');

    const queryGoods = options.query_goods || queryGoodsModifyPayloadByGoodsId;
    const modifyGoods = options.modify_goods || modifyUhaozuGoods;
    const batchId = String(input.batch_id || buildPublishBatchId(uid, 'uhaozu-ladder')).trim();
    const triggerSource = String(input.trigger_source || 'price_ladder').trim();
    const forcePublish = input.force_publish === true;
    const startedAt = nowText();
    let batchCreated = false;
    let beforePayload = null;
    let afterPayload = null;
    let modifyOutput = null;
    let failureStage = 'authorization';
    const ensureBatch = async () => {
        if (batchCreated) return;
        await createPricePublishBatchLog({
            batch_id: batchId,
            user_id: uid,
            channel: 'uhaozu',
            game_name: gameName,
            trigger_source: triggerSource,
            request_snapshot: {
                game_id: gameId,
                game_account: gameAccount,
                tier: Number(input.tier || 0),
                prices: targetPrices,
                force_publish: forcePublish
            },
            total_count: 1,
            success_count: 0,
            fail_count: 0,
            status: 'running',
            start_time: startedAt,
            desc: 'publish account price ladder'
        });
        batchCreated = true;
    };
    try {
        const auth = options.auth || await getUhaozuAuthPayloadByUser(uid);
        failureStage = 'query_before';
        beforePayload = await queryGoods(goodsId, auth);
        const beforePrices = pickPriceFields(beforePayload);
        if (!forcePublish && samePublishPriceSet(targetPrices, beforePrices)) {
            return {
                ok: true,
                changed: false,
                batch_id: '',
                goods_id: goodsId,
                prices: beforePrices,
                reason: 'already_matches'
            };
        }
        await ensureBatch();
        const beforeInfo = beforePayload && beforePayload.info && typeof beforePayload.info === 'object'
            ? beforePayload.info
            : {};
        failureStage = 'modify';
        modifyOutput = await modifyGoods(goodsId, {
            info: {
                ...targetPrices,
                deposit: Number(beforeInfo.deposit || 0)
            }
        }, auth);
        failureStage = 'query_after';
        afterPayload = await queryGoods(goodsId, auth);
        const afterPrices = pickPriceFields(afterPayload);
        failureStage = 'verify_after';
        if (!samePublishPriceSet(targetPrices, afterPrices)) {
            throw new Error(`U号租价格回读不一致: target=${JSON.stringify(targetPrices)} actual=${JSON.stringify(afterPrices)}`);
        }
        const payloadInfo = modifyOutput && modifyOutput.payload && modifyOutput.payload.info && typeof modifyOutput.payload.info === 'object'
            ? modifyOutput.payload.info
            : {};
        await upsertUserGameAccount({
            user_id: uid,
            game_account: gameAccount,
            game_id: gameId,
            game_name: gameName,
            account_remark: String(row.account_remark || '').trim(),
            channel_prd_info: {
                uhaozu: {
                    ...info,
                    rentalByHour: afterPrices.rentalByHour,
                    rentalByNight: afterPrices.rentalByNight,
                    rentalByDay: afterPrices.rentalByDay,
                    rentalByWeek: afterPrices.rentalByWeek,
                    deposit: Number(payloadInfo.deposit != null ? payloadInfo.deposit : beforeInfo.deposit || 0)
                }
            },
            desc: 'publish account price ladder to uhaozu'
        });
        await createPricePublishItemLog({
            batch_id: batchId,
            user_id: uid,
            channel: 'uhaozu',
            game_name: gameName,
            game_account: gameAccount,
            goods_id: goodsId,
            publish_status: 'success',
            before_data: sanitizePriceLogPayload(beforePayload),
            request_data: sanitizePriceLogPayload(modifyOutput && modifyOutput.payload),
            response_data: sanitizePriceLogPayload(modifyOutput && modifyOutput.result),
            after_data: sanitizePriceLogPayload(afterPayload),
            price_before_hour: beforePrices.rentalByHour,
            price_before_night: beforePrices.rentalByNight,
            price_before_day: beforePrices.rentalByDay,
            price_before_week: beforePrices.rentalByWeek,
            price_target_hour: targetPrices.rentalByHour,
            price_target_night: targetPrices.rentalByNight,
            price_target_day: targetPrices.rentalByDay,
            price_target_week: targetPrices.rentalByWeek,
            price_after_hour: afterPrices.rentalByHour,
            price_after_night: afterPrices.rentalByNight,
            price_after_day: afterPrices.rentalByDay,
            price_after_week: afterPrices.rentalByWeek,
            start_time: startedAt,
            end_time: nowText(),
            desc: 'publish account price ladder item'
        });
        await updatePricePublishBatchLog(batchId, {
            total_count: 1,
            success_count: 1,
            fail_count: 0,
            status: 'success',
            end_time: nowText(),
            desc: 'publish account price ladder completed'
        });
        return { ok: true, changed: true, batch_id: batchId, goods_id: goodsId, prices: afterPrices };
    } catch (error) {
        const message = String(error && error.message ? error.message : error);
        await ensureBatch();
        const beforePrices = pickPriceFields(beforePayload);
        const afterPrices = pickPriceFields(afterPayload);
        const remoteResponse = error && error.uhaozu_response
            ? error.uhaozu_response
            : (modifyOutput && modifyOutput.result ? modifyOutput.result : null);
        await createPricePublishItemLog({
            batch_id: batchId,
            user_id: uid,
            channel: 'uhaozu',
            game_name: gameName,
            game_account: gameAccount,
            goods_id: goodsId,
            publish_status: 'fail',
            fail_message: message,
            before_data: sanitizePriceLogPayload(beforePayload),
            request_data: sanitizePriceLogPayload(modifyOutput && modifyOutput.payload || { info: targetPrices }),
            response_data: sanitizePriceLogPayload({
                stage: failureStage,
                code: String(error && error.code || '').trim(),
                message,
                uhaozu_response: remoteResponse
            }),
            after_data: sanitizePriceLogPayload(afterPayload),
            price_before_hour: beforePrices.rentalByHour,
            price_before_night: beforePrices.rentalByNight,
            price_before_day: beforePrices.rentalByDay,
            price_before_week: beforePrices.rentalByWeek,
            price_target_hour: targetPrices.rentalByHour,
            price_target_night: targetPrices.rentalByNight,
            price_target_day: targetPrices.rentalByDay,
            price_target_week: targetPrices.rentalByWeek,
            price_after_hour: afterPrices.rentalByHour,
            price_after_night: afterPrices.rentalByNight,
            price_after_day: afterPrices.rentalByDay,
            price_after_week: afterPrices.rentalByWeek,
            start_time: startedAt,
            end_time: nowText(),
            desc: 'publish account price ladder item'
        });
        await updatePricePublishBatchLog(batchId, {
            total_count: 1,
            success_count: 0,
            fail_count: 1,
            status: 'fail',
            end_time: nowText(),
            desc: 'publish account price ladder failed'
        });
        return {
            ok: false,
            changed: false,
            batch_id: batchId,
            goods_id: goodsId,
            message,
            error_detail: sanitizePriceLogPayload({
                stage: failureStage,
                code: String(error && error.code || '').trim(),
                message,
                uhaozu_response: remoteResponse
            })
        };
    }
}

async function publishUhaozuPricingByUser(userId, options = {}) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');

    const gameName = String(options.game_name || 'WZRY').trim() || 'WZRY';
    const pricing = await getUhaozuPricingDashboardByUser(uid, { game_name: gameName });
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
            let beforePayload = null;
            let targetPrices = null;
            let afterPayload = null;
            try {
                beforePayload = await queryGoodsModifyPayloadByGoodsId(goodsId, auth);
                const beforeInfo = beforePayload && beforePayload.info && typeof beforePayload.info === 'object'
                    ? beforePayload.info
                    : {};
                targetPrices = deriveUhaozuPackagePriceSet(targetPrice, beforeInfo);
                const out = await modifyUhaozuGoods(goodsId, {
                    info: {
                        ...targetPrices,
                        deposit: Number(beforeInfo.deposit || 0)
                    }
                }, auth);
                afterPayload = await queryGoodsModifyPayloadByGoodsId(goodsId, auth);
                const payloadInfo = out && out.payload && out.payload.info && typeof out.payload.info === 'object'
                    ? out.payload.info
                    : {};
                const afterPrices = pickPriceFields(afterPayload);
                if (!samePublishPriceSet(targetPrices, afterPrices)) {
                    throw new Error(`U号租价格回读不一致: target=${JSON.stringify(targetPrices)} actual=${JSON.stringify(afterPrices)}`);
                }
                await upsertUserGameAccount({
                    user_id: uid,
                    game_account: gameAccount,
                    game_id: String(row.game_id || '').trim() || '',
                    game_name: String(row.game_name || pricing.game_name).trim() || pricing.game_name,
                    account_remark: String(row.account_remark || '').trim(),
                    channel_prd_info: {
                        uhaozu: {
                            ...info,
                            rentalByHour: afterPrices.rentalByHour,
                            rentalByNight: afterPrices.rentalByNight,
                            rentalByDay: afterPrices.rentalByDay,
                            rentalByWeek: afterPrices.rentalByWeek,
                            deposit: Number(payloadInfo.deposit != null ? payloadInfo.deposit : beforeInfo.deposit || 0)
                        }
                    },
                    desc: 'publish pricing to uhaozu'
                });
                const result = {
                    game_account: gameAccount,
                    goods_id: goodsId,
                    suggested_listing_hourly_price: targetPrice,
                    current_listing_hourly_price: afterPrices.rentalByHour,
                    batch_id: batchId,
                    ok: true,
                    message: 'ok'
                };
                results.push(result);
                const beforePrices = pickPriceFields(beforePayload);
                const requestPrices = pickPriceFields(out && out.payload);
                await createPricePublishItemLog({
                    batch_id: batchId,
                    user_id: uid,
                    channel: 'uhaozu',
                    game_name: pricing.game_name,
                    game_account: gameAccount,
                    goods_id: goodsId,
                    publish_status: 'success',
                    fail_message: '',
                    before_data: sanitizePriceLogPayload(beforePayload),
                    request_data: sanitizePriceLogPayload(out && out.payload),
                    response_data: sanitizePriceLogPayload(out && out.result),
                    after_data: sanitizePriceLogPayload(afterPayload),
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
                    before_data: sanitizePriceLogPayload(beforePayload),
                    request_data: targetPrices ? sanitizePriceLogPayload({ info: targetPrices }) : null,
                    response_data: sanitizePriceLogPayload({
                        message: result.message,
                        code: String(e && e.code || '').trim(),
                        uhaozu_response: e && e.uhaozu_response ? e.uhaozu_response : null
                    }),
                    after_data: sanitizePriceLogPayload(afterPayload),
                    price_before_hour: pickPriceFields(beforePayload).rentalByHour,
                    price_before_night: pickPriceFields(beforePayload).rentalByNight,
                    price_before_day: pickPriceFields(beforePayload).rentalByDay,
                    price_before_week: pickPriceFields(beforePayload).rentalByWeek,
                    price_target_hour: targetPrices ? targetPrices.rentalByHour : targetPrice,
                    price_target_night: targetPrices ? targetPrices.rentalByNight : 0,
                    price_target_day: targetPrices ? targetPrices.rentalByDay : 0,
                    price_target_week: targetPrices ? targetPrices.rentalByWeek : 0,
                    price_after_hour: pickPriceFields(afterPayload).rentalByHour,
                    price_after_night: pickPriceFields(afterPayload).rentalByNight,
                    price_after_day: pickPriceFields(afterPayload).rentalByDay,
                    price_after_week: pickPriceFields(afterPayload).rentalByWeek,
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
    publishUhaozuAccountPriceSetByUser,
    listPricePublishBatchLogsByUser,
    getPricePublishBatchLogByBatchId,
    listPricePublishItemLogsByBatchId,
    _internals: {
        randomDelayMs,
        isAuthRowUsable,
        buildPublishBatchId,
        pickPriceFields,
        deriveUhaozuPackagePriceSet,
        samePublishPriceSet,
        sanitizePriceLogPayload,
        normalizeUhaozuTargetPriceSet,
        sleep,
        getUhaozuAuthPayloadByUser
    }
};
