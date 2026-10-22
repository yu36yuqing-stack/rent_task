(function (root) {
  'use strict';

  function render(item, options) {
    const product = item || {};
    const soldView = Boolean(options && options.soldView);
    const purchasePrice = Number(product.purchase_price);
    const purchaseDate = String(product.purchase_date || '').slice(0, 10);
    const totalCost = Number(product.total_cost_amount || 0);
    const hasPurchase = Number.isFinite(purchasePrice) && purchasePrice > 0
      && /^\d{4}-\d{2}-\d{2}$/.test(purchaseDate);
    const hasCost = Number.isFinite(totalCost) && totalCost > 0;
    if (soldView && !hasPurchase && !hasCost) return '';
    const lines = [];
    if (hasPurchase) {
      lines.push(`<span class="purchase-brief-line">采购价 ¥${purchasePrice.toFixed(2)}</span>`);
      lines.push(`<span class="purchase-brief-line">采购日期 ${purchaseDate}</span>`);
    }
    if (soldView) {
      if (hasCost && (!Number.isFinite(purchasePrice) || purchasePrice <= 0 || Math.abs(totalCost - purchasePrice) >= 0.01)) {
        lines.push(`<span class="purchase-brief-line">总成本 ¥${totalCost.toFixed(2)}</span>`);
      }
    } else {
      const income = product.rental_income;
      const hasIncome = income && income.status === 'ready' && typeof income.amount === 'number'
        && Number.isFinite(income.amount);
      lines.push(`<span class="purchase-brief-line" data-slot="total-cost">总成本 ${hasCost ? `¥${totalCost.toFixed(2)}` : '--'}</span>`);
      lines.push(`<span class="purchase-brief-line" data-slot="rental-income">累计租金 ${hasIncome ? `¥${income.amount.toFixed(2)}` : '--'}</span>`);
    }
    return `<div class="purchase-brief${soldView ? '' : ' product-income-brief'}">${lines.join('')}</div>`;
  }

  root.ProductIncomeSummary = Object.freeze({ render });
})(window);
