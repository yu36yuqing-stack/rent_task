'use strict';

const DAY = 86400000;
const keyOf = row => JSON.stringify([row.game_name, row.game_account]);
const dayOf = text => Date.parse(String(text || '').slice(0, 10) + 'T00:00:00Z') / DAY;
const divide = (a, b) => b > 0 ? a / b : null;

function receipt(row) {
    if (row.detail_net != null && row.detail_net === row.rec_amount) return row.detail_net;
    const marker = /\[receipt:([^\]]+)\]$/.exec(row.desc || '');
    if (marker) return /^\d+(\.\d+)?$/.test(marker[1]) ? Number(marker[1]) : null;
    if (row.source_amount != null && String(row.source_amount).trim() !== '') return Number(row.source_amount);
    return row.rec_amount > 0 ? row.rec_amount : null;
}

function occupiedHours(row) {
    const duration = /^(?:(\d+)小时)?(?:(\d+)分钟)?(?:(\d+)秒)?$/.exec(row.rent_duration || '');
    if (duration && duration[0]) return Number(duration[1] || 0) + Number(duration[2] || 0) / 60 + Number(duration[3] || 0) / 3600;
    const elapsed = end => (Date.parse(String(end).replace(' ', 'T') + '+08:00') -
        Date.parse(String(row.start_time).replace(' ', 'T') + '+08:00')) / 3600000;
    const full = elapsed(row.end_time);
    if (row.channel === 'uhaozu' && row.complete_time && ['部分完成','已完成'].includes(row.order_status)) {
        const completed = elapsed(row.complete_time);
        if (completed >= 0 && full >= 0) return Math.min(completed, full);
    }
    // Refunds, partial completions and zero-income orders may have ended early.
    if (row.order_status !== '已完成' || !(receipt(row) > 0) || !(full > 0)) return null;
    if (row.channel === 'zuhaowang' && row.ren_way === '包天') return full;
    return row.rent_hour > 0 ? Math.min(row.rent_hour, full) : null;
}

function orderTotals(orders) {
    const counts = { paid: 0, cancelled: 0, unknown: 0, timed: 0, timedPaid: 0, missingHours: 0, missingTurnover: 0,
        income: 0, hours: 0, paidHours: 0, settledHours: 0, timedIncome: 0 };
    for (const row of orders) {
        const hours = occupiedHours(row);
        if (hours == null) {
            counts.missingHours++;
        } else {
            counts.hours += hours;
            counts.timed++;
        }
        const amount = receipt(row);
        if (amount != null && amount >= 0 && hours != null) counts.settledHours += hours;
        if (amount === 0) {
            counts.cancelled++;
        } else if (amount > 0) {
            counts.paid++;
            counts.income += amount;
            if (hours != null) {
                counts.paidHours += hours;
                counts.timedIncome += amount;
                counts.timedPaid++;
            } else {
                counts.missingTurnover++;
            }
        } else {
            counts.unknown++;
            if (hours !== 0) counts.missingTurnover++;
        }
    }
    return counts;
}

function groupByAsset(rows) {
    const map = new Map();
    for (const row of rows) {
        const key = keyOf(row);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(row);
    }
    return map;
}

function dailyTotals(days = 0) {
    return { days, income: 0, paid: 0, effectiveOrders: 0, rentHours: 0 };
}

function mergeDailyTotals(total, asset) {
    // All operating intervals end on the selected end date, so their union is the longest interval.
    total.days = Math.max(total.days, asset.days);
    total.income += asset.income;
    total.paid += asset.paid;
    total.effectiveOrders += asset.effectiveOrders;
    total.rentHours += asset.rentHours;
}

function dailyAverages(total = dailyTotals()) {
    const average = value => total.days ? Number((value / total.days).toFixed(4)) : null;
    return {
        operating_days: total.days,
        avg_daily_rec: average(total.income),
        avg_daily_order_cnt: average(total.effectiveOrders),
        avg_daily_rent_hour: average(total.rentHours),
        settled_daily_count: divide(total.paid, total.days)
    };
}

function dashboardMetrics(assets, orders, costs, range, historicalRent, accountHolding = new Map(), incomeRows = []) {
    const start = dayOf(range.startDate), end = dayOf(range.endDate);
    const ordersByAsset = groupByAsset(orders), costsByAsset = groupByAsset(costs);
    const dailyIncomeByAsset = groupByAsset(incomeRows);
    const totals = orderTotals(orders);
    let heldDays = 0, heldCount = 0, rentedCount = 0, costDays = 0, comparableIncome = 0;
    let totalCost = 0, sale = 0, missingCost = 0, missingHolding = 0;
    let heldHours = 0, heldTimed = 0, missingHeldHours = 0, operatingAssetDays = 0;
    const operating = dailyTotals();
    for (const asset of assets) {
        const key = keyOf(asset);
        const rows = ordersByAsset.get(key) || [];
        const purchase = dayOf(asset.purchase_date);
        const sold = asset.asset_status === 'sold';
        const last = sold ? Math.min(end, dayOf(asset.sold_at)) : end;
        const first = Math.max(start, purchase);
        const held = Math.max(0, last - first + 1);
        const records = costsByAsset.get(key) || [];
        const hasPurchaseRecord = records.some(r => r.cost_type === 'purchase');
        const cost = Number(asset.total_cost_amount || asset.purchase_price || 0);
        totalCost += cost;
        if (!cost && !hasPurchaseRecord && !asset.cost_configured) missingCost++;
        if (sold) sale += Number(asset.sold_price || 0);
        if (!Number.isFinite(held) || (asset.inactive && !sold)) missingHolding++;
        else if (held > 0) {
            const operatingOrders = rows.filter(r => dayOf(r.end_time) >= first && dayOf(r.end_time) <= end);
            const inHolding = last === end ? operatingOrders : operatingOrders.filter(r => dayOf(r.end_time) <= last);
            const part = orderTotals(inHolding);
            const sample = dailyTotals(end - first + 1);
            sample.paid = last === end ? part.paid : operatingOrders.filter(r => receipt(r) > 0).length;
            let periodIncome = 0;
            for (const r of dailyIncomeByAsset.get(key) || []) {
                const day = dayOf(r.stat_date);
                if (!(day >= first && day <= end)) continue;
                const income = Number(r.amount_rec_sum || 0);
                sample.income += income;
                sample.effectiveOrders += Number(r.order_cnt_effective || 0);
                sample.rentHours += Number(r.rent_hour_sum || 0);
                if (day <= last) periodIncome += income;
            }
            const detail = accountHolding.get(asset.game_account) || { days: 0, hours: 0, timed: 0, missing: 0, daily: dailyTotals() };
            mergeDailyTotals(detail.daily, sample);
            mergeDailyTotals(operating, sample);
            operatingAssetDays += sample.days;
            detail.days += held;
            const knownTurnover = inHolding.length - part.missingTurnover;
            detail.hours += part.paidHours;
            detail.timed += knownTurnover;
            detail.missing += part.missingTurnover;
            accountHolding.set(asset.game_account, detail);
            heldDays += held;
            heldCount++;
            rentedCount += Number(part.paid > 0);
            heldHours += part.paidHours;
            heldTimed += knownTurnover;
            missingHeldHours += part.missingTurnover;
            if (cost > 0) {
                let investedDays = 0;
                if (!hasPurchaseRecord) investedDays += Number(asset.purchase_price || 0) * held;
                for (const r of records) {
                    investedDays += Number(r.cost_amount) * Math.max(0, last - Math.max(first, dayOf(r.cost_date)) + 1);
                }
                if (investedDays > 0) {
                    costDays += investedDays;
                    comparableIncome += periodIncome;
                }
            }
        }
    }
    const currentAssets = new Set(assets.map(keyOf));
    for (const key of ordersByAsset.keys()) {
        if (!currentAssets.has(key)) missingHolding++;
    }
    const hoursPerDay = missingHeldHours && !heldTimed ? null : divide(heldHours, heldDays);
    const averages = dailyAverages(operating);
    return {
        daily_averages: averages,
        cumulative_cost: totalCost,
        sale_amount: sale,
        payback: missingCost ? null : divide(historicalRent + sale, totalCost),
        income_per_asset_day: divide(operating.income, operatingAssetDays),
        annual_rent_return: divide(comparableIncome * 365, costDays),
        paid_orders: totals.paid,
        paid_orders_per_day: averages.settled_daily_count,
        income_per_order: divide(totals.income, totals.paid),
        hours_per_paid_order: divide(totals.paidHours, totals.timedPaid),
        rented_asset_rate: divide(rentedCount, heldCount),
        turnover_hours: hoursPerDay,
        turnover_rate: hoursPerDay == null ? null : hoursPerDay / 24,
        hourly_income: divide(totals.timedIncome, totals.settledHours),
        cancelled: totals.cancelled,
        cancellation_rate: divide(totals.cancelled, totals.cancelled + totals.paid),
        unknown_receipts: totals.unknown,
        missing_hours: totals.paid - totals.timedPaid,
        missing_held_hours: missingHeldHours,
        missing_holding: missingHolding,
        missing_cost: missingCost,
        held_days: heldDays
    };
}
function accountOperatingMetrics(assets, orders, costs, range, historicalTotals, incomeRows) {
    const group = rows => {
        const grouped = new Map();
        for (const row of rows) {
            if (!grouped.has(row.game_account)) grouped.set(row.game_account, []);
            grouped.get(row.game_account).push(row);
        }
        return grouped;
    };
    const assetsByAccount = group(assets), ordersByAccount = group(orders);
    const costsByAccount = group(costs), incomeByAccount = group(incomeRows);
    const result = new Map();
    for (const [account, scopedAssets] of assetsByAccount) {
        const { daily_averages, ...metrics } = dashboardMetrics(
            scopedAssets, ordersByAccount.get(account) || [], costsByAccount.get(account) || [],
            range, historicalTotals.get(account) || 0, new Map(), incomeByAccount.get(account) || []
        );
        result.set(account, metrics);
    }
    return result;
}

module.exports = { dashboardMetrics, dailyAverages, orderTotals, accountOperatingMetrics };
