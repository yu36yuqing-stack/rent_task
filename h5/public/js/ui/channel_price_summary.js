(function (root) {
  'use strict';

  function formatSuffix(summary) {
    if (!summary || typeof summary !== 'object') return '';
    const tier = Number(summary.current_tier);
    const tierText = Number.isInteger(tier) && tier >= 1 && tier <= 4 ? `${tier}档` : '未应用';
    const price = Number(summary.hour_price);
    const priceText = Number.isFinite(price) && price > 0 ? `¥${price.toFixed(2)}/时` : '--';
    return ` · ${tierText} · ${priceText}`;
  }

  root.ChannelPriceSummary = Object.freeze({ formatSuffix });
})(window);
