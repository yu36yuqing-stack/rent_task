'use strict';

const { listUserGameAccounts, upsertUserGameAccount } = require('../database/user_game_account_db');
const { listUserPlatformAuth } = require('../database/user_platform_auth_db');
const {
    modifyUhaozuGoods,
    _internals: { queryGoodsModifyPayloadByGoodsId }
} = require('../uhaozu/uhaozu_api');
const {
    modifyProductPrice: modifyUuzuhaoProductPrice,
    queryProductByAccount: queryUuzuhaoProductByAccount,
    _internals: { buildModifyPricePayload: buildUuzuhaoModifyPricePayload }
} = require('../uuzuhao/uuzuhao_api');
const {
    getPriceTemplate: getZuhaowangPriceTemplate,
    changePriceTemplate: changeZuhaowangPriceTemplate
} = require('../zuhaowang/zuhaowang_price_api');
const { _internals: { resolveDataIdByAccountAndGame } } = require('../zuhaowang/zuhaowang_api');
const { normalizePackagePrice: normalizeZuhaowangPackagePrice } = require('./channel_adapters/zuhaowang_price_adapter');
const { normalizeZuhaowangAuthPayload } = require('../user/user');
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

function isAuthRowUsable(row = {}, platform = 'uhaozu') {
    if (!row || typeof row !== 'object') return false;
    if (String(row.platform || '').trim() !== String(platform || '').trim()) return false;
    if (String(row.auth_status || '').trim() !== 'valid') return false;
    if (row.channel_enabled === false) return false;
    const exp = String(row.expire_at || '').trim();
    if (!exp) return true;
    const ts = Date.parse(exp);
    return !Number.isFinite(ts) || ts > Date.now();
}

async function getUhaozuAuthPayloadByUser(userId) {
    const rows = await listUserPlatformAuth(userId, { with_payload: true });
    const row = rows.find((item) => isAuthRowUsable(item, 'uhaozu'));
    if (!row || !row.auth_payload || typeof row.auth_payload !== 'object') {
        throw new Error('当前用户没有可用的 U号租授权');
    }
    return row.auth_payload;
}

async function getUuzuhaoAuthPayloadByUser(userId) {
    const rows = await listUserPlatformAuth(userId, { with_payload: true });
    const row = rows.find((item) => isAuthRowUsable(item, 'uuzuhao'));
    if (!row || !row.auth_payload || typeof row.auth_payload !== 'object') {
        throw new Error('当前用户没有可用的 悠悠租号授权');
    }
    return row.auth_payload;
}

async function getZuhaowangAuthPayloadByUser(userId) {
    const rows = await listUserPlatformAuth(userId, { with_payload: true });
    const row = rows.find((item) => isAuthRowUsable(item, 'zuhaowang'));
    if (!row || !row.auth_payload || typeof row.auth_payload !== 'object') {
        throw new Error('当前用户没有可用的 租号王授权');
    }
    return normalizeZuhaowangAuthPayload(row.auth_payload);
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

function pickUuzuhaoProductPriceSet(product = {}) {
    const source = product && typeof product === 'object' ? product : {};
    return {
        hour: Number(Number(source.productHourRentPrice ?? source.hourPrice ?? source.hour_price ?? source.rentalByHour ?? 0).toFixed(2)) || 0,
        min_rent_hour: Number(source.minRentHour ?? source.min_rent_hour ?? 0) || 0
    };
}

function normalizeUuzuhaoTargetPriceSet(prices = {}) {
    const hour = Number(prices.hour ?? prices.hourPrice ?? 0);
    if (!Number.isFinite(hour) || hour <= 0) throw new Error('悠悠租号目标时租价不合法');
    const fieldByKey = {
        p2: 'p2Price', p3: 'p3Price', p5: 'p5Price', p7: 'p7Price',
        p9: 'p9Price', p10: 'p10Price', p24: 'p24Price', p168: 'p168Price'
    };
    const input = { hourPrice: hour };
    for (const [key, field] of Object.entries(fieldByKey)) {
        if (prices[key] !== undefined) input[field] = prices[key];
    }
    const payload = buildUuzuhaoModifyPricePayload('price-preview', input);
    return {
        hour: Number(payload.hourPrice),
        p2: Number(payload.p2Price),
        p3: Number(payload.p3Price),
        p5: Number(payload.p5Price),
        p7: Number(payload.p7Price),
        p9: Number(payload.p9Price),
        p10: Number(payload.p10Price),
        p24: Number(payload.p24Price),
        p168: Number(payload.p168Price)
    };
}

function normalizeUuzuhaoReadbackDelays(value) {
    const source = Array.isArray(value) ? value : [0, 1000, 2000, 4000];
    const delays = source
        .slice(0, 6)
        .map((item) => Number(item))
        .filter((item) => Number.isFinite(item) && item >= 0)
        .map((item) => Math.min(10000, Math.round(item)));
    return delays.length > 0 ? delays : [0];
}

async function queryUuzuhaoProductUntilMatched(queryProduct, gameAccount, queryOptions, targetHour, options = {}) {
    const delays = normalizeUuzuhaoReadbackDelays(options.readback_delays_ms);
    const wait = options.sleep || sleep;
    let product = null;
    let prices = pickUuzuhaoProductPriceSet(null);
    let lastError = null;
    let attempts = 0;
    for (const delayMs of delays) {
        if (delayMs > 0) await wait(delayMs);
        attempts += 1;
        try {
            const current = await queryProduct(gameAccount, queryOptions);
            if (current) {
                product = current;
                prices = pickUuzuhaoProductPriceSet(current);
                if (prices.hour === targetHour) {
                    return { matched: true, product, prices, attempts, last_error: null };
                }
            }
        } catch (error) {
            lastError = error;
        }
    }
    return { matched: false, product, prices, attempts, last_error: lastError };
}

function normalizeZuhaowangTemplate(template = {}) {
    const data = template && template.data && typeof template.data === 'object' ? template.data : template;
    const accountInfo = data && data.accountInfo && typeof data.accountInfo === 'object' ? data.accountInfo : {};
    const selfTemplate = data && data.selfTemplate && typeof data.selfTemplate === 'object' ? data.selfTemplate : {};
    const shortRent = selfTemplate.shortRent && typeof selfTemplate.shortRent === 'object' ? selfTemplate.shortRent : null;
    const longRent = selfTemplate.longRent && typeof selfTemplate.longRent === 'object' ? selfTemplate.longRent : null;
    const shortOpen = Boolean(shortRent && shortRent.isOpen === true);
    const longOpen = Boolean(longRent && longRent.isOpen === true);
    if (Number(accountInfo.priceTemplateType || 0) !== 1) throw new Error('租号王当前仅支持自主定价模板');
    if (!shortOpen && !longOpen) throw new Error('租号王商品未开启时租或日租');
    const prices = {
        hour: shortOpen ? normalizeZuhaowangPackagePrice('hour', shortRent.obtainPrice || 0) : 0,
        p24: 0,
        p72: 0,
        p168: 0
    };
    for (const grade of Array.isArray(longRent && longRent.grades) ? longRent.grades : []) {
        const key = `p${String(grade && grade.key || '').trim()}`;
        if (Object.prototype.hasOwnProperty.call(prices, key)) {
            prices[key] = normalizeZuhaowangPackagePrice(key, grade.currentObtainPrice ?? grade.obtainPrice ?? 0) || 0;
        }
    }
    return {
        data,
        account_info: accountInfo,
        self_template: selfTemplate,
        short_rent: shortRent,
        long_rent: longRent,
        short_open: shortOpen,
        long_open: longOpen,
        rent_mode: shortOpen && longOpen ? 'hour_and_day' : (shortOpen ? 'hour_only' : 'day_only'),
        prices
    };
}

function normalizeZuhaowangTargetPriceSet(prices = {}) {
    const keys = ['hour', 'p24', 'p72', 'p168'];
    const out = {};
    for (const key of keys) {
        const value = Number(prices[key] || 0);
        if (!Number.isFinite(value) || value <= 0) throw new Error(`租号王目标${key}价格不合法`);
        out[key] = normalizeZuhaowangPackagePrice(key, value);
    }
    return out;
}

function buildZuhaowangChangePriceParams(dataId, normalizedTemplate = {}, targetPrices = {}) {
    const normalizedTargetPrices = normalizeZuhaowangTargetPriceSet(targetPrices);
    const assertRange = (value, minValue, maxValue, label) => {
        const price = Number(value);
        const min = Number(minValue || 0);
        const max = Number(maxValue || 0);
        if (min > 0 && price < min) throw new Error(`租号王${label}不能低于 ${min} 元`);
        if (max > 0 && price > max) throw new Error(`租号王${label}不能高于 ${max} 元`);
    };
    const discountGroups = normalizedTemplate.short_rent && Array.isArray(normalizedTemplate.short_rent.discounts)
        ? normalizedTemplate.short_rent.discounts
        : [];
    const selectedDiscount = discountGroups.find((item) => Number(item && item.selected || 0) === 1)
        || discountGroups[0]
        || null;
    const shortDetails = Array.isArray(selectedDiscount && selectedDiscount.details)
        ? selectedDiscount.details
        : [];
    const checkedMinHour = normalizedTemplate.short_rent && Array.isArray(normalizedTemplate.short_rent.minHours)
        ? normalizedTemplate.short_rent.minHours.find((item) => item && item.isChecked === true)
        : null;
    if (normalizedTemplate.short_open) {
        assertRange(
            normalizedTargetPrices.hour,
            normalizedTemplate.short_rent.minObtainPrice,
            normalizedTemplate.short_rent.maxObtainPrice,
            '时租到手价'
        );
    }
    const shortRent = normalizedTemplate.short_open ? {
        discount: shortDetails.map((item) => ({
            discount: Number(item.discount),
            hour: Number(item.hour)
        })),
        minHour: Number(checkedMinHour && checkedMinHour.hour || 1),
        obtainPrice: Number(normalizedTargetPrices.hour),
        isOpen: true,
        key: String(selectedDiscount && selectedDiscount.key || '1')
    } : null;
    const grades = Array.isArray(normalizedTemplate.long_rent && normalizedTemplate.long_rent.grades)
        ? normalizedTemplate.long_rent.grades
        : [];
    const longRent = normalizedTemplate.long_open ? {
        grades: grades.map((grade) => {
            const key = String(grade && grade.key || '').trim();
            const targetKey = `p${key}`;
            const value = Number(normalizedTargetPrices[targetKey] || 0);
            if (!Number.isFinite(value) || value <= 0) throw new Error(`租号王 ${key} 小时套餐目标价格不合法`);
            assertRange(value, grade.minObtainPrice, grade.maxObtainPrice, `${key}小时套餐价格`);
            return { obtainPrice: String(Number(value.toFixed(2))), key };
        }),
        isOpen: true
    } : null;
    const out = {
        dataId: String(dataId || '').trim(),
        priceTemplateType: String(normalizedTemplate.account_info.priceTemplateType ?? 1),
        selfTemplate: { shortRent, longRent }
    };
    const planId = normalizedTemplate.data && normalizedTemplate.data.pricePlanInfo
        ? normalizedTemplate.data.pricePlanInfo.planId
        : null;
    if (planId !== null && planId !== undefined && String(planId).trim()) out.planId = planId;
    return out;
}

function sameZuhaowangActivePriceSet(target = {}, actual = {}, mode = '') {
    const keys = mode === 'day_only'
        ? ['p24', 'p72', 'p168']
        : (mode === 'hour_only' ? ['hour'] : ['hour', 'p24', 'p72', 'p168']);
    return keys.every((key) => (
        normalizeZuhaowangPackagePrice(key, target[key]) === normalizeZuhaowangPackagePrice(key, actual[key])
    ));
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

async function publishUuzuhaoAccountPriceSetByUser(userId, input = {}, options = {}) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    const gameId = String(input.game_id || '').trim();
    const gameName = String(input.game_name || '').trim();
    const gameAccount = String(input.game_account || '').trim();
    if (!gameId || !gameName || !gameAccount) throw new Error('调价账号信息不完整');
    const targetPrices = normalizeUuzuhaoTargetPriceSet(input.prices || {});
    const accountRows = await listAllAccountsByUser(uid);
    const row = accountRows.find((item) => (
        String(item.game_id || '').trim() === gameId
        && String(item.game_account || '').trim() === gameAccount
    ));
    if (!row) throw new Error('调价账号不存在');
    const info = row.channel_prd_info && row.channel_prd_info.uuzuhao && typeof row.channel_prd_info.uuzuhao === 'object'
        ? row.channel_prd_info.uuzuhao
        : {};
    const goodsId = String(input.goods_id || info.prd_id || info.product_id || '').trim();
    if (!goodsId) throw new Error('缺少 悠悠租号商品ID');

    const queryProduct = options.query_product || queryUuzuhaoProductByAccount;
    const modifyPrice = options.modify_price || modifyUuzuhaoProductPrice;
    const batchId = String(input.batch_id || buildPublishBatchId(uid, 'uuzuhao-ladder')).trim();
    const triggerSource = String(input.trigger_source || 'price_ladder').trim();
    const forcePublish = input.force_publish === true;
    const startedAt = nowText();
    let batchCreated = false;
    let beforeProduct = null;
    let afterProduct = null;
    let modifyOutput = null;
    let readbackAttempts = 0;
    let failureStage = 'authorization';
    const ensureBatch = async () => {
        if (batchCreated) return;
        await createPricePublishBatchLog({
            batch_id: batchId,
            user_id: uid,
            channel: 'uuzuhao',
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
            desc: 'publish account price ladder to uuzuhao'
        });
        batchCreated = true;
    };

    try {
        const auth = options.auth || await getUuzuhaoAuthPayloadByUser(uid);
        failureStage = 'query_before';
        beforeProduct = await queryProduct(gameAccount, {
            auth,
            product_id: goodsId,
            game_id: gameId,
            game_name: gameName
        });
        if (!beforeProduct) throw new Error('悠悠租号未找到对应商品');
        const beforePrices = pickUuzuhaoProductPriceSet(beforeProduct);
        if (!forcePublish && beforePrices.hour === targetPrices.hour) {
            return {
                ok: true,
                changed: false,
                batch_id: '',
                goods_id: goodsId,
                prices: { hour: beforePrices.hour },
                verification_status: 'partial',
                reason: 'hour_price_already_matches'
            };
        }

        await ensureBatch();
        failureStage = 'modify';
        const modifyInput = {
            hourPrice: targetPrices.hour,
            p2Price: targetPrices.p2,
            p3Price: targetPrices.p3,
            p5Price: targetPrices.p5,
            p7Price: targetPrices.p7,
            p9Price: targetPrices.p9,
            p10Price: targetPrices.p10,
            p24Price: targetPrices.p24,
            p168Price: targetPrices.p168
        };
        if (beforePrices.min_rent_hour > 0) modifyInput.minRentHour = beforePrices.min_rent_hour;
        modifyOutput = await modifyPrice(goodsId, modifyInput, { auth });
        failureStage = 'query_after';
        const readback = await queryUuzuhaoProductUntilMatched(queryProduct, gameAccount, {
            auth,
            product_id: goodsId,
            game_id: gameId,
            game_name: gameName
        }, targetPrices.hour, options);
        readbackAttempts = readback.attempts;
        afterProduct = readback.product;
        if (!afterProduct) {
            if (readback.last_error) throw readback.last_error;
            throw new Error('悠悠租号改价后未找到对应商品');
        }
        const afterPrices = readback.prices;
        failureStage = 'verify_after';
        if (!readback.matched) {
            throw new Error(`悠悠租号时租价回读不一致: target=${targetPrices.hour} actual=${afterPrices.hour} attempts=${readbackAttempts}`);
        }

        await upsertUserGameAccount({
            user_id: uid,
            game_account: gameAccount,
            game_id: gameId,
            game_name: gameName,
            account_remark: String(row.account_remark || '').trim(),
            channel_prd_info: {
                uuzuhao: {
                    ...info,
                    hourPrice: afterPrices.hour,
                    minRentHour: afterPrices.min_rent_hour || beforePrices.min_rent_hour || 0
                }
            },
            desc: 'publish account price ladder to uuzuhao'
        });
        await createPricePublishItemLog({
            batch_id: batchId,
            user_id: uid,
            channel: 'uuzuhao',
            game_name: gameName,
            game_account: gameAccount,
            goods_id: goodsId,
            publish_status: 'success',
            before_data: sanitizePriceLogPayload({ product: beforeProduct, prices: { hour: beforePrices.hour } }),
            request_data: sanitizePriceLogPayload({
                target_prices: targetPrices,
                min_rent_hour: modifyInput.minRentHour || null
            }),
            response_data: sanitizePriceLogPayload({
                stage: 'verified',
                verification_status: 'partial',
                readback_attempts: readbackAttempts,
                channel_response: modifyOutput && modifyOutput.raw
            }),
            after_data: sanitizePriceLogPayload({
                product: afterProduct,
                prices: { hour: afterPrices.hour },
                readback_attempts: readbackAttempts,
                verification_status: 'partial'
            }),
            price_before_hour: beforePrices.hour,
            price_target_hour: targetPrices.hour,
            price_after_hour: afterPrices.hour,
            start_time: startedAt,
            end_time: nowText(),
            desc: 'publish account price ladder item to uuzuhao'
        });
        await updatePricePublishBatchLog(batchId, {
            total_count: 1,
            success_count: 1,
            fail_count: 0,
            status: 'success',
            end_time: nowText(),
            desc: 'publish account price ladder to uuzuhao completed'
        });
        return {
            ok: true,
            changed: true,
            batch_id: batchId,
            goods_id: goodsId,
            prices: targetPrices,
            verification_status: 'partial'
        };
    } catch (error) {
        const message = String(error && error.message ? error.message : error);
        await ensureBatch();
        const beforePrices = pickUuzuhaoProductPriceSet(beforeProduct);
        const afterPrices = pickUuzuhaoProductPriceSet(afterProduct);
        const errorDetail = sanitizePriceLogPayload({
            stage: failureStage,
            code: String(error && error.code || '').trim(),
            message,
            readback_attempts: readbackAttempts,
            channel_response: error && error.uuzuhao_response
                ? error.uuzuhao_response
                : (modifyOutput && modifyOutput.raw || null)
        });
        await createPricePublishItemLog({
            batch_id: batchId,
            user_id: uid,
            channel: 'uuzuhao',
            game_name: gameName,
            game_account: gameAccount,
            goods_id: goodsId,
            publish_status: 'fail',
            fail_message: message,
            before_data: sanitizePriceLogPayload(beforeProduct ? { product: beforeProduct, prices: { hour: beforePrices.hour } } : null),
            request_data: sanitizePriceLogPayload({ target_prices: targetPrices }),
            response_data: errorDetail,
            after_data: sanitizePriceLogPayload(afterProduct ? { product: afterProduct, prices: { hour: afterPrices.hour } } : null),
            price_before_hour: beforePrices.hour,
            price_target_hour: targetPrices.hour,
            price_after_hour: afterPrices.hour,
            start_time: startedAt,
            end_time: nowText(),
            desc: 'publish account price ladder item to uuzuhao failed'
        });
        await updatePricePublishBatchLog(batchId, {
            total_count: 1,
            success_count: 0,
            fail_count: 1,
            status: 'fail',
            end_time: nowText(),
            desc: 'publish account price ladder to uuzuhao failed'
        });
        return {
            ok: false,
            changed: false,
            batch_id: batchId,
            goods_id: goodsId,
            message,
            error_detail: errorDetail
        };
    }
}

async function publishZuhaowangAccountPriceSetByUser(userId, input = {}, options = {}) {
    const uid = Number(userId || 0);
    if (!uid) throw new Error('user_id 不合法');
    const gameId = String(input.game_id || '').trim();
    const gameName = String(input.game_name || '').trim();
    const gameAccount = String(input.game_account || '').trim();
    if (!gameId || !gameName || !gameAccount) throw new Error('调价账号信息不完整');
    const targetPrices = normalizeZuhaowangTargetPriceSet(input.prices || {});
    const accountRows = await listAllAccountsByUser(uid);
    const row = accountRows.find((item) => (
        String(item.game_id || '').trim() === gameId
        && String(item.game_account || '').trim() === gameAccount
    ));
    if (!row) throw new Error('调价账号不存在');
    const info = row.channel_prd_info && row.channel_prd_info.zuhaowang && typeof row.channel_prd_info.zuhaowang === 'object'
        ? row.channel_prd_info.zuhaowang
        : {};

    const getTemplate = options.get_template || getZuhaowangPriceTemplate;
    const changeTemplate = options.change_template || changeZuhaowangPriceTemplate;
    const resolveDataId = options.resolve_data_id || resolveDataIdByAccountAndGame;
    const batchId = String(input.batch_id || buildPublishBatchId(uid, 'zuhaowang-ladder')).trim();
    const triggerSource = String(input.trigger_source || 'price_ladder').trim();
    const forcePublish = input.force_publish === true;
    const startedAt = nowText();
    let batchCreated = false;
    let goodsId = String(input.goods_id || info.prd_id || info.data_id || '').trim();
    let beforeTemplate = null;
    let beforeNormalized = null;
    let afterTemplate = null;
    let afterNormalized = null;
    let requestParams = null;
    let modifyOutput = null;
    let failureStage = 'authorization';
    const ensureBatch = async () => {
        if (batchCreated) return;
        await createPricePublishBatchLog({
            batch_id: batchId,
            user_id: uid,
            channel: 'zuhaowang',
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
            desc: 'publish account price ladder to zuhaowang'
        });
        batchCreated = true;
    };

    try {
        const auth = options.auth || await getZuhaowangAuthPayloadByUser(uid);
        const channelGameId = Number(info.game_id || input.channel_game_id || 0);
        if (!goodsId) {
            failureStage = 'resolve_data_id';
            goodsId = String(await resolveDataId(gameAccount, channelGameId, auth) || '').trim();
        }
        if (!goodsId) throw new Error('缺少 租号王 dataId');

        failureStage = 'query_before';
        try {
            beforeTemplate = await getTemplate(goodsId, auth, { user_id: uid });
        } catch (firstError) {
            failureStage = 'refresh_data_id';
            const refreshedId = String(await resolveDataId(gameAccount, channelGameId, auth) || '').trim();
            if (!refreshedId || refreshedId === goodsId) throw firstError;
            goodsId = refreshedId;
            failureStage = 'query_before';
            beforeTemplate = await getTemplate(goodsId, auth, { user_id: uid });
        }
        beforeNormalized = normalizeZuhaowangTemplate(beforeTemplate);
        if (!forcePublish && sameZuhaowangActivePriceSet(targetPrices, beforeNormalized.prices, beforeNormalized.rent_mode)) {
            return {
                ok: true,
                changed: false,
                batch_id: '',
                goods_id: goodsId,
                prices: beforeNormalized.prices,
                rent_mode: beforeNormalized.rent_mode,
                reason: 'already_matches'
            };
        }

        await ensureBatch();
        requestParams = buildZuhaowangChangePriceParams(goodsId, beforeNormalized, targetPrices);
        failureStage = 'modify';
        let modifyError = null;
        try {
            modifyOutput = await changeTemplate(requestParams, auth, { user_id: uid });
        } catch (error) {
            modifyError = error;
        }
        failureStage = 'query_after';
        afterTemplate = await getTemplate(goodsId, auth, { user_id: uid });
        afterNormalized = normalizeZuhaowangTemplate(afterTemplate);
        failureStage = 'verify_after';
        if (!sameZuhaowangActivePriceSet(targetPrices, afterNormalized.prices, beforeNormalized.rent_mode)) {
            if (modifyError) throw modifyError;
            throw new Error(`租号王价格回读不一致: target=${JSON.stringify(targetPrices)} actual=${JSON.stringify(afterNormalized.prices)}`);
        }

        await upsertUserGameAccount({
            user_id: uid,
            game_account: gameAccount,
            game_id: gameId,
            game_name: gameName,
            account_remark: String(row.account_remark || '').trim(),
            channel_prd_info: {
                zuhaowang: {
                    ...info,
                    prd_id: goodsId,
                    rent_mode: afterNormalized.rent_mode,
                    price_template_type: String(afterNormalized.account_info.priceTemplateType ?? ''),
                    hourPrice: afterNormalized.prices.hour,
                    p24Price: afterNormalized.prices.p24,
                    p72Price: afterNormalized.prices.p72,
                    p168Price: afterNormalized.prices.p168
                }
            },
            desc: 'publish account price ladder to zuhaowang'
        });
        await createPricePublishItemLog({
            batch_id: batchId,
            user_id: uid,
            channel: 'zuhaowang',
            game_name: gameName,
            game_account: gameAccount,
            goods_id: goodsId,
            publish_status: 'success',
            before_data: sanitizePriceLogPayload({
                template: beforeTemplate,
                prices: beforeNormalized.prices,
                rent_mode: beforeNormalized.rent_mode
            }),
            request_data: sanitizePriceLogPayload({
                biz_params: requestParams,
                target_prices: targetPrices,
                rent_mode: beforeNormalized.rent_mode
            }),
            response_data: sanitizePriceLogPayload({
                stage: 'verified',
                verification_status: 'full',
                channel_response: modifyOutput,
                recovered_after_modify_error: Boolean(modifyError)
            }),
            after_data: sanitizePriceLogPayload({
                template: afterTemplate,
                prices: afterNormalized.prices,
                rent_mode: afterNormalized.rent_mode
            }),
            price_before_hour: beforeNormalized.prices.hour,
            price_before_day: beforeNormalized.prices.p24,
            price_target_hour: beforeNormalized.short_open ? targetPrices.hour : 0,
            price_target_day: targetPrices.p24,
            price_after_hour: afterNormalized.prices.hour,
            price_after_day: afterNormalized.prices.p24,
            start_time: startedAt,
            end_time: nowText(),
            desc: 'publish account price ladder item to zuhaowang'
        });
        await updatePricePublishBatchLog(batchId, {
            total_count: 1,
            success_count: 1,
            fail_count: 0,
            status: 'success',
            end_time: nowText(),
            desc: 'publish account price ladder to zuhaowang completed'
        });
        return {
            ok: true,
            changed: true,
            batch_id: batchId,
            goods_id: goodsId,
            prices: afterNormalized.prices,
            rent_mode: afterNormalized.rent_mode,
            recovered_after_modify_error: Boolean(modifyError)
        };
    } catch (error) {
        const message = String(error && error.message ? error.message : error);
        await ensureBatch();
        const errorDetail = sanitizePriceLogPayload({
            stage: failureStage,
            code: String(error && error.code || '').trim(),
            message,
            channel_response: error && error.zuhaowang_response ? error.zuhaowang_response : null
        });
        await createPricePublishItemLog({
            batch_id: batchId,
            user_id: uid,
            channel: 'zuhaowang',
            game_name: gameName,
            game_account: gameAccount,
            goods_id: goodsId,
            publish_status: 'fail',
            fail_message: message,
            before_data: sanitizePriceLogPayload(beforeNormalized ? {
                template: beforeTemplate,
                prices: beforeNormalized.prices,
                rent_mode: beforeNormalized.rent_mode
            } : beforeTemplate),
            request_data: sanitizePriceLogPayload({ biz_params: requestParams, target_prices: targetPrices }),
            response_data: errorDetail,
            after_data: sanitizePriceLogPayload(afterNormalized ? {
                template: afterTemplate,
                prices: afterNormalized.prices,
                rent_mode: afterNormalized.rent_mode
            } : afterTemplate),
            price_before_hour: Number(beforeNormalized && beforeNormalized.prices.hour || 0),
            price_before_day: Number(beforeNormalized && beforeNormalized.prices.p24 || 0),
            price_target_hour: Number(beforeNormalized && beforeNormalized.short_open ? targetPrices.hour : 0),
            price_target_day: targetPrices.p24,
            price_after_hour: Number(afterNormalized && afterNormalized.prices.hour || 0),
            price_after_day: Number(afterNormalized && afterNormalized.prices.p24 || 0),
            start_time: startedAt,
            end_time: nowText(),
            desc: 'publish account price ladder item to zuhaowang failed'
        });
        await updatePricePublishBatchLog(batchId, {
            total_count: 1,
            success_count: 0,
            fail_count: 1,
            status: 'fail',
            end_time: nowText(),
            desc: 'publish account price ladder to zuhaowang failed'
        });
        return { ok: false, changed: false, batch_id: batchId, goods_id: goodsId, message, error_detail: errorDetail };
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
    publishUuzuhaoAccountPriceSetByUser,
    publishZuhaowangAccountPriceSetByUser,
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
        pickUuzuhaoProductPriceSet,
        normalizeUuzuhaoTargetPriceSet,
        normalizeUuzuhaoReadbackDelays,
        queryUuzuhaoProductUntilMatched,
        sleep,
        getUhaozuAuthPayloadByUser,
        getUuzuhaoAuthPayloadByUser,
        getZuhaowangAuthPayloadByUser,
        normalizeZuhaowangTemplate,
        normalizeZuhaowangTargetPriceSet,
        buildZuhaowangChangePriceParams,
        sameZuhaowangActivePriceSet
    }
};
