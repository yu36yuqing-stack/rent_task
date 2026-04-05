function normalizePricingGameName(gameName) {
  const text = String(gameName || '').trim();
  const upper = text.toUpperCase();
  if (text === '和平精英' || upper === 'HPJY') return '和平精英';
  if (text.includes('CFM') || text.includes('枪战王者') || text.includes('穿越火线') || upper === 'CFM') return 'CFM';
  return 'WZRY';
}

function buildPricingGameAvatarHtml(gameName) {
  const normalized = normalizePricingGameName(gameName);
  if (normalized === '和平精英') {
    return `<span class="game-avatar game-avatar-hpjy" title="和平精英" aria-label="和平精英">
      <img src="/assets/game_icons/hpjy.png" alt="和平精英" loading="lazy" decoding="async">
    </span>`;
  }
  if (normalized === 'CFM') {
    return `<span class="game-avatar game-avatar-cfm" title="CFM枪战王者" aria-label="CFM枪战王者">
      <img src="/assets/game_icons/cfm.png" alt="CFM枪战王者" loading="lazy" decoding="async">
    </span>`;
  }
  return `<span class="game-avatar game-avatar-wzry" title="王者荣耀" aria-label="王者荣耀">
    <img src="/assets/game_icons/wzry.webp" alt="王者荣耀" loading="lazy" decoding="async">
  </span>`;
}

function escapePricingHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatPricingPercent(value) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '-';
  return `${(n * 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

function formatPricingMoney(value, digits = 2) {
  const n = Number(value || 0);
  if (!Number.isFinite(n)) return '0';
  return n.toFixed(digits).replace(/\.?0+$/, '');
}

function pricingGameOptions() {
  return [
    { game_name: 'WZRY', label: '王者荣耀' },
    { game_name: '和平精英', label: '和平精英' },
    { game_name: 'CFM', label: 'CFM枪战王者' }
  ];
}

function isPricingPageReady() {
  return String(state.currentMenu || '').trim() === 'pricing_uhaozu'
    && normalizePricingGameName(state.pricing && state.pricing.game_name || 'WZRY') === '和平精英';
}

function bindPricingGameTabs() {
  if (!els.pricingGameTabs) return;
  Array.from(els.pricingGameTabs.querySelectorAll('.stats-game-tab')).forEach((node) => {
    node.onclick = () => {
      const gameName = String(node.getAttribute('data-pricing-game') || '').trim();
      if (!gameName || gameName === String(state.pricing.game_name || '').trim()) return;
      state.pricing.game_name = gameName;
      if (isPricingPageReady()) {
        void loadPricingView();
        return;
      }
      state.pricing.loading = false;
      state.pricing.error = '';
      state.pricing.loaded_once = true;
      state.pricing.list = [];
      state.pricing.summary = { account_count: 0, zero_cost_count: 0, total_cost_amount: 0, avg_suggested_listing_hourly_price: 0 };
      renderPricingView();
    };
  });
}

function syncPricingFormFromState() {
  const form = state.pricing && state.pricing.form ? state.pricing.form : {};
  const pairs = [
    [els.pricingPaybackDays, form.payback_days],
    [els.pricingAvgDailyRentHours, form.avg_daily_rent_hours],
    [els.pricingPlatformFeeRate, form.platform_fee_rate],
    [els.pricingWithdrawalFeeRate, form.withdrawal_fee_rate],
    [els.pricingPriceStep, form.price_step],
    [els.pricingDeposit, form.deposit]
  ];
  pairs.forEach(([node, value]) => {
    if (!node) return;
    if (document.activeElement === node) return;
    node.value = String(value == null ? '' : value);
  });
}

function buildPricingRequestQuery() {
  const pricing = state.pricing || {};
  const params = new URLSearchParams();
  params.set('game_name', String(pricing.game_name || 'WZRY'));
  return params.toString();
}

function applyPricingPayload(out) {
  const pricing = state.pricing;
  const config = out && out.config && typeof out.config === 'object' ? out.config : {};
  pricing.game_name = normalizePricingGameName(out && out.game_name || pricing.game_name || 'WZRY');
  pricing.form = {
    payback_days: Number(config.payback_days || pricing.form.payback_days || 210),
    avg_daily_rent_hours: Number(config.avg_daily_rent_hours || pricing.form.avg_daily_rent_hours || 3.5),
    platform_fee_rate: Number(config.platform_fee_rate || pricing.form.platform_fee_rate || 0.2),
    withdrawal_fee_rate: Number(config.withdrawal_fee_rate || pricing.form.withdrawal_fee_rate || 0.02),
    price_step: Number(config.price_step || pricing.form.price_step || 0.5),
    deposit: Number(config.deposit ?? pricing.form.deposit ?? 100)
  };
  pricing.summary = out && out.summary && typeof out.summary === 'object'
    ? out.summary
    : { account_count: 0, zero_cost_count: 0, total_cost_amount: 0, avg_suggested_listing_hourly_price: 0 };
  pricing.list = Array.isArray(out && out.list) ? out.list : [];
  pricing.error = '';
  pricing.loaded_once = true;
}

async function loadPricingView() {
  state.pricing.loading = true;
  state.pricing.error = '';
  renderPricingView();
  try {
    if (!isPricingPageReady()) {
      state.pricing.loaded_once = true;
      state.pricing.list = [];
      state.pricing.summary = { account_count: 0, zero_cost_count: 0, total_cost_amount: 0, avg_suggested_listing_hourly_price: 0 };
      return;
    }
    const out = await request(`/api/pricing/uhaozu?${buildPricingRequestQuery()}`);
    applyPricingPayload(out);
  } catch (e) {
    state.pricing.error = String(e && e.message || '定价数据加载失败');
  } finally {
    state.pricing.loading = false;
    renderPricingView();
  }
}

async function savePricingConfig() {
  const pricing = state.pricing || {};
  if (String(state.currentMenu || '').trim() !== 'pricing_uhaozu') return null;
  return request('/api/pricing/uhaozu/config', {
    method: 'POST',
    body: JSON.stringify({
      game_name: pricing.game_name || 'WZRY',
      payback_days: pricing.form && pricing.form.payback_days,
      avg_daily_rent_hours: pricing.form && pricing.form.avg_daily_rent_hours,
      platform_fee_rate: pricing.form && pricing.form.platform_fee_rate,
      withdrawal_fee_rate: pricing.form && pricing.form.withdrawal_fee_rate,
      price_step: pricing.form && pricing.form.price_step,
      deposit: pricing.form && pricing.form.deposit
    })
  });
}

function renderPricingCostSheet() {
  const sheet = state.pricingCostSheet || {};
  const opened = Boolean(sheet.open);
  if (!els.pricingCostSheet) return;
  els.pricingCostSheet.classList.toggle('hidden', !opened);
  if (!opened) return;
  const titleName = String(sheet.role_name || sheet.account || '').trim() || '当前账号';
  const resultText = String(sheet.result_text || '').trim();
  const resultType = String(sheet.result_type || '').trim();
  const loading = Boolean(sheet.loading);
  if (els.pricingCostSheetTitle) els.pricingCostSheetTitle.textContent = `修改定价成本 · ${titleName}`;
  if (els.pricingCostSheetResult) {
    els.pricingCostSheetResult.className = `sheet-result ${resultType}`;
    els.pricingCostSheetResult.textContent = resultText;
  }
  if (els.pricingCostAmountInput) {
    els.pricingCostAmountInput.value = String(sheet.pricing_cost_amount || '');
    els.pricingCostAmountInput.disabled = loading;
  }
  if (els.pricingBaseCostInput) {
    els.pricingBaseCostInput.value = sheet.base_cost_amount === '' ? '' : `¥${formatPricingMoney(sheet.base_cost_amount)}`;
    els.pricingBaseCostInput.disabled = true;
  }
  if (els.pricingCostNoteInput) {
    els.pricingCostNoteInput.value = String(sheet.note || '');
    els.pricingCostNoteInput.disabled = loading;
  }
  if (els.pricingCostSaveBtn) els.pricingCostSaveBtn.disabled = loading;
  if (els.pricingCostCancelBtn) els.pricingCostCancelBtn.disabled = loading;
}

function openPricingCostSheet(item = {}) {
  const account = String(item.game_account || '').trim();
  if (!account) return;
  state.pricingCostSheet = {
    open: true,
    account,
    game_name: String(item.game_name || state.pricing.game_name || 'WZRY').trim() || 'WZRY',
    role_name: String(item.role_name || item.display_name || account).trim() || account,
    pricing_cost_amount: Number(item.total_cost_amount || 0),
    base_cost_amount: Number(item.base_total_cost_amount || item.total_cost_amount || 0),
    note: '仅影响定价页，不写入商品成本',
    result_text: '',
    result_type: '',
    loading: false
  };
  renderPricingCostSheet();
}

function closePricingCostSheet() {
  state.pricingCostSheet = {
    open: false,
    account: '',
    game_name: 'WZRY',
    role_name: '',
    pricing_cost_amount: '',
    base_cost_amount: '',
    note: '',
    result_text: '',
    result_type: '',
    loading: false
  };
  renderPricingCostSheet();
}

async function submitPricingCostConfig() {
  const sheet = state.pricingCostSheet || {};
  const account = String(sheet.account || '').trim();
  const gameName = String(sheet.game_name || state.pricing.game_name || 'WZRY').trim() || 'WZRY';
  if (!account) return;
  const amount = Number(String((els.pricingCostAmountInput && els.pricingCostAmountInput.value) || sheet.pricing_cost_amount || '').trim());
  if (!Number.isFinite(amount) || amount < 0) {
    state.pricingCostSheet.result_text = '定价成本不合法';
    state.pricingCostSheet.result_type = 'err';
    renderPricingCostSheet();
    return;
  }
  state.pricingCostSheet.loading = true;
  state.pricingCostSheet.result_text = '保存中...';
  state.pricingCostSheet.result_type = '';
  state.pricingCostSheet.pricing_cost_amount = Number(amount.toFixed(2));
  renderPricingCostSheet();
  try {
    await request('/api/pricing/uhaozu/account-cost', {
      method: 'POST',
      body: JSON.stringify({
        game_name: gameName,
        game_account: account,
        total_cost_amount: Number(amount.toFixed(2))
      })
    });
    state.pricingCostSheet.result_text = '保存成功';
    state.pricingCostSheet.result_type = 'ok';
    renderPricingCostSheet();
    showToast('定价成本已保存');
    setTimeout(() => {
      closePricingCostSheet();
      void loadPricingView();
    }, 220);
  } catch (e) {
    state.pricingCostSheet.result_text = String(e && e.message || '定价成本保存失败');
    state.pricingCostSheet.result_type = 'err';
    renderPricingCostSheet();
  } finally {
    state.pricingCostSheet.loading = false;
    renderPricingCostSheet();
  }
}

async function publishPricingConfig() {
  const pricing = state.pricing || {};
  if (String(state.currentMenu || '').trim() !== 'pricing_uhaozu') return null;
  readPricingFormValues();
  state.pricing.publishing = true;
  renderPricingView();
  try {
    const out = await request('/api/pricing/uhaozu/publish', {
      method: 'POST',
      body: JSON.stringify({
        game_name: pricing.game_name || 'WZRY',
        deposit: pricing.form && pricing.form.deposit
      })
    });
    const successCount = Number(out && out.success_count || 0);
    const failCount = Number(out && out.fail_count || 0);
    showToast(failCount > 0 ? `发布完成，成功 ${successCount} 个，失败 ${failCount} 个` : `发布完成，共 ${successCount} 个`);
    await loadPricingView();
    return out;
  } finally {
    state.pricing.publishing = false;
    renderPricingView();
  }
}

function renderPricingGameTabs() {
  if (!els.pricingGameTabs) return;
  const current = normalizePricingGameName(state.pricing && state.pricing.game_name || 'WZRY');
  els.pricingGameTabs.innerHTML = pricingGameOptions().map((item) => `
    <button class="stats-game-tab ${current === item.game_name ? 'active' : ''}" data-pricing-game="${item.game_name}">
      ${buildPricingGameAvatarHtml(item.game_name)}
      <span class="stats-game-tab-text">${escapePricingHtml(item.label)}</span>
    </button>
  `).join('');
  bindPricingGameTabs();
}

function renderPricingMetricGrid() {
  if (!els.pricingMetricGrid) return;
  els.pricingMetricGrid.innerHTML = '';
}

function closePricingFormulaHelp() {
  if (!els.pricingFormulaHelp) return;
  els.pricingFormulaHelp.classList.add('hidden');
}

function togglePricingFormulaHelp() {
  if (!els.pricingFormulaHelp) return;
  const opened = !els.pricingFormulaHelp.classList.contains('hidden');
  els.pricingFormulaHelp.classList.toggle('hidden', opened);
}

function renderPricingList() {
  if (!els.pricingListContainer) return;
  const pricing = state.pricing || {};
  if (String(state.currentMenu || '').trim() === 'pricing_uuzuhao' || String(state.currentMenu || '').trim() === 'pricing_zuhaowang') {
    els.pricingListContainer.innerHTML = '<div class="panel pricing-empty-card">该渠道定价页开发中。</div>';
    return;
  }
  if (normalizePricingGameName(pricing.game_name || 'WZRY') !== '和平精英') {
    els.pricingListContainer.innerHTML = '<div class="panel pricing-empty-card">该游戏定价规则待开发。</div>';
    return;
  }
  if (pricing.loading && !pricing.loaded_once) {
    els.pricingListContainer.innerHTML = '<div class="panel pricing-empty-card">加载中...</div>';
    return;
  }
  if (pricing.error) {
    els.pricingListContainer.innerHTML = `<div class="panel pricing-empty-card pricing-error">${escapePricingHtml(pricing.error)}</div>`;
    return;
  }
  const list = Array.isArray(pricing.list) ? pricing.list : [];
  if (list.length === 0) {
    els.pricingListContainer.innerHTML = '<div class="panel pricing-empty-card">当前游戏暂无可计算账号。</div>';
    return;
  }
  els.pricingListContainer.innerHTML = list.map((item) => `
    <div class="panel pricing-account-card">
      <div class="pricing-account-head">
        <div>
          <p class="pricing-account-name">${escapePricingHtml(item.display_name || item.role_name || item.game_account || '-')}</p>
          <p class="pricing-account-meta">${escapePricingHtml(item.game_account || '-')} · 定价成本 ¥${formatPricingMoney(item.total_cost_amount)}${item.pricing_cost_overridden ? ` · 商品成本 ¥${formatPricingMoney(item.base_total_cost_amount)}` : ''}</p>
        </div>
        <div class="pricing-account-actions">
          <button
            class="btn btn-ghost btn-card-action"
            type="button"
            data-pricing-cost-account="${escapePricingHtml(item.game_account || '')}"
            data-pricing-cost-game="${escapePricingHtml(item.game_name || '')}"
            data-pricing-cost-role="${escapePricingHtml(item.role_name || item.display_name || item.game_account || '')}"
            data-pricing-cost-amount="${escapePricingHtml(item.total_cost_amount || 0)}"
            data-pricing-base-cost-amount="${escapePricingHtml(item.base_total_cost_amount || item.total_cost_amount || 0)}"
          >修改定价成本</button>
          <span class="btn btn-ghost btn-card-action pricing-price-pill">建议挂价 ¥${formatPricingMoney(item.suggested_listing_hourly_price)}</span>
        </div>
      </div>
      <div class="pricing-account-grid">
        <div class="pricing-account-metric">
          <span class="pricing-account-metric-label">目标到手时租</span>
          <strong>¥${formatPricingMoney(item.target_net_hourly_price)}</strong>
        </div>
        <div class="pricing-account-metric">
          <span class="pricing-account-metric-label">理论挂价</span>
          <strong>¥${formatPricingMoney(item.target_listing_hourly_price)}</strong>
        </div>
        <div class="pricing-account-metric">
          <span class="pricing-account-metric-label">当前U号租时租</span>
          <strong>${Number(item.current_listing_hourly_price || 0) > 0 ? `¥${formatPricingMoney(item.current_listing_hourly_price)}` : '未取到'}</strong>
        </div>
        <div class="pricing-account-metric">
          <span class="pricing-account-metric-label">日均到手目标</span>
          <strong>¥${formatPricingMoney(item.target_daily_net_income)}</strong>
        </div>
      </div>
    </div>
  `).join('');
  Array.from(els.pricingListContainer.querySelectorAll('[data-pricing-cost-account]')).forEach((node) => {
    node.onclick = async () => {
      const account = String(node.getAttribute('data-pricing-cost-account') || '').trim();
      if (!account) return;
      const gameName = String(node.getAttribute('data-pricing-cost-game') || 'WZRY').trim() || 'WZRY';
      const roleName = String(node.getAttribute('data-pricing-cost-role') || account).trim() || account;
      const totalCostAmount = Number(node.getAttribute('data-pricing-cost-amount') || 0);
      const baseTotalCostAmount = Number(node.getAttribute('data-pricing-base-cost-amount') || totalCostAmount || 0);
      openPricingCostSheet({
        game_account: account,
        game_name: gameName,
        role_name: roleName,
        total_cost_amount: totalCostAmount,
        base_total_cost_amount: baseTotalCostAmount
      });
    };
  });
}

function renderPricingView() {
  if (!els.pricingView) return;
  const pricing = state.pricing || {};
  renderPricingGameTabs();
  syncPricingFormFromState();
  renderPricingCostSheet();
  const showConfig = isPricingPageReady();
  if (els.pricingCalcBtn) {
    const wrap = els.pricingCalcBtn.closest('.pricing-config-card');
    if (wrap) wrap.classList.toggle('pricing-config-disabled', !showConfig);
  }
  const configCard = document.querySelector('#pricingView .pricing-config-card');
  if (configCard) configCard.classList.toggle('pricing-config-disabled', !showConfig);
  if (els.pricingCalcBtn) {
    els.pricingCalcBtn.disabled = Boolean(pricing.loading) || Boolean(pricing.publishing) || !showConfig;
    els.pricingCalcBtn.textContent = pricing.loading ? '计算中...' : '重新计算';
  }
  if (els.pricingPublishBtn) {
    els.pricingPublishBtn.disabled = Boolean(pricing.loading) || Boolean(pricing.publishing) || !showConfig;
    els.pricingPublishBtn.textContent = pricing.publishing ? '发布中...' : '发布定价';
  }
  renderPricingMetricGrid();
  renderPricingList();
}

function readPricingFormValues() {
  state.pricing.form = {
    payback_days: Number(els.pricingPaybackDays && els.pricingPaybackDays.value || state.pricing.form.payback_days || 210),
    avg_daily_rent_hours: Number(els.pricingAvgDailyRentHours && els.pricingAvgDailyRentHours.value || state.pricing.form.avg_daily_rent_hours || 3.5),
    platform_fee_rate: Number(els.pricingPlatformFeeRate && els.pricingPlatformFeeRate.value || state.pricing.form.platform_fee_rate || 0.2),
    withdrawal_fee_rate: Number(els.pricingWithdrawalFeeRate && els.pricingWithdrawalFeeRate.value || state.pricing.form.withdrawal_fee_rate || 0.02),
    price_step: Number(els.pricingPriceStep && els.pricingPriceStep.value || state.pricing.form.price_step || 0.5),
    deposit: Number(els.pricingDeposit && els.pricingDeposit.value || state.pricing.form.deposit || 100)
  };
}

function bindPricingEvents() {
  if (els.pricingFormulaHelpBtn) {
    els.pricingFormulaHelpBtn.onclick = (e) => {
      e.stopPropagation();
      togglePricingFormulaHelp();
    };
  }
  if (els.pricingCalcBtn) {
    els.pricingCalcBtn.onclick = async () => {
      readPricingFormValues();
      if (String(state.currentMenu || '').trim() === 'pricing_uhaozu') {
        await savePricingConfig();
      }
      await loadPricingView();
    };
  }
  if (els.pricingPublishBtn) {
    els.pricingPublishBtn.onclick = async () => {
      await publishPricingConfig();
    };
  }
  const inputNodes = [
    els.pricingPaybackDays,
    els.pricingAvgDailyRentHours,
    els.pricingPlatformFeeRate,
    els.pricingWithdrawalFeeRate,
    els.pricingPriceStep,
    els.pricingDeposit
  ];
  inputNodes.forEach((node) => {
    if (!node) return;
    node.onchange = () => readPricingFormValues();
  });
  document.addEventListener('click', (e) => {
    if (!els.pricingFormulaHelp || !els.pricingFormulaHelpBtn) return;
    const t = e.target;
    if (els.pricingFormulaHelp.contains(t) || els.pricingFormulaHelpBtn.contains(t)) return;
    closePricingFormulaHelp();
  });
}

bindPricingEvents();

window.loadPricingView = loadPricingView;
window.renderPricingView = renderPricingView;
window.closePricingCostSheet = closePricingCostSheet;
window.submitPricingCostConfig = submitPricingCostConfig;
