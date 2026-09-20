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

function maintenanceResult(row) {
  if (row && row.result && typeof row.result === 'object') return row.result;
  try {
    return JSON.parse(String(row && row.result_json || '{}'));
  } catch (_) {
    return {};
  }
}

function formatMaintenanceMetricBytes(value) {
  return value === undefined || value === null ? '-' : formatMaintenanceBytes(value);
}

function maintenanceCleanupResult(item, processedCount) {
  const freedBytes = Math.max(0, Number(item && item.freed_bytes || 0));
  if (freedBytes > 0) return `释放 ${formatMaintenanceBytes(freedBytes)}`;
  const estimatedBytes = Math.max(0, Number(item && item.estimated_deleted_bytes || 0));
  if (estimatedBytes > 0) return `预计释放 ${formatMaintenanceBytes(estimatedBytes)}`;
  return processedCount > 0 ? '处理完成' : '无可清理数据';
}

function buildMaintenanceDetailRows(row) {
  const result = maintenanceResult(row);
  const runtime = result && result.runtime_task;
  const blacklistHistory = result && result.user_blacklist_history;
  const onoffHistory = result && result.product_onoff_history;
  const orderDetailHtml = result && result.order_detail_html;
  const applicationLogs = result && result.application_logs;
  const compactions = result && Array.isArray(result.database_compaction)
    ? result.database_compaction
    : [];
  const rows = [];
  const addCleanupRow = (label, item, actionLabel, countKey = 'deleted_rows', countUnit = '条') => {
    if (!item) return;
    const count = Math.max(0, Number(item[countKey] || 0));
    rows.push({
      label,
      policy: `${Math.max(0, Number(item.retention_days || 0)) || '-'}天`,
      processed: `${actionLabel}${count} ${countUnit}`,
      before: formatMaintenanceMetricBytes(item.before_bytes),
      after: formatMaintenanceMetricBytes(item.after_bytes),
      result: maintenanceCleanupResult(item, count),
      result_class: count > 0 || Number(item.freed_bytes || 0) > 0 ? 'success' : 'muted'
    });
  };
  addCleanupRow('运行任务', runtime, '删除 ');
  addCleanupRow('黑名单历史', blacklistHistory, '删除 ');
  addCleanupRow('上下架历史', onoffHistory, '删除 ');
  addCleanupRow('订单详情 HTML', orderDetailHtml, '清空 ', 'cleared_rows');

  const files = applicationLogs && Array.isArray(applicationLogs.files)
    ? applicationLogs.files.filter((item) => item && !item.skipped)
    : [];
  files.forEach((item) => {
    const removedLines = Math.max(0, Number(item.removed_lines || 0));
    rows.push({
      label: String(item.file_name || '应用日志'),
      policy: `${Math.max(0, Number(item.retention_days || applicationLogs.retention_days || 0)) || '-'}天`,
      processed: `删除 ${removedLines} 行`,
      before: formatMaintenanceMetricBytes(item.before_bytes),
      after: formatMaintenanceMetricBytes(item.after_bytes),
      result: maintenanceCleanupResult(item, removedLines),
      result_class: removedLines > 0 || Number(item.freed_bytes || 0) > 0 ? 'success' : 'muted'
    });
  });
  if (applicationLogs && files.length === 0) {
    addCleanupRow('应用日志', applicationLogs, '删除 ', 'deleted_rows', '行');
  }

  const databaseLabels = { main: '主库', order: '订单库', runtime: '运行库' };
  compactions.forEach((item) => {
    const status = String(item && item.status || '');
    const reason = String(item && item.reason || '');
    let resultText = '未达到压缩阈值';
    let resultClass = 'muted';
    if (status === 'compacted') {
      resultText = Number(item.freed_bytes || 0) > 0
        ? `释放 ${formatMaintenanceBytes(item.freed_bytes)}`
        : '压缩完成';
      resultClass = 'success';
    } else if (reason === 'database_busy') {
      resultText = '数据库忙，已跳过';
      resultClass = 'warning';
    }
    rows.push({
      label: `${databaseLabels[String(item && item.database_name || '')] || String(item && item.database_name || '数据库')}压缩`,
      policy: '阈值触发',
      processed: '-',
      before: formatMaintenanceMetricBytes(item && item.before && item.before.file_bytes),
      after: formatMaintenanceMetricBytes(item && item.after && item.after.file_bytes),
      result: resultText,
      result_class: resultClass
    });
  });

  if (rows.length === 0) {
    const processedCount = Math.max(0, Number(row && row.deleted_rows || 0));
    rows.push({
      label: '清理汇总',
      policy: `${Math.max(0, Number(row && row.retention_days || 0)) || '-'}天`,
      processed: `处理 ${processedCount} 条/行`,
      before: formatMaintenanceMetricBytes(row && row.before_bytes),
      after: formatMaintenanceMetricBytes(row && row.after_bytes),
      result: maintenanceCleanupResult(row || {}, processedCount),
      result_class: processedCount > 0 || Number(row && row.freed_bytes || 0) > 0 ? 'success' : 'muted'
    });
  }
  return rows;
}

function renderMaintenanceTargets(row) {
  const rows = buildMaintenanceDetailRows(row);
  return `
    <div class="maintenance-detail-table-wrap">
      <table class="maintenance-detail-table">
        <caption>本次清理明细</caption>
        <thead>
          <tr>
            <th scope="col">清理项目</th>
            <th scope="col">保留策略</th>
            <th scope="col">处理数量</th>
            <th scope="col">清理前</th>
            <th scope="col">清理后</th>
            <th scope="col">释放/结果</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((item) => `
            <tr>
              <th scope="row">${escapeMaintenanceHtml(item.label)}</th>
              <td>${escapeMaintenanceHtml(item.policy)}</td>
              <td>${escapeMaintenanceHtml(item.processed)}</td>
              <td>${escapeMaintenanceHtml(item.before)}</td>
              <td>${escapeMaintenanceHtml(item.after)}</td>
              <td class="maintenance-result-${escapeMaintenanceHtml(item.result_class)}">${escapeMaintenanceHtml(item.result)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
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
          <span>清理记录/日志行</span>
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
      <div class="maintenance-log-meta">
        <span>耗时：${Number(row.duration_ms || 0)} ms</span>
        <span>处理：${Number(row.deleted_rows || 0)} 条/行</span>
        <span>实际释放：${formatMaintenanceBytes(row.freed_bytes)}</span>
        <span>触发人：${Number(row.trigger_user_id || 0) || '-'}</span>
      </div>
      ${renderMaintenanceTargets(row)}
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
