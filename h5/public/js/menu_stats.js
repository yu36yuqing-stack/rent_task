    function renderStatsMissingOverlay() {
      const missing = Array.isArray(state.statsBoard && state.statsBoard.missing_purchase_accounts)
        ? state.statsBoard.missing_purchase_accounts
        : [];
      if (missing.length === 0) {
        els.statsMissingOverlay.classList.add('hidden');
        els.statsMissingList.innerHTML = '';
        return;
      }
      els.statsMissingList.innerHTML = missing.map((x) => {
        const role = String(x.role_name || '').trim();
        const acc = String(x.game_account || '').trim();
        return `<li>${role || acc}（${acc}）</li>`;
      }).join('');
      els.statsMissingOverlay.classList.remove('hidden');
    }

    function currentMonthText() {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    }

    function daysInMonth(monthText) {
      const [y, m] = String(monthText || '').split('-').map((x) => Number(x || 0));
      return new Date(y, m, 0).getDate();
    }

    function dayOfWeek(monthText, day) {
      const [y, m] = String(monthText || '').split('-').map((x) => Number(x || 0));
      return new Date(y, (m || 1) - 1, day).getDay();
    }

    async function loadStatsCalendar(monthText = '') {
      const month = /^\d{4}-\d{2}$/.test(String(monthText || '').trim())
        ? String(monthText).trim()
        : (state.statsBoard.calendar && state.statsBoard.calendar.month) || currentMonthText();
      const data = await request(`/api/stats/calendar?month=${encodeURIComponent(month)}&game_name=WZRY`);
      state.statsBoard.calendar = {
        month: String(data.month || month),
        start_date: String(data.start_date || ''),
        end_date: String(data.end_date || ''),
        total_rec_amount: Number(data.total_rec_amount || 0),
        by_day: Array.isArray(data.by_day) ? data.by_day : []
      };
    }

    function renderStatsCalendar() {
      const cal = (state.statsBoard && state.statsBoard.calendar) || {};
      const month = /^\d{4}-\d{2}$/.test(String(cal.month || '')) ? cal.month : currentMonthText();
      const byDay = Array.isArray(cal.by_day) ? cal.by_day : [];
      const amountByDay = new Map(
        byDay.map((x) => [String(x.stat_date || '').slice(-2), Number(x.amount_rec_sum || 0)])
      );

      els.statsCalMonth.value = month;
      els.statsCalTitle.textContent = `收入日历（元）/合计：¥${Number(cal.total_rec_amount || 0).toFixed(2)}`;

      const totalDays = daysInMonth(month);
      const firstWeekday = dayOfWeek(month, 1);
      const cells = [];
      for (let i = 0; i < firstWeekday; i += 1) {
        cells.push('<div class="stats-cal-cell empty"></div>');
      }
      for (let d = 1; d <= totalDays; d += 1) {
        const dd = String(d).padStart(2, '0');
        const amt = Number(amountByDay.get(dd) || 0);
        const has = amt > 0;
        cells.push(`
          <div class="stats-cal-cell ${has ? 'has-income' : ''}">
            <p class="stats-cal-day">${d}</p>
            <p class="stats-cal-income">${has ? `+${amt.toFixed(2)}` : ''}</p>
          </div>
        `);
      }
      els.statsCalGrid.innerHTML = cells.join('');
      els.statsCalMonth.onchange = async () => {
        try {
          const nextMonth = String(els.statsCalMonth.value || '').trim();
          await loadStatsCalendar(nextMonth);
          renderStatsCalendar();
        } catch (e) {
          alert(e.message || '加载收入日历失败');
        }
      };
    }

    function renderStatsView() {
      const s = state.statsBoard || {};
      const periods = [
        { k: 'today', t: '当日' },
        { k: 'yesterday', t: '昨日' },
        { k: 'week', t: '本周' },
        { k: 'last7', t: '近7天' },
        { k: 'month', t: '本月' },
        { k: 'last30', t: '近30天' }
      ];
      const summary = s.summary || {};
      const profitability = s.profitability || {};
      const orderBase = Number(summary.order_cnt_total || 0);
      const avgRec = orderBase > 0 ? Number(summary.amount_rec_sum || 0) / orderBase : 0;

      els.statsPeriods.innerHTML = periods.map((x) => `
        <button class="stats-period-btn ${s.period === x.k ? 'active' : ''}" data-stats-period="${x.k}">${x.t}</button>
      `).join('');
      els.statsRangeText.textContent = `统计区间：${(s.range && s.range.start_date) || '-'} ~ ${(s.range && s.range.end_date) || '-'}`;
      els.statsKpiGrid.innerHTML = `
        <div class="stats-kpi-card">
          <p class="stats-kpi-key">有效订单数</p>
          <p class="stats-kpi-value">${Number(summary.order_cnt_effective || 0)}</p>
        </div>
        <div class="stats-kpi-card">
          <p class="stats-kpi-key">实收总额</p>
          <p class="stats-kpi-value money">¥${Number(summary.amount_rec_sum || 0).toFixed(2)}</p>
        </div>
        <div class="stats-kpi-card">
          <p class="stats-kpi-key">单均实收</p>
          <p class="stats-kpi-value">¥${avgRec.toFixed(2)}</p>
        </div>
        <div class="stats-kpi-card">
          <p class="stats-kpi-key">退款率</p>
          <p class="stats-kpi-value">${(Number(summary.refund_rate || 0) * 100).toFixed(1)}%</p>
        </div>
        <div class="stats-kpi-card">
          <p class="stats-kpi-key">撤单率</p>
          <p class="stats-kpi-value">${(Number(summary.cancel_rate || 0) * 100).toFixed(1)}%</p>
        </div>
        <div class="stats-kpi-card">
          <p class="stats-kpi-key">采购本金</p>
          <p class="stats-kpi-value">¥${Number(profitability.purchase_base || 0).toFixed(2)}</p>
        </div>
        <div class="stats-kpi-card">
          <p class="stats-kpi-key">折算年化收益率</p>
          <p class="stats-kpi-value">${(Number(profitability.annualized_return_rate || 0) * 100).toFixed(2)}%</p>
        </div>
        <div class="stats-kpi-card">
          <p class="stats-kpi-key">总体日均单数</p>
          <p class="stats-kpi-value">${Number(summary.avg_daily_order_cnt || 0).toFixed(2)}</p>
        </div>
        <div class="stats-kpi-card">
          <p class="stats-kpi-key">总体日均时长</p>
          <p class="stats-kpi-value">${Number(summary.avg_daily_rent_hour || 0).toFixed(2)}h</p>
        </div>
        <div class="stats-kpi-card">
          <p class="stats-kpi-key">总体日均单价</p>
          <p class="stats-kpi-value">¥${Number(summary.avg_order_price || 0).toFixed(2)}</p>
        </div>
        <div class="stats-kpi-card">
          <p class="stats-kpi-key">总体日均实收</p>
          <p class="stats-kpi-value">¥${Number(summary.avg_daily_rec || 0).toFixed(2)}</p>
        </div>
        <div class="stats-kpi-card">
          <p class="stats-kpi-key">3单达成率</p>
          <p class="stats-kpi-value">${(Number(summary.target3_rate || 0) * 100).toFixed(1)}%</p>
        </div>
      `;
      renderStatsCalendar();

      els.statsAccountTitle.textContent = `账号收益（已配置 ${Number(s.configured_account_count || 0)} 个）`;
      const list = Array.isArray(s.by_account) ? s.by_account : [];
      if (list.length === 0) {
        els.statsAccountList.innerHTML = '<div class="panel"><div style="color:#6d7a8a;font-size:13px;">暂无可展示的账号统计</div></div>';
      } else {
        els.statsAccountList.innerHTML = list.map((x) => `
          <div class="stats-acc-item">
            <div class="stats-acc-top">
              <p class="stats-acc-name">${x.role_name || x.game_account || '-'}</p>
              <span class="stats-acc-money">¥${Number(x.amount_rec_sum || 0).toFixed(2)}</span>
            </div>
            <p class="stats-acc-meta">账号：${x.game_account || '-'} · 有效订单：${Number(x.order_cnt_effective || 0)}</p>
            <div class="stats-acc-grid">
              <div class="stats-acc-chip"><p class="stats-acc-chip-k">账号成本</p><p class="stats-acc-chip-v">¥${Number(x.purchase_base || 0).toFixed(2)}</p></div>
              <div class="stats-acc-chip"><p class="stats-acc-chip-k">年化(单利)</p><p class="stats-acc-chip-v">${(Number(x.annualized_return_rate || 0) * 100).toFixed(2)}%</p></div>
              <div class="stats-acc-chip"><p class="stats-acc-chip-k">日均单数</p><p class="stats-acc-chip-v">${Number(x.avg_daily_order_cnt || 0).toFixed(2)}</p></div>
              <div class="stats-acc-chip"><p class="stats-acc-chip-k">日均时长</p><p class="stats-acc-chip-v">${Number(x.avg_daily_rent_hour || 0).toFixed(2)}h</p></div>
              <div class="stats-acc-chip"><p class="stats-acc-chip-k">日均单价</p><p class="stats-acc-chip-v">¥${Number(x.avg_order_price || 0).toFixed(2)}</p></div>
              <div class="stats-acc-chip"><p class="stats-acc-chip-k">日均实收</p><p class="stats-acc-chip-v">¥${Number(x.avg_daily_rec || 0).toFixed(2)}</p></div>
              <div class="stats-acc-chip"><p class="stats-acc-chip-k">3单达成率</p><p class="stats-acc-chip-v">${(Number(x.target3_rate || 0) * 100).toFixed(1)}%</p></div>
              <div class="stats-acc-chip"><p class="stats-acc-chip-k">退款/撤单</p><p class="stats-acc-chip-v">${Number(x.order_cnt_refund || 0)}/${Number(x.order_cnt_cancel || 0)}</p></div>
            </div>
          </div>
        `).join('');
      }

      Array.from(els.statsPeriods.querySelectorAll('[data-stats-period]')).forEach((n) => {
        n.addEventListener('click', async () => {
          const k = String(n.getAttribute('data-stats-period') || 'today').trim();
          if (k === state.statsBoard.period) return;
          state.statsBoard.period = k;
          await loadStatsBoard();
          renderStatsView();
        });
      });
      renderStatsMissingOverlay();
    }
