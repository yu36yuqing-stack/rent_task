function escapeMaintenanceHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatMaintenanceBytes(bytes) {
  const n = Math.max(0, Number(bytes || 0));
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(2)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(2)} KB`;
  return `${Math.round(n)} B`;
}

function maintenanceStatusLabel(status) {
  const s = String(status || '').trim();
  if (s === 'success') return '成功';
  if (s === 'failed') return '失败';
  if (s === 'running') return '执行中';
  return s || '-';
}

function maintenanceTriggerLabel(triggerType) {
  const t = String(triggerType || '').trim();
  if (t === 'manual') return '手动';
  if (t === 'scheduled') return '定时';
  if (t === 'manual_script') return '脚本';
  return t || '-';
}

async function loadMaintenanceCleanup() {
  state.maintenanceCleanup.loading = true;
  state.maintenanceCleanup.error = '';
  renderMaintenanceCleanup();
  try {
    const out = await request('/api/maintenance/runtime-cleanup?limit=20');
    state.maintenanceCleanup.dashboard = out && out.dashboard ? out.dashboard : null;
  } catch (e) {
    state.maintenanceCleanup.error = e.message || '数据清理记录加载失败';
    throw e;
  } finally {
    state.maintenanceCleanup.loading = false;
    renderMaintenanceCleanup();
  }
}

async function runMaintenanceCleanupNow() {
  if (state.maintenanceCleanup.running) return;
  state.maintenanceCleanup.running = true;
  state.maintenanceCleanup.error = '';
  renderMaintenanceCleanup();
  try {
    await request('/api/maintenance/runtime-cleanup/run', {
      method: 'POST',
      body: JSON.stringify({})
    });
    await loadMaintenanceCleanup();
    showToast('数据清理完成');
  } catch (e) {
    state.maintenanceCleanup.error = e.message || '数据清理执行失败';
    await loadMaintenanceCleanup().catch(() => {});
    showToast(state.maintenanceCleanup.error);
  } finally {
    state.maintenanceCleanup.running = false;
    renderMaintenanceCleanup();
  }
}

function renderMaintenanceCleanup() {
  if (!els.maintenanceCleanupView) return;
  const stateObj = state.maintenanceCleanup || {};
  const dashboard = stateObj.dashboard || {};
  const latest = dashboard.latest || null;
  const loading = Boolean(stateObj.loading);
  const running = Boolean(stateObj.running || (latest && String(latest.status || '') === 'running'));
  if (els.maintenanceCleanupRunBtn) {
    els.maintenanceCleanupRunBtn.disabled = loading || running;
    els.maintenanceCleanupRunBtn.textContent = running ? '清理中...' : '立即清理一次';
  }
  if (els.maintenanceCleanupSummary) {
    if (loading && !latest) {
      els.maintenanceCleanupSummary.innerHTML = '<div class="panel maintenance-empty">数据清理记录加载中...</div>';
    } else {
      const err = String(stateObj.error || '').trim();
      els.maintenanceCleanupSummary.innerHTML = `
        <div class="maintenance-kpi-card">
          <span>最近状态</span>
          <strong class="maintenance-status-${escapeMaintenanceHtml(latest && latest.status || 'none')}">${escapeMaintenanceHtml(maintenanceStatusLabel(latest && latest.status))}</strong>
        </div>
        <div class="maintenance-kpi-card">
          <span>清理条数</span>
          <strong>${Number(latest && latest.deleted_rows || 0)}</strong>
        </div>
        <div class="maintenance-kpi-card">
          <span>估算清理数据</span>
          <strong>${formatMaintenanceBytes(latest && latest.estimated_deleted_bytes)}</strong>
        </div>
        <div class="maintenance-kpi-card">
          <span>实际释放空间</span>
          <strong>${formatMaintenanceBytes(latest && latest.freed_bytes)}</strong>
        </div>
        <div class="maintenance-kpi-card maintenance-kpi-wide">
          <span>最近执行</span>
          <strong>${escapeMaintenanceHtml(latest && latest.finished_at || latest && latest.started_at || '-')}</strong>
        </div>
        ${err ? `<div class="maintenance-error">${escapeMaintenanceHtml(err)}</div>` : ''}
      `;
    }
  }
  if (!els.maintenanceCleanupList) return;
  const logs = Array.isArray(dashboard.logs) ? dashboard.logs : [];
  if (loading && logs.length === 0) {
    els.maintenanceCleanupList.innerHTML = '<div class="panel maintenance-empty">清理历史加载中...</div>';
    return;
  }
  if (logs.length === 0) {
    els.maintenanceCleanupList.innerHTML = '<div class="panel maintenance-empty">暂无清理记录，可以点击“立即清理一次”。</div>';
    return;
  }
  els.maintenanceCleanupList.innerHTML = logs.map((row) => `
    <div class="panel maintenance-log-card">
      <div class="maintenance-log-head">
        <div>
          <p class="maintenance-log-title">${escapeMaintenanceHtml(maintenanceTriggerLabel(row.trigger_type))}清理 · ${escapeMaintenanceHtml(maintenanceStatusLabel(row.status))}</p>
          <p class="maintenance-log-time">${escapeMaintenanceHtml(row.started_at || '-')} → ${escapeMaintenanceHtml(row.finished_at || '-')}</p>
        </div>
        <span class="maintenance-status-pill maintenance-status-${escapeMaintenanceHtml(row.status)}">${escapeMaintenanceHtml(maintenanceStatusLabel(row.status))}</span>
      </div>
      <div class="maintenance-log-grid">
        <span>清理表：${escapeMaintenanceHtml(row.target_table || '-')}</span>
        <span>保留：${Number(row.retention_days || 0)} 天</span>
        <span>删除：${Number(row.deleted_rows || 0)} 条</span>
        <span>耗时：${Number(row.duration_ms || 0)} ms</span>
        <span>清理前：${formatMaintenanceBytes(row.before_bytes)}</span>
        <span>清理后：${formatMaintenanceBytes(row.after_bytes)}</span>
        <span>估算清理：${formatMaintenanceBytes(row.estimated_deleted_bytes)}</span>
        <span>实际释放：${formatMaintenanceBytes(row.freed_bytes)}</span>
        <span>触发人：${Number(row.trigger_user_id || 0) || '-'}</span>
      </div>
      ${String(row.error_message || '').trim() ? `<p class="maintenance-log-error">${escapeMaintenanceHtml(row.error_message)}</p>` : ''}
    </div>
  `).join('');
}

if (els.maintenanceCleanupRunBtn) {
  els.maintenanceCleanupRunBtn.addEventListener('click', () => {
    runMaintenanceCleanupNow().catch((e) => {
      showToast(e.message || '数据清理执行失败');
    });
  });
}

window.loadMaintenanceCleanup = loadMaintenanceCleanup;
window.renderMaintenanceCleanup = renderMaintenanceCleanup;
