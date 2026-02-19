    function formatOrderTimeRange(item) {
      const s = String(item.start_time || '').slice(5, 16);
      const e = String(item.end_time || '').slice(5, 16);
      return `${s} ~ ${e}`;
    }

    function textOrDash(v) {
      const t = String(v == null ? '' : v).trim();
      return t || '-';
    }

    function isLikelyImageUrl(url) {
      const u = String(url || '').trim();
      if (!u) return false;
      if (/^data:image\//i.test(u)) return true;
      return /\.(png|jpe?g|gif|webp|bmp|svg)(\?|#|$)/i.test(u);
    }

    async function openOrderComplaintDetail(channel, orderNo, order) {
      state.orders.complaint_detail = {
        open: true,
        loading: true,
        error: '',
        order_no: orderNo,
        channel,
        order: order || null,
        data: null,
        preview_image_url: ''
      };
      history.pushState({ h5_sub_view: 'order_complaint', channel, order_no: orderNo }, '', window.location.href);
      render();
      try {
        const out = await request(`/api/orders/complaint?channel=${encodeURIComponent(channel)}&order_no=${encodeURIComponent(orderNo)}`);
        state.orders.complaint_detail.loading = false;
        state.orders.complaint_detail.data = out && out.data ? out.data : null;
      } catch (e) {
        state.orders.complaint_detail.loading = false;
        state.orders.complaint_detail.error = String(e && e.message ? e.message : '投诉详情拉取失败');
      }
      render();
    }

    function renderOrderComplaintView() {
      const c = (state.orders && state.orders.complaint_detail) || {};
      if (!els.orderComplaintContainer) return;
      if (els.orderComplaintBackBtn) {
        els.orderComplaintBackBtn.onclick = () => {
          if (window.history.length > 1) {
            window.history.back();
            return;
          }
          state.orders.complaint_detail.preview_image_url = '';
          state.orders.complaint_detail.open = false;
          render();
        };
      }
      if (c.loading) {
        els.orderComplaintContainer.innerHTML = '<div class="panel"><div style="color:#6d7a8a;font-size:13px;">投诉信息加载中...</div></div>';
        return;
      }
      if (c.error) {
        els.orderComplaintContainer.innerHTML = `<div class="panel"><div style="color:#bb2d3b;font-size:13px;">${textOrDash(c.error)}</div></div>`;
        return;
      }
      if (!c.data) {
        els.orderComplaintContainer.innerHTML = '<div class="panel"><div style="color:#6d7a8a;font-size:13px;">该订单暂无投诉详情</div></div>';
        return;
      }
      const item = c.order || {};
      const d = c.data || {};
      const attachmentRaw = String(d.complaint_attachment || '').trim();
      const attachmentList = attachmentRaw
        ? attachmentRaw.split(/[,\n]/).map((x) => String(x || '').trim()).filter(Boolean)
        : [];
      const imageList = attachmentList.filter((u) => isLikelyImageUrl(u));
      const linkList = attachmentList.filter((u) => !isLikelyImageUrl(u));
      const imageGridHtml = imageList.length > 0
        ? `<div class="order-complaint-image-grid">${imageList.map((u, idx) => `
            <button type="button" class="order-complaint-image-item" data-complaint-preview="${u}" aria-label="查看投诉图片${idx + 1}">
              <img class="order-complaint-image" src="${u}" alt="投诉图片${idx + 1}" loading="lazy">
            </button>
          `).join('')}</div>`
        : '';
      const linkHtml = linkList.length > 0
        ? `<div class="order-complaint-link-list">${linkList.map((u) => `<a class="order-complaint-link" href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`).join('')}</div>`
        : '';
      const attachmentHtml = (imageGridHtml || linkHtml) ? `${imageGridHtml}${linkHtml}` : '<span class="order-complaint-value">-</span>';
      const previewSrc = String(c.preview_image_url || '').trim();
      const previewHtml = previewSrc
        ? `
          <div class="order-complaint-preview-mask" data-complaint-preview-close="1">
            <button type="button" class="order-complaint-preview-close" data-complaint-preview-close-btn="1" aria-label="关闭预览">×</button>
            <div class="order-complaint-preview-stage" data-complaint-preview-stage="1">
              <img class="order-complaint-preview-image" src="${previewSrc}" alt="投诉图片预览" data-complaint-preview-image="1">
            </div>
            <div class="order-complaint-preview-controls" data-complaint-preview-controls="1">
              <button type="button" class="order-complaint-preview-ctrl-btn" data-complaint-zoom-out="1" aria-label="缩小">-</button>
              <button type="button" class="order-complaint-preview-ctrl-btn mid" data-complaint-zoom-reset="1" aria-label="重置缩放">100%</button>
              <button type="button" class="order-complaint-preview-ctrl-btn" data-complaint-zoom-in="1" aria-label="放大">+</button>
            </div>
          </div>
        `
        : '';
      els.orderComplaintContainer.innerHTML = `
        <div class="order-complaint-card">
          <p class="order-complaint-title">订单投诉详情</p>
          <div class="order-complaint-grid">
            <div class="order-complaint-row"><span class="order-complaint-label">订单号</span><span class="order-complaint-value">${textOrDash(item.order_no || d.order_no)}</span></div>
            <div class="order-complaint-row"><span class="order-complaint-label">渠道</span><span class="order-complaint-value">${textOrDash(item.channel || d.channel)}</span></div>
            <div class="order-complaint-row"><span class="order-complaint-label">投诉状态</span><span class="order-complaint-value">${textOrDash(d.complaint_status)}</span></div>
            <div class="order-complaint-row"><span class="order-complaint-label">投诉ID</span><span class="order-complaint-value">${textOrDash(d.complaint_id)}</span></div>
            <div class="order-complaint-row"><span class="order-complaint-label">投诉类型</span><span class="order-complaint-value">${textOrDash(d.complaint_type_desc || d.complaint_type)}</span></div>
            <div class="order-complaint-row"><span class="order-complaint-label">投诉时间</span><span class="order-complaint-value">${textOrDash(d.complaint_start_time)}</span></div>
            <div class="order-complaint-row"><span class="order-complaint-label">首次登录</span><span class="order-complaint-value">${textOrDash(d.first_log_time)}</span></div>
            <div class="order-complaint-row"><span class="order-complaint-label">履约时长</span><span class="order-complaint-value">${textOrDash(d.rent_duration)}</span></div>
            <div class="order-complaint-row"><span class="order-complaint-label">检测结果</span><span class="order-complaint-value">${textOrDash(d.check_result_desc)}</span></div>
            <div class="order-complaint-row order-complaint-row-full"><span class="order-complaint-label">投诉内容</span><span class="order-complaint-value">${textOrDash(d.complaint_context)}</span></div>
            <div class="order-complaint-row order-complaint-row-full"><span class="order-complaint-label">投诉附件</span><span class="order-complaint-attachments">${attachmentHtml}</span></div>
          </div>
        </div>
        ${previewHtml}
      `;
      Array.from(els.orderComplaintContainer.querySelectorAll('[data-complaint-preview]')).forEach((n) => {
        n.addEventListener('click', () => {
          const src = String(n.getAttribute('data-complaint-preview') || '').trim();
          if (!src) return;
          state.orders.complaint_detail.preview_image_url = src;
          render();
        });
      });
      const previewMask = els.orderComplaintContainer.querySelector('[data-complaint-preview-close="1"]');
      if (previewMask) {
        previewMask.addEventListener('click', () => {
          state.orders.complaint_detail.preview_image_url = '';
          render();
        });
      }
      const previewCloseBtn = els.orderComplaintContainer.querySelector('[data-complaint-preview-close-btn="1"]');
      if (previewCloseBtn) {
        previewCloseBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          state.orders.complaint_detail.preview_image_url = '';
          render();
        });
      }
      const previewImage = els.orderComplaintContainer.querySelector('[data-complaint-preview-image="1"]');
      const previewStage = els.orderComplaintContainer.querySelector('[data-complaint-preview-stage="1"]');
      const previewControls = els.orderComplaintContainer.querySelector('[data-complaint-preview-controls="1"]');
      const zoomInBtn = els.orderComplaintContainer.querySelector('[data-complaint-zoom-in="1"]');
      const zoomOutBtn = els.orderComplaintContainer.querySelector('[data-complaint-zoom-out="1"]');
      const zoomResetBtn = els.orderComplaintContainer.querySelector('[data-complaint-zoom-reset="1"]');
      if (previewImage && previewStage) {
        const MIN_SCALE = 1;
        const MAX_SCALE = 4;
        const STEP = 0.25;
        let scale = 1;
        let translateX = 0;
        let translateY = 0;
        let gestureMode = '';
        let panStartX = 0;
        let panStartY = 0;
        let panBaseX = 0;
        let panBaseY = 0;
        let pinchStartDistance = 0;
        let pinchStartScale = 1;
        let lastTapTs = 0;

        const toDistance = (t1, t2) => {
          const dx = Number(t1.clientX || 0) - Number(t2.clientX || 0);
          const dy = Number(t1.clientY || 0) - Number(t2.clientY || 0);
          return Math.sqrt(dx * dx + dy * dy);
        };
        const clampScale = (v) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, Number(v || 1)));
        const clampTranslate = () => {
          const w = Number(previewImage.clientWidth || 0);
          const h = Number(previewImage.clientHeight || 0);
          const maxX = Math.max(0, (w * scale - w) / 2);
          const maxY = Math.max(0, (h * scale - h) / 2);
          translateX = Math.max(-maxX, Math.min(maxX, translateX));
          translateY = Math.max(-maxY, Math.min(maxY, translateY));
        };
        const applyTransform = () => {
          clampTranslate();
          previewImage.style.transform = `translate(${translateX}px, ${translateY}px) scale(${scale})`;
          if (zoomResetBtn) zoomResetBtn.textContent = `${Math.round(scale * 100)}%`;
        };
        const setScale = (nextScale, keepTranslate = true) => {
          scale = clampScale(nextScale);
          if (!keepTranslate || scale <= 1) {
            translateX = 0;
            translateY = 0;
          }
          applyTransform();
        };

        previewImage.addEventListener('load', () => applyTransform());
        previewImage.addEventListener('click', (e) => e.stopPropagation());
        previewImage.addEventListener('dblclick', (e) => {
          e.preventDefault();
          e.stopPropagation();
          setScale(scale < 1.5 ? 2 : 1, false);
        });

        previewStage.addEventListener('click', (e) => e.stopPropagation());
        previewStage.addEventListener('touchstart', (e) => {
          if (!e.touches || e.touches.length === 0) return;
          if (e.touches.length >= 2) {
            gestureMode = 'pinch';
            pinchStartDistance = toDistance(e.touches[0], e.touches[1]);
            pinchStartScale = scale;
            return;
          }
          if (scale > 1) {
            gestureMode = 'pan';
            panStartX = Number(e.touches[0].clientX || 0);
            panStartY = Number(e.touches[0].clientY || 0);
            panBaseX = translateX;
            panBaseY = translateY;
          }
        }, { passive: false });
        previewStage.addEventListener('touchmove', (e) => {
          if (!e.touches || e.touches.length === 0) return;
          if (gestureMode === 'pinch' && e.touches.length >= 2) {
            e.preventDefault();
            const dist = toDistance(e.touches[0], e.touches[1]);
            if (pinchStartDistance > 0) {
              scale = clampScale(pinchStartScale * (dist / pinchStartDistance));
              applyTransform();
            }
            return;
          }
          if (gestureMode === 'pan' && e.touches.length === 1 && scale > 1) {
            e.preventDefault();
            const nx = Number(e.touches[0].clientX || 0);
            const ny = Number(e.touches[0].clientY || 0);
            translateX = panBaseX + (nx - panStartX);
            translateY = panBaseY + (ny - panStartY);
            applyTransform();
          }
        }, { passive: false });
        previewStage.addEventListener('touchend', (e) => {
          if (e.touches && e.touches.length >= 2) {
            pinchStartDistance = toDistance(e.touches[0], e.touches[1]);
            pinchStartScale = scale;
            gestureMode = 'pinch';
            return;
          }
          if (e.touches && e.touches.length === 1 && scale > 1) {
            gestureMode = 'pan';
            panStartX = Number(e.touches[0].clientX || 0);
            panStartY = Number(e.touches[0].clientY || 0);
            panBaseX = translateX;
            panBaseY = translateY;
            return;
          }
          const now = Date.now();
          if (now - lastTapTs <= 280) {
            setScale(scale < 1.5 ? 2 : 1, false);
          }
          lastTapTs = now;
          gestureMode = '';
        });

        if (previewControls) previewControls.addEventListener('click', (e) => e.stopPropagation());
        if (zoomInBtn) zoomInBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          setScale(scale + STEP);
        });
        if (zoomOutBtn) zoomOutBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          setScale(scale - STEP);
        });
        if (zoomResetBtn) zoomResetBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          setScale(1, false);
        });
        applyTransform();
      }
    }

    function renderOrdersView() {
      const o = state.orders || {};
      const tabs = [
        { k: 'all', t: '全部' },
        { k: 'progress', t: '租赁中' },
        { k: 'refund', t: '已退款' },
        { k: 'done', t: '已完成' }
      ];
      const quick = [
        { k: 'today', t: '当日' },
        { k: 'yesterday', t: '昨日' },
        { k: 'last24h', t: '近24小时' },
        { k: 'week', t: '本周' },
        { k: 'last7', t: '近7天' },
        { k: 'month', t: '本月' },
        { k: 'last30', t: '近30天' }
      ];
      els.orderStatusTabs.innerHTML = tabs.map((x) => `
        <button class="orders-tab ${o.status_filter === x.k ? 'active' : ''}" data-order-status="${x.k}">${x.t}</button>
      `).join('');
      els.orderQuickFilters.innerHTML = quick.map((x) => `
        <button class="orders-quick-item ${o.quick_filter === x.k ? 'active' : ''}" data-order-quick="${x.k}">${x.t}</button>
      `).join('');
      if (els.orderSyncNowBtn) {
        els.orderSyncNowBtn.disabled = Boolean(o.syncing);
        els.orderSyncNowBtn.textContent = o.syncing ? '同步中...' : '同步订单';
      }
      els.orderGameHint.textContent = `游戏：${o.game_name || 'WZRY'}（默认） · 汇总：${Number(o.total || 0)}（0收-${Number((o.stats && o.stats.done_zero) || 0)}）`;

      if (!Array.isArray(o.list) || o.list.length === 0) {
        els.orderListContainer.innerHTML = '<div class="panel"><div style="color:#6d7a8a;font-size:13px;">暂无订单数据</div></div>';
      } else {
        els.orderListContainer.innerHTML = o.list.map((item) => `
          <div class="order-card">
            <div class="order-card-top">
              <p class="order-card-role">${item.role_name || item.game_account || '-'}</p>
              <span class="order-chip ${(String(item.order_status || '') === '租赁中' || String(item.order_status || '') === '出租中') ? 'progress' : 'done'}">${item.order_status || '-'}</span>
            </div>
            <div class="order-id-row">
              <span class="order-id-label">No.${item.order_no || '-'}</span>
              <button class="order-copy-btn" data-order-copy="${item.order_no || ''}">复制</button>
              ${item.has_complaint ? `<button class="order-complaint-btn" data-order-complaint="${item.order_no || ''}" data-order-channel="${item.channel || ''}">投诉详情</button>` : ''}
            </div>
            <div class="order-card-line">${formatOrderTimeRange(item)}</div>
            <div class="order-card-line">渠道：${item.channel || '-'} · 账号：${item.game_account || '-'}</div>
            <div class="order-bottom">
              <div class="order-bottom-left">
                时长：${Number(item.rent_hour || 0)}小时 · 订单金额：¥${Number(item.order_amount || 0).toFixed(2)}
              </div>
              <div class="order-income">
                <span class="order-income-label">实际收入</span>¥${Number(item.rec_amount || 0).toFixed(2)}
              </div>
            </div>
          </div>
        `).join('');
        Array.from(els.orderListContainer.querySelectorAll('[data-order-copy]')).forEach((n) => {
          n.addEventListener('click', () => copyAccount(n.getAttribute('data-order-copy') || ''));
        });
        Array.from(els.orderListContainer.querySelectorAll('[data-order-complaint]')).forEach((n) => {
          n.addEventListener('click', async () => {
            const orderNo = String(n.getAttribute('data-order-complaint') || '').trim();
            const channel = String(n.getAttribute('data-order-channel') || '').trim().toLowerCase();
            if (!orderNo || !channel) {
              showToast('订单参数不完整');
              return;
            }
            const order = (Array.isArray(o.list) ? o.list : []).find((x) => {
              return String(x.order_no || '').trim() === orderNo && String(x.channel || '').trim().toLowerCase() === channel;
            }) || null;
            await openOrderComplaintDetail(channel, orderNo, order);
          });
        });
      }

      Array.from(els.orderStatusTabs.querySelectorAll('[data-order-status]')).forEach((n) => {
        n.addEventListener('click', async () => {
          const k = String(n.getAttribute('data-order-status') || 'all').trim();
          if (k === o.status_filter) return;
          state.orders.status_filter = k;
          state.orders.page = 1;
          await loadOrders();
          renderOrdersView();
        });
      });
      Array.from(els.orderQuickFilters.querySelectorAll('[data-order-quick]')).forEach((n) => {
        n.addEventListener('click', async () => {
          const k = String(n.getAttribute('data-order-quick') || 'today').trim();
          if (k === o.quick_filter) return;
          state.orders.quick_filter = k;
          state.orders.page = 1;
          await loadOrders();
          renderOrdersView();
        });
      });

      const totalPages = Math.max(1, Math.ceil(Number(o.total || 0) / Number(o.pageSize || 20)));
      els.orderPageInfo.textContent = `第 ${o.page} / ${totalPages} 页 · 每页 ${o.pageSize} 条`;
      els.orderPrevPage.disabled = o.page <= 1;
      els.orderNextPage.disabled = o.page >= totalPages;
    }

    window.addEventListener('popstate', () => {
      if (state.currentMenu !== 'orders') return;
      if (state.orders && state.orders.complaint_detail && state.orders.complaint_detail.open) {
        state.orders.complaint_detail.preview_image_url = '';
        state.orders.complaint_detail.open = false;
        render();
      }
    });
