'use strict';

/**
 * U号租定价器（回本周期模式）
 *
 * 适用场景：
 * - 你先定义“希望多少天回本”
 * - 再定义“客观上平均每天能出租多少小时”
 * - 最后根据平台手续费，反推 U号租应该挂多少时租
 *
 * 当前口径：
 * - 平台手续费：20%
 * - 提现手续费：2%
 * - 到手比例：0.8 * 0.98 = 0.784
 *
 * 说明：
 * - 这里先只做“回本周期模式”，不接主逻辑。
 * - 后续如果要做“收益优先模式”，建议平行新增另一组 API，
 *   不要把两种模式硬塞进同一个入口里。
 */

const DEFAULT_UHAOZU_PRICING_CONFIG = Object.freeze({
    payback_days: 210,
    avg_daily_rent_hours: 3.5,
    platform_fee_rate: 0.20,
    withdrawal_fee_rate: 0.02,
    price_step: 0.5,
    deposit: 100
});

function toPositiveNumber(value, fieldName) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`${fieldName} 必须是大于 0 的数字`);
    }
    return n;
}

function toNonNegativeNumber(value, fieldName) {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
        throw new Error(`${fieldName} 必须是大于等于 0 的数字`);
    }
    return n;
}

function roundTo(value, digits = 2) {
    const n = Number(value);
    if (!Number.isFinite(n)) return value;
    return Number(n.toFixed(digits));
}

function ceilToStep(value, step = 0.5) {
    const n = Number(value);
    const unit = Number(step);
    if (!Number.isFinite(n)) return value;
    if (!Number.isFinite(unit) || unit <= 0) return roundTo(n, 2);
    return roundTo(Math.ceil(n / unit) * unit, 2);
}

function resolveNetRatio(config = {}) {
    const platformFeeRate = toNonNegativeNumber(config.platform_fee_rate, 'platform_fee_rate');
    const withdrawalFeeRate = toNonNegativeNumber(config.withdrawal_fee_rate, 'withdrawal_fee_rate');
    if (platformFeeRate >= 1) throw new Error('platform_fee_rate 必须小于 1');
    if (withdrawalFeeRate >= 1) throw new Error('withdrawal_fee_rate 必须小于 1');
    return (1 - platformFeeRate) * (1 - withdrawalFeeRate);
}

/**
 * 计算单个账号在 U号租的“回本周期模式”价格。
 *
 * 输入示例：
 * calculateUhaozuPaybackPeriodPrice({
 *   total_cost_amount: 3917.34,
 *   payback_days: 210,
 *   avg_daily_rent_hours: 3.5
 * })
 */
function calculateUhaozuPaybackPeriodPrice(input = {}, overrides = {}) {
    const merged = {
        ...DEFAULT_UHAOZU_PRICING_CONFIG,
        ...(input && typeof input === 'object' ? input : {}),
        ...(overrides && typeof overrides === 'object' ? overrides : {})
    };

    const totalCostAmount = toPositiveNumber(merged.total_cost_amount, 'total_cost_amount');
    const paybackDays = toPositiveNumber(merged.payback_days, 'payback_days');
    const avgDailyRentHours = toPositiveNumber(merged.avg_daily_rent_hours, 'avg_daily_rent_hours');
    const priceStep = toPositiveNumber(merged.price_step, 'price_step');
    const netRatio = resolveNetRatio(merged);
    if (netRatio <= 0) throw new Error('净到手比例必须大于 0');

    const targetDailyNetIncome = totalCostAmount / paybackDays;
    const targetNetHourlyPrice = targetDailyNetIncome / avgDailyRentHours;
    const targetListingHourlyPrice = targetNetHourlyPrice / netRatio;

    return {
        mode: 'payback_period',
        channel: 'uhaozu',
        input: {
            total_cost_amount: roundTo(totalCostAmount, 2),
            payback_days: roundTo(paybackDays, 2),
            avg_daily_rent_hours: roundTo(avgDailyRentHours, 2),
            platform_fee_rate: roundTo(Number(merged.platform_fee_rate), 4),
            withdrawal_fee_rate: roundTo(Number(merged.withdrawal_fee_rate), 4),
            price_step: roundTo(priceStep, 2),
            deposit: roundTo(toNonNegativeNumber(merged.deposit, 'deposit'), 2)
        },
        net_ratio: roundTo(netRatio, 4),
        target_daily_net_income: roundTo(targetDailyNetIncome, 2),
        target_net_hourly_price: roundTo(targetNetHourlyPrice, 2),
        target_listing_hourly_price: roundTo(targetListingHourlyPrice, 2),
        suggested_listing_hourly_price: ceilToStep(targetListingHourlyPrice, priceStep)
    };
}

/**
 * 批量计算。
 *
 * 输入 rows 里每一项至少需要：
 * - total_cost_amount
 *
 * 可选透传：
 * - game_account / account
 * - account_remark / remark
 * - payback_days
 * - avg_daily_rent_hours
 */
function calculateBatchUhaozuPaybackPeriodPrice(rows = [], overrides = {}) {
    const list = Array.isArray(rows) ? rows : [];
    return list.map((row) => {
        const one = row && typeof row === 'object' ? row : {};
        const result = calculateUhaozuPaybackPeriodPrice(one, overrides);
        return {
            game_account: String(one.game_account || one.account || '').trim(),
            account_remark: String(one.account_remark || one.remark || '').trim(),
            ...result
        };
    });
}

module.exports = {
    DEFAULT_UHAOZU_PRICING_CONFIG,
    calculateUhaozuPaybackPeriodPrice,
    calculateBatchUhaozuPaybackPeriodPrice,
    _internals: {
        roundTo,
        ceilToStep,
        resolveNetRatio
    }
};
