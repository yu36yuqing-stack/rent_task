    function riskTypeLabel(type) {
      const t = String(type || '').trim();
      if (t === 'online_non_renting') return '在线非租赁';
      if (!t) return '-';
      return t;
    }

    function riskEventStatusLabel(status) {
        const s = String(status || '').trim();
        if (s === 'open') return '事件: 处理中';
        if (s === 'resolved') return '事件: 已恢复';
        if (s === 'ignored') return '事件: 已忽略';
        return s || '-';
    }

    function riskTaskStatusLabel(status) {
        const s = String(status || '').trim();
        if (s === 'pending') return '流程: 待执行';
        if (s === 'watching') return '流程: 监控中';
        if (s === 'done') return '流程: 已完成';
        if (s === 'failed') return '流程: 失败';
        return s || '-';
    }

    function riskTaskStatusClass(status) {
      const s = String(status || '').trim();
      if (s === 'failed') return 'risk-failed';
      if (s === 'done') return 'done';
      if (s === 'watching') return 'progress';
      return 'done';
    }

    function riskEventStatusChipClass(status) {
      const s = String(status || '').trim();
      if (s === 'open') return 'progress';
      if (s === 'resolved') return 'done';
      if (s === 'ignored') return 'done';
      return 'done';
    }

    function escapeHtml(v) {
      return String(v == null ? '' : v)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function onlineTagLabel(v) {
      const s = String(v || '').trim().toUpperCase();
      if (s === 'ON') return '在线';
      if (s === 'OFF') return '离线';
      return '-';
    }

    function renderRiskCenterView() {
      if (!els.riskListContainer) return;
      const rc = state.riskCenter || { status: 'all', page: 1, pageSize: 20, total: 0, list: [], loading: false };
      const list = Array.isArray(rc.list) ? rc.list : [];

      if (els.riskStatusTabs) {
        Array.from(els.riskStatusTabs.querySelectorAll('[data-status]')).forEach((node) => {
          const val = String(node.getAttribute('data-status') || 'all').trim();
          node.classList.toggle('active', val === String(rc.status || 'all'));
        });
      }
      if (els.riskRefreshBtn) {
        const loading = Boolean(rc.loading);
        els.riskRefreshBtn.disabled = loading;
        els.riskRefreshBtn.textContent = loading ? '刷新中...' : '手工刷新';
      }

      if (list.length <= 0) {
        els.riskListContainer.innerHTML = '<div class="panel"><div style="color:#6d7a8a;font-size:13px;">暂无风控记录</div></div>';
      } else {
        els.riskListContainer.innerHTML = list.map((item) => {
          const displayName = String(item.display_name || item.game_account || '-').trim();
          const account = String(item.game_account || '').trim();
          const eventStatus = String(item.event_status || '').trim();
          const task = item && item.task && typeof item.task === 'object' ? item.task : null;
          const taskStatus = task ? String(task.status || '').trim() : '';
          const taskLabel = task ? riskTaskStatusLabel(taskStatus) : '未建任务';
          const taskClass = riskTaskStatusClass(taskStatus);
          const hitAt = String(item.hit_at || '').trim();
          const updatedAt = String((task && task.modify_date) || item.modify_date || '').trim();
          const lastOnlineTag = String((task && task.last_online_tag) || '').trim();
          const loopText = task ? `${Number(task.probe_loop_count || 0)}` : '-';
          const retryText = task ? `${Number(task.retry_count || 0)}/${Number(task.max_retry || 0)}` : '-';
          const latestOrderNo = String(item.latest_order_no || '').trim();
          const latestOrderEndTime = String(item.latest_order_end_time || '').trim();
          const forbiddenOnAt = String((task && task.forbidden_on_at) || '').trim();
          const forbiddenOffAt = String((task && task.forbidden_off_at) || '').trim();
          const lastError = task ? String(task.last_error || '').trim() : '';
          const eventStatusText = riskEventStatusLabel(eventStatus);
          const eventStatusClass = riskEventStatusChipClass(eventStatus);
          return `
            <div class="order-card">
              <div class="order-card-top">
                <p class="order-card-role">${escapeHtml(displayName)}</p>
                <div class="risk-card-top-chips">
                  <span class="order-chip ${eventStatusClass}">${escapeHtml(eventStatusText)}</span>
                  <span class="order-chip ${taskClass}">${escapeHtml(taskLabel)}</span>
                </div>
              </div>
              <div class="order-card-line">账号：${escapeHtml(account || '-')} · 类型：${escapeHtml(riskTypeLabel(item.risk_type))}</div>
              <div class="order-card-line">发现事件：${escapeHtml(hitAt || '-')}</div>
              <div class="order-card-line">最近订单结束：${escapeHtml(latestOrderEndTime || '-')} ${latestOrderNo ? `（No.${escapeHtml(latestOrderNo)}）` : ''}</div>
              <div class="order-card-line">开始禁玩：${escapeHtml(forbiddenOnAt || '-')}</div>
              <div class="order-card-line">解除禁玩：${escapeHtml(forbiddenOffAt || '-')}</div>
              <div class="risk-card-bottom">
                <div class="platforms">
                  <span class="plat">${escapeHtml(onlineTagLabel(lastOnlineTag))}</span>
                  <span class="plat">循环：${escapeHtml(loopText)}次</span>
                  <span class="plat">异常重试：${escapeHtml(retryText)}</span>
                  ${lastError ? `<span class="plat plat-abnormal" title="${escapeHtml(lastError)}">错误：${escapeHtml(lastError.slice(0, 18))}${lastError.length > 18 ? '...' : ''}</span>` : ''}
                </div>
              </div>
            </div>
          `;
        }).join('');
      }

      if (els.riskPageInfo) {
        const totalPages = Math.max(1, Math.ceil(Number(rc.total || 0) / Number(rc.pageSize || 20)));
        els.riskPageInfo.textContent = `第 ${Number(rc.page || 1)} / ${totalPages} 页 · 每页 ${Number(rc.pageSize || 20)} 条`;
      }
      if (els.riskPrevPage) els.riskPrevPage.disabled = Number(rc.page || 1) <= 1 || Boolean(rc.loading);
      if (els.riskNextPage) {
        const totalPages = Math.max(1, Math.ceil(Number(rc.total || 0) / Number(rc.pageSize || 20)));
        els.riskNextPage.disabled = Number(rc.page || 1) >= totalPages || Boolean(rc.loading);
      }
    }

    if (els.riskStatusTabs) {
      Array.from(els.riskStatusTabs.querySelectorAll('[data-status]')).forEach((node) => {
        node.addEventListener('click', async () => {
          const nextStatus = String(node.getAttribute('data-status') || 'all').trim().toLowerCase() || 'all';
          if (nextStatus === String((state.riskCenter && state.riskCenter.status) || 'all')) return;
          state.riskCenter.status = nextStatus;
          state.riskCenter.page = 1;
          state.riskCenter.loading = true;
          renderRiskCenterView();
          try {
            await loadRiskCenter();
            renderRiskCenterView();
          } catch (e) {
            showToast(e.message || '风控列表加载失败');
          } finally {
            state.riskCenter.loading = false;
            renderRiskCenterView();
          }
        });
      });
    }
