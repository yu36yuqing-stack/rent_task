function splitMobileText(input) {
  const raw = String(input == null ? '' : input);
  if (!raw.trim()) return [];
  const parts = raw
    .split(/[\s,，;；\n\t]+/)
    .map((x) => String(x || '').trim())
    .filter(Boolean)
    .map((x) => x.replace(/^\+?86/, '').replace(/[^\d]/g, ''))
    .filter((x) => /^1\d{10}$/.test(x));
  return Array.from(new Set(parts));
}

async function loadProfile() {
  state.profile.loading = true;
  renderProfileView();
  try {
    const out = await request('/api/profile');
    const profile = out && out.profile && typeof out.profile === 'object'
      ? out.profile
      : ((out && out.data && typeof out.data === 'object') ? out.data : {});
    const notify = profile && profile.notify ? profile.notify : {};
    const orderOff = profile && profile.order_off ? profile.order_off : {};

    const thresholdRaw = Number(orderOff.threshold);
    const threshold = Number.isFinite(thresholdRaw)
      ? Math.max(1, Math.min(10, Math.floor(thresholdRaw)))
      : 3;
    const mode = normalizeOrderOffMode(orderOff.mode, ORDER_OFF_MODE_NATURAL_DAY);

    state.profile.notify = {
      at_mode: String(notify.at_mode || 'none'),
      at_mobiles: Array.isArray(notify.at_mobiles) ? notify.at_mobiles.map((x) => String(x || '').trim()).filter(Boolean) : []
    };
    state.profile.order_off = {
      threshold,
      mode
    };
    state.userRules.order_off_threshold = threshold;
    state.userRules.order_off_mode = mode;
  } finally {
    state.profile.loading = false;
    renderProfileView();
  }
}

function renderProfileView() {
  if (!els.profileView) return;

  const notify = state.profile && state.profile.notify ? state.profile.notify : {};
  const orderOff = state.profile && state.profile.order_off ? state.profile.order_off : {};
  const loading = Boolean(state.profile && state.profile.loading);
  const notifySaving = Boolean(state.profile && state.profile.notify_saving);
  const orderOffSaving = Boolean(state.profile && state.profile.order_off_saving);

  if (els.profileAtMode) {
    const mode = String(notify.at_mode || 'none');
    const normalizedMode = (mode === 'owner' || mode === 'all') ? mode : 'none';
    els.profileAtMode.value = normalizedMode;
    if (els.profileAtModeNone) {
      els.profileAtModeNone.classList.toggle('active', normalizedMode === 'none');
    }
    if (els.profileAtModeOwner) {
      els.profileAtModeOwner.classList.toggle('active', normalizedMode === 'owner');
    }
    if (els.profileAtModeAll) {
      els.profileAtModeAll.classList.toggle('active', normalizedMode === 'all');
    }
  }
  const preserveNotifyInput = notifySaving || (typeof document !== 'undefined' && document.activeElement === els.profileAtMobiles);
  if (els.profileAtMobiles && !preserveNotifyInput) {
    els.profileAtMobiles.value = Array.isArray(notify.at_mobiles) ? notify.at_mobiles.join(',') : '';
  }
  const thresholdRaw = Number(orderOff.threshold);
  const threshold = Number.isFinite(thresholdRaw)
    ? Math.max(1, Math.min(10, Math.floor(thresholdRaw)))
    : 3;
  const preserveThresholdInput = orderOffSaving || (typeof document !== 'undefined' && document.activeElement === els.profileOrderOffThreshold);
  if (els.profileOrderOffThreshold && !preserveThresholdInput) {
    els.profileOrderOffThreshold.value = String(threshold);
  }
  const orderOffMode = normalizeOrderOffMode(orderOff.mode, ORDER_OFF_MODE_NATURAL_DAY);
  if (els.profileOrderOffMode) els.profileOrderOffMode.value = orderOffMode;
  if (els.profileOrderOffModeNatural) {
    els.profileOrderOffModeNatural.classList.toggle('active', orderOffMode === ORDER_OFF_MODE_NATURAL_DAY);
  }
  if (els.profileOrderOffModeRolling) {
    els.profileOrderOffModeRolling.classList.toggle('active', orderOffMode === ORDER_OFF_MODE_ROLLING_24H);
  }

  if (els.profileNotifySaveBtn) {
    els.profileNotifySaveBtn.disabled = loading || notifySaving;
    els.profileNotifySaveBtn.textContent = notifySaving ? '保存中...' : '保存通知设置';
  }
  if (els.profileOrderOffSaveBtn) {
    els.profileOrderOffSaveBtn.disabled = loading || orderOffSaving;
    els.profileOrderOffSaveBtn.textContent = orderOffSaving ? '保存中...' : '保存X单下架参数';
  }
}

async function submitProfileNotify() {
  const atMode = String((els.profileAtMode && els.profileAtMode.value) || 'none').trim();
  const atMobiles = splitMobileText(els.profileAtMobiles && els.profileAtMobiles.value);

  const out = await request('/api/profile/notify', {
    method: 'POST',
    body: JSON.stringify({
      at_mode: atMode,
      at_mobiles: atMobiles
    })
  });
  const notify = out && out.notify && typeof out.notify === 'object'
    ? out.notify
    : ((out && out.data && out.data.notify && typeof out.data.notify === 'object') ? out.data.notify : {});
  state.profile.notify = {
    at_mode: String(notify.at_mode || 'none'),
    at_mobiles: Array.isArray(notify.at_mobiles) ? notify.at_mobiles.map((x) => String(x || '').trim()).filter(Boolean) : []
  };
}

async function submitProfileOrderOff() {
  const thresholdRaw = String((els.profileOrderOffThreshold && els.profileOrderOffThreshold.value) || '').trim();
  const thresholdNum = Number(thresholdRaw);
  if (!Number.isFinite(thresholdNum) || thresholdNum < 1 || thresholdNum > 10) {
    throw new Error('请输入 1~10 的整数');
  }
  const threshold = Math.floor(thresholdNum);
  const mode = normalizeOrderOffMode((els.profileOrderOffMode && els.profileOrderOffMode.value) || ORDER_OFF_MODE_NATURAL_DAY);
  const out = await request('/api/profile/order-off', {
    method: 'POST',
    body: JSON.stringify({ threshold, mode })
  });
  const saved = out && out.order_off && typeof out.order_off === 'object'
    ? out.order_off
    : ((out && out.data && out.data.order_off && typeof out.data.order_off === 'object') ? out.data.order_off : {});
  const savedThresholdRaw = Number(saved.threshold);
  const savedThreshold = Number.isFinite(savedThresholdRaw)
    ? Math.max(1, Math.min(10, Math.floor(savedThresholdRaw)))
    : threshold;
  const savedMode = normalizeOrderOffMode(saved.mode, mode);
  state.profile.order_off = {
    threshold: savedThreshold,
    mode: savedMode
  };
  state.userRules.order_off_threshold = savedThreshold;
  state.userRules.order_off_mode = savedMode;
}

if (els.profileNotifySaveBtn) {
  els.profileNotifySaveBtn.addEventListener('click', async () => {
    if (state.profile.notify_saving) return;
    state.profile.notify_saving = true;
    renderProfileView();
    try {
      await submitProfileNotify();
      showToast('通知设置已保存');
    } catch (e) {
      showToast(e.message || '通知设置保存失败');
    } finally {
      state.profile.notify_saving = false;
      renderProfileView();
    }
  });
}

if (els.profileOrderOffSaveBtn) {
  els.profileOrderOffSaveBtn.addEventListener('click', async () => {
    if (state.profile.order_off_saving) return;
    state.profile.order_off_saving = true;
    renderProfileView();
    try {
      await submitProfileOrderOff();
      await loadList();
      showToast(`已设置为${Number(state.profile.order_off.threshold || 3)}单下架（${orderOffModeLabel(state.profile.order_off.mode)}）`);
    } catch (e) {
      showToast(e.message || 'X单下架参数保存失败');
    } finally {
      state.profile.order_off_saving = false;
      renderProfileView();
    }
  });
}

if (els.profileOrderOffModeNatural) {
  els.profileOrderOffModeNatural.addEventListener('click', () => {
    if (els.profileOrderOffMode) els.profileOrderOffMode.value = ORDER_OFF_MODE_NATURAL_DAY;
    if (state.profile && state.profile.order_off) state.profile.order_off.mode = ORDER_OFF_MODE_NATURAL_DAY;
    renderProfileView();
  });
}

if (els.profileOrderOffModeRolling) {
  els.profileOrderOffModeRolling.addEventListener('click', () => {
    if (els.profileOrderOffMode) els.profileOrderOffMode.value = ORDER_OFF_MODE_ROLLING_24H;
    if (state.profile && state.profile.order_off) state.profile.order_off.mode = ORDER_OFF_MODE_ROLLING_24H;
    renderProfileView();
  });
}

if (els.profileAtModeNone) {
  els.profileAtModeNone.addEventListener('click', () => {
    if (els.profileAtMode) els.profileAtMode.value = 'none';
    if (state.profile && state.profile.notify) state.profile.notify.at_mode = 'none';
    renderProfileView();
  });
}

if (els.profileAtModeOwner) {
  els.profileAtModeOwner.addEventListener('click', () => {
    if (els.profileAtMode) els.profileAtMode.value = 'owner';
    if (state.profile && state.profile.notify) state.profile.notify.at_mode = 'owner';
    renderProfileView();
  });
}

if (els.profileAtModeAll) {
  els.profileAtModeAll.addEventListener('click', () => {
    if (els.profileAtMode) els.profileAtMode.value = 'all';
    if (state.profile && state.profile.notify) state.profile.notify.at_mode = 'all';
    renderProfileView();
  });
}

window.loadProfile = loadProfile;
window.renderProfileView = renderProfileView;
window.submitProfileNotify = submitProfileNotify;
window.submitProfileOrderOff = submitProfileOrderOff;
