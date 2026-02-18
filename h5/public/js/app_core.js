    const AUTH_BUNDLE_KEY = 'h5_auth_bundle';
    const LEGACY_TOKEN_KEY = 'h5_token';
    const LEGACY_USER_KEY = 'h5_user';

    function safeParseJson(raw, fallback) {
      try {
        return JSON.parse(String(raw || ''));
      } catch (_) {
        return fallback;
      }
    }

    function loadInitialAuth() {
      const fromLocal = safeParseJson(localStorage.getItem(AUTH_BUNDLE_KEY), null);
      if (fromLocal && typeof fromLocal === 'object') {
        return {
          token: String(fromLocal.token || fromLocal.access_token || '').trim(),
          refreshToken: String(fromLocal.refresh_token || '').trim(),
          remember: true,
          user: fromLocal.user && typeof fromLocal.user === 'object' ? fromLocal.user : null
        };
      }
      const fromSession = safeParseJson(sessionStorage.getItem(AUTH_BUNDLE_KEY), null);
      if (fromSession && typeof fromSession === 'object') {
        return {
          token: String(fromSession.token || fromSession.access_token || '').trim(),
          refreshToken: String(fromSession.refresh_token || '').trim(),
          remember: false,
          user: fromSession.user && typeof fromSession.user === 'object' ? fromSession.user : null
        };
      }
      return {
        token: String(localStorage.getItem(LEGACY_TOKEN_KEY) || '').trim(),
        refreshToken: '',
        remember: true,
        user: safeParseJson(localStorage.getItem(LEGACY_USER_KEY), null)
      };
    }

    function clearAllStoredAuth() {
      localStorage.removeItem(AUTH_BUNDLE_KEY);
      sessionStorage.removeItem(AUTH_BUNDLE_KEY);
      localStorage.removeItem(LEGACY_TOKEN_KEY);
      localStorage.removeItem(LEGACY_USER_KEY);
      sessionStorage.removeItem(LEGACY_TOKEN_KEY);
      sessionStorage.removeItem(LEGACY_USER_KEY);
    }

    function showToast(msg) {
      const node = document.getElementById('toast');
      if (!node) return;
      if (toastTimer) {
        clearTimeout(toastTimer);
        toastTimer = null;
      }
      node.textContent = String(msg || '');
      node.classList.add('show');
      toastTimer = setTimeout(() => {
        node.classList.remove('show');
        toastTimer = null;
      }, 1200);
    }

    const initialAuth = loadInitialAuth();
    const SUPPORT_TOUCH_PULL = ('ontouchstart' in window) || Number(navigator.maxTouchPoints || 0) > 0;
    const ORDER_OFF_MODE_NATURAL_DAY = 'natural_day';
    const ORDER_OFF_MODE_ROLLING_24H = 'rolling_24h';
    let orderOffModeDraft = ORDER_OFF_MODE_NATURAL_DAY;

    function normalizeOrderOffMode(v, fallback = ORDER_OFF_MODE_NATURAL_DAY) {
      const text = String(v || '').trim().toLowerCase();
      if (text === ORDER_OFF_MODE_ROLLING_24H) return ORDER_OFF_MODE_ROLLING_24H;
      if (text === ORDER_OFF_MODE_NATURAL_DAY) return ORDER_OFF_MODE_NATURAL_DAY;
      return fallback;
    }

    function orderOffModeLabel(mode) {
      return normalizeOrderOffMode(mode) === ORDER_OFF_MODE_ROLLING_24H ? '滑动窗口' : '自然日';
    }

    function orderOffModeRangeText(mode) {
      return normalizeOrderOffMode(mode) === ORDER_OFF_MODE_ROLLING_24H
        ? '滑动窗口：当前时刻往前 24 小时'
        : '自然日：每天 06:00 ~ 次日 06:00';
    }

    const state = {
      token: initialAuth.token,
      refreshToken: initialAuth.refreshToken,
      rememberLogin: initialAuth.remember,
      user: initialAuth.user,
      filter: 'all',
      page: 1,
      pageSize: 20,
      total: 0,
      list: [],
      currentMenu: 'products',
      drawerOpen: false,
      pullRefresh: { dragging: false, ready: false, loading: false, startY: 0, distance: 0 },
      stats: { total_all: 0, total_blacklisted: 0, total_restricted: 0, total_renting: 0, total_paid: 0 },
      orders: {
        status_filter: 'all',
        quick_filter: 'today',
        game_name: 'WZRY',
        page: 1,
        pageSize: 20,
        total: 0,
        syncing: false,
        stats: { progress: 0, done: 0 },
        list: []
      },
      statsBoard: {
        period: 'today',
        range: { start_date: '', end_date: '' },
        summary: null,
        profitability: null,
        by_account: [],
        calendar: {
          month: '',
          start_date: '',
          end_date: '',
          total_rec_amount: 0,
          by_day: []
        },
        missing_purchase_accounts: [],
        configured_account_count: 0
      },
      authManage: {
        channels: []
      },
      userRules: {
        order_off_threshold: 3,
        order_off_mode: ORDER_OFF_MODE_NATURAL_DAY
      },
      onlineStatusMap: {},
      onlineLoadingMap: {},
      forbiddenLoadingMap: {},
      forbiddenSheet: { open: false, account: '', role_name: '', result_text: '', result_type: '', loading: false },
      moreOpsSheet: { open: false, account: '', role_name: '' },
      activeActionSheet: '',
      purchaseSheet: {
        open: false,
        account: '',
        role_name: '',
        purchase_price: '',
        purchase_date: '',
        result_text: '',
        result_type: '',
        loading: false
      },
      cardNodeMap: {}
    };
    const API_BASE = window.location.pathname.startsWith('/h5local') ? '/h5local' : '';
    let refreshPromise = null;
    let toastTimer = null;
    const GLOBAL_LOADING_MIN_MS = 250;
    let requestInFlightCount = 0;
    let requestLoadingShownAt = 0;

    function menuTitleByKey(key) {
      const k = String(key || '').trim();
      if (k === 'orders') return '订单列表';
      if (k === 'stats') return '统计看板';
      if (k === 'auth') return '授权管理';
      return '商品列表';
    }

    function showReason(reason) {
      els.overlayBody.textContent = String(reason || '').trim() || '暂无具体原因';
      els.reasonOverlay.classList.remove('hidden');
    }

    function hideReason() {
      els.reasonOverlay.classList.add('hidden');
    }

    function calcRefreshDaysByStatsPeriod(period) {
      const p = String(period || 'today').trim().toLowerCase();
      if (p === 'today') return 1;
      if (p === 'yesterday') return 2;
      if (p === 'week' || p === 'last7') return 7;
      if (p === 'last30') return 30;
      if (p === 'month') {
        const now = new Date();
        const start = new Date(now.getFullYear(), now.getMonth(), 1);
        const diff = Math.floor((now.getTime() - start.getTime()) / (24 * 3600 * 1000)) + 1;
        return Math.max(1, Math.min(60, diff));
      }
      return 3;
    }

    const els = {
      loginView: document.getElementById('loginView'),
      listView: document.getElementById('listView'),
      orderView: document.getElementById('orderView'),
      statsView: document.getElementById('statsView'),
      authView: document.getElementById('authView'),
      heroLoginView: document.getElementById('heroLoginView'),
      heroAppView: document.getElementById('heroAppView'),
      heroMenuTitle: document.getElementById('heroMenuTitle'),
      account: document.getElementById('account'),
      password: document.getElementById('password'),
      rememberLogin: document.getElementById('rememberLogin'),
      loginErr: document.getElementById('loginErr'),
      btnLogin: document.getElementById('btnLogin'),
      btnLogout: document.getElementById('btnLogout'),
      drawerUserName: document.getElementById('drawerUserName'),
      drawerOrderOffThreshold: document.getElementById('drawerOrderOffThreshold'),
      drawerOrderOffMode: document.getElementById('drawerOrderOffMode'),
      drawerOrderOffModeHelpBtn: document.getElementById('drawerOrderOffModeHelpBtn'),
      drawerOrderOffModeHelp: document.getElementById('drawerOrderOffModeHelp'),
      drawerOrderOffModeHelpText: document.getElementById('drawerOrderOffModeHelpText'),
      btnSetOrderOffThreshold: document.getElementById('btnSetOrderOffThreshold'),
      pullRefresh: document.getElementById('pullRefresh'),
      pullRefreshInner: document.getElementById('pullRefreshInner'),
      filters: document.getElementById('filters'),
      orderTotal: document.getElementById('orderTotal'),
      listContainer: document.getElementById('listContainer'),
      orderStatusTabs: document.getElementById('orderStatusTabs'),
      orderSyncNowBtn: document.getElementById('orderSyncNowBtn'),
      orderQuickFilters: document.getElementById('orderQuickFilters'),
      orderGameHint: document.getElementById('orderGameHint'),
      orderListContainer: document.getElementById('orderListContainer'),
      orderPrevPage: document.getElementById('orderPrevPage'),
      orderNextPage: document.getElementById('orderNextPage'),
      orderPageInfo: document.getElementById('orderPageInfo'),
      statsPeriods: document.getElementById('statsPeriods'),
      statsRangeText: document.getElementById('statsRangeText'),
      statsRefreshBtn: document.getElementById('statsRefreshBtn'),
      statsKpiGrid: document.getElementById('statsKpiGrid'),
      statsCalTitle: document.getElementById('statsCalTitle'),
      statsCalMonth: document.getElementById('statsCalMonth'),
      statsCalGrid: document.getElementById('statsCalGrid'),
      statsAccountTitle: document.getElementById('statsAccountTitle'),
      statsAccountList: document.getElementById('statsAccountList'),
      authChannelList: document.getElementById('authChannelList'),
      statsMissingOverlay: document.getElementById('statsMissingOverlay'),
      statsMissingList: document.getElementById('statsMissingList'),
      statsMissingClose: document.getElementById('statsMissingClose'),
      prevPage: document.getElementById('prevPage'),
      nextPage: document.getElementById('nextPage'),
      pageInfo: document.getElementById('pageInfo'),
      menuTrigger: document.getElementById('menuTrigger'),
      drawerMask: document.getElementById('drawerMask'),
      sideDrawer: document.getElementById('sideDrawer'),
      reasonOverlay: document.getElementById('reasonOverlay'),
      overlayBody: document.getElementById('overlayBody'),
      overlayClose: document.getElementById('overlayClose'),
      forbiddenSheet: document.getElementById('forbiddenSheet'),
      forbiddenSheetTitle: document.getElementById('forbiddenSheetTitle'),
      forbiddenSheetResult: document.getElementById('forbiddenSheetResult'),
      sheetEnableForbidden: document.getElementById('sheetEnableForbidden'),
      sheetDisableForbidden: document.getElementById('sheetDisableForbidden'),
      sheetCancelForbidden: document.getElementById('sheetCancelForbidden'),
      moreOpsSheet: document.getElementById('moreOpsSheet'),
      moreOpsSheetTitle: document.getElementById('moreOpsSheetTitle'),
      moreOpsForbiddenBtn: document.getElementById('moreOpsForbiddenBtn'),
      moreOpsPurchaseBtn: document.getElementById('moreOpsPurchaseBtn'),
      moreOpsCloseBtn: document.getElementById('moreOpsCloseBtn'),
      purchaseSheet: document.getElementById('purchaseSheet'),
      purchaseSheetTitle: document.getElementById('purchaseSheetTitle'),
      purchaseSheetResult: document.getElementById('purchaseSheetResult'),
      purchasePriceInput: document.getElementById('purchasePriceInput'),
      purchaseDateInput: document.getElementById('purchaseDateInput'),
      purchaseSaveBtn: document.getElementById('purchaseSaveBtn'),
      purchaseCancelBtn: document.getElementById('purchaseCancelBtn'),
      orderOffThresholdSheet: document.getElementById('orderOffThresholdSheet'),
      orderOffThresholdSheetResult: document.getElementById('orderOffThresholdSheetResult'),
      orderOffThresholdInput: document.getElementById('orderOffThresholdInput'),
      orderOffModeNatural: document.getElementById('orderOffModeNatural'),
      orderOffModeRolling: document.getElementById('orderOffModeRolling'),
      orderOffThresholdSaveBtn: document.getElementById('orderOffThresholdSaveBtn'),
      orderOffThresholdCancelBtn: document.getElementById('orderOffThresholdCancelBtn'),
      globalLoading: document.getElementById('globalLoading')
    };

    function setGlobalLoadingVisible(visible) {
      if (!els.globalLoading) return;
      els.globalLoading.classList.toggle('hidden', !visible);
    }

    function beginGlobalRequestLoading() {
      requestInFlightCount += 1;
      if (requestInFlightCount !== 1) return;
      requestLoadingShownAt = Date.now();
      setGlobalLoadingVisible(true);
    }

    async function endGlobalRequestLoading() {
      if (requestInFlightCount <= 0) return;
      requestInFlightCount -= 1;
      if (requestInFlightCount > 0) return;
      const elapsed = Date.now() - requestLoadingShownAt;
      if (elapsed < GLOBAL_LOADING_MIN_MS) {
        await new Promise((resolve) => setTimeout(resolve, GLOBAL_LOADING_MIN_MS - elapsed));
      }
      if (requestInFlightCount === 0) setGlobalLoadingVisible(false);
    }

    function closeOrderOffThresholdSheet() {
      if (!els.orderOffThresholdSheet) return;
      els.orderOffThresholdSheet.classList.add('hidden');
      if (els.orderOffThresholdSheetResult) {
        els.orderOffThresholdSheetResult.textContent = '';
        els.orderOffThresholdSheetResult.classList.remove('ok', 'err');
      }
    }

    function closeOrderOffModeHelp() {
      if (!els.drawerOrderOffModeHelp) return;
      els.drawerOrderOffModeHelp.classList.add('hidden');
    }

    function toggleOrderOffModeHelp() {
      if (!els.drawerOrderOffModeHelp) return;
      const opened = !els.drawerOrderOffModeHelp.classList.contains('hidden');
      els.drawerOrderOffModeHelp.classList.toggle('hidden', opened);
      if (!opened && els.drawerOrderOffModeHelpText) {
        els.drawerOrderOffModeHelpText.textContent = orderOffModeRangeText(state.userRules.order_off_mode);
      }
    }

    function openOrderOffThresholdSheet() {
      if (!els.orderOffThresholdSheet) return;
      if (els.orderOffThresholdInput) {
        els.orderOffThresholdInput.value = String(Number(state.userRules.order_off_threshold || 3));
      }
      const mode = normalizeOrderOffMode(state.userRules.order_off_mode, ORDER_OFF_MODE_NATURAL_DAY);
      orderOffModeDraft = mode;
      renderOrderOffModeOptions();
      if (els.orderOffThresholdSheetResult) {
        els.orderOffThresholdSheetResult.textContent = '';
        els.orderOffThresholdSheetResult.classList.remove('ok', 'err');
      }
      els.orderOffThresholdSheet.classList.remove('hidden');
    }

    function renderOrderOffModeOptions() {
      const mode = normalizeOrderOffMode(orderOffModeDraft, ORDER_OFF_MODE_NATURAL_DAY);
      if (els.orderOffModeNatural) {
        els.orderOffModeNatural.classList.toggle('active', mode === ORDER_OFF_MODE_NATURAL_DAY);
      }
      if (els.orderOffModeRolling) {
        els.orderOffModeRolling.classList.toggle('active', mode === ORDER_OFF_MODE_ROLLING_24H);
      }
    }

    async function submitOrderOffThreshold() {
      const raw = String((els.orderOffThresholdInput && els.orderOffThresholdInput.value) || '').trim();
      const n = Number(raw);
      if (!Number.isFinite(n) || n < 1 || n > 10) {
        if (els.orderOffThresholdSheetResult) {
          els.orderOffThresholdSheetResult.textContent = '请输入 1~10 的整数';
          els.orderOffThresholdSheetResult.classList.add('err');
        }
        return;
      }
      const threshold = Math.floor(n);
      const mode = normalizeOrderOffMode(orderOffModeDraft, ORDER_OFF_MODE_NATURAL_DAY);
      await request('/api/user-rules/order-off-threshold', {
        method: 'POST',
        body: JSON.stringify({ threshold, mode })
      });
      state.userRules.order_off_threshold = threshold;
      state.userRules.order_off_mode = mode;
      await loadList();
      render();
      closeOrderOffThresholdSheet();
      showToast(`已设置为${threshold}单下架（${orderOffModeLabel(mode)}）`);
    }

    function setAuth(accessToken, user, refreshToken = '', rememberLogin = state.rememberLogin) {
      state.token = String(accessToken || '').trim();
      state.user = user || null;
      state.refreshToken = String(refreshToken || '').trim();
      state.rememberLogin = Boolean(rememberLogin);
      clearAllStoredAuth();
      if (!state.token || !state.user) return;
      const payload = JSON.stringify({
        token: state.token,
        access_token: state.token,
        refresh_token: state.refreshToken,
        user: state.user
      });
      if (state.rememberLogin) {
        localStorage.setItem(AUTH_BUNDLE_KEY, payload);
      } else {
        sessionStorage.setItem(AUTH_BUNDLE_KEY, payload);
      }
    }

    function clearAuthState() {
      setAuth('', null, '', state.rememberLogin);
    }

    async function tryRefreshAccessToken() {
      if (refreshPromise) return refreshPromise;
      refreshPromise = (async () => {
        if (!state.refreshToken) {
          throw new Error('登录已过期，请重新登录');
        }
        const fullPath = `${API_BASE}/api/refresh`;
        const res = await fetch(fullPath, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            refresh_token: state.refreshToken,
            remember: Boolean(state.rememberLogin)
          })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) {
          throw new Error(data.message || '登录已过期，请重新登录');
        }
        const nextAccess = String(data.access_token || data.token || '').trim();
        const nextRefresh = String(data.refresh_token || '').trim();
        const nextUser = data.user || state.user || null;
        setAuth(nextAccess, nextUser, nextRefresh, state.rememberLogin);
      })();
      try {
        await refreshPromise;
      } finally {
        refreshPromise = null;
      }
    }

    async function request(path, options = {}, triedRefresh = false) {
      beginGlobalRequestLoading();
      try {
        const headers = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
        if (state.token) headers.Authorization = `Bearer ${state.token}`;
        const fullPath = `${API_BASE}${path}`;
        const fetchOptions = Object.assign({}, options, { headers });
        let res = await fetch(fullPath, fetchOptions);
        if (res.status === 401 && !triedRefresh && path !== '/api/login' && path !== '/api/refresh') {
          try {
            await tryRefreshAccessToken();
          } catch (refreshErr) {
            clearAuthState();
            render();
            throw refreshErr;
          }
          const retryHeaders = Object.assign({ 'Content-Type': 'application/json' }, options.headers || {});
          if (state.token) retryHeaders.Authorization = `Bearer ${state.token}`;
          res = await fetch(fullPath, Object.assign({}, options, { headers: retryHeaders }));
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.ok === false) {
          throw new Error(data.message || `请求失败(${res.status})`);
        }
        return data;
      } finally {
        await endGlobalRequestLoading();
      }
    }

    async function login() {
      els.loginErr.textContent = '';
      const account = els.account.value.trim();
      const password = els.password.value;
      const remember = Boolean(els.rememberLogin && els.rememberLogin.checked);
      if (!account || !password) {
        els.loginErr.textContent = '账号和密码不能为空';
        return;
      }
      try {
        const data = await request('/api/login', {
          method: 'POST',
          body: JSON.stringify({ account, password, remember })
        });
        setAuth(
          String(data.access_token || data.token || '').trim(),
          data.user || null,
          String(data.refresh_token || '').trim(),
          remember
        );
        state.page = 1;
        await loadOrderOffThresholdRule();
        await loadList();
        render();
      } catch (e) {
        els.loginErr.textContent = e.message;
      }
    }

    async function loadList() {
      const data = await request(`/api/products?page=${state.page}&page_size=${state.pageSize}&filter=${state.filter}`);
      state.list = Array.isArray(data.list) ? data.list : [];
      state.total = Number(data.total || 0);
      state.stats = data.stats || { total_all: 0, total_blacklisted: 0, total_restricted: 0, total_renting: 0, total_paid: 0 };
    }

    async function loadOrders() {
      const o = state.orders || {};
      const data = await request(`/api/orders?page=${o.page}&page_size=${o.pageSize}&status_filter=${o.status_filter}&quick_filter=${o.quick_filter}&game_name=${encodeURIComponent(o.game_name || 'WZRY')}`);
      state.orders.total = Number(data.total || 0);
      state.orders.list = Array.isArray(data.list) ? data.list : [];
      state.orders.stats = data.stats || { progress: 0, done: 0, done_zero: 0, today_total: 0 };
      state.orders.page = Number(data.page || o.page || 1);
      state.orders.pageSize = Number(data.page_size || o.pageSize || 20);
    }

    async function loadStatsBoard() {
      const s = state.statsBoard || {};
      const period = String(s.period || 'today').trim();
      const data = await request(`/api/stats/dashboard?period=${encodeURIComponent(period)}&game_name=WZRY`);
      state.statsBoard = {
        period: String(data.period || period),
        range: data.range || { start_date: '', end_date: '' },
        summary: data.summary || null,
        profitability: data.profitability || null,
        by_account: Array.isArray(data.by_account) ? data.by_account : [],
        calendar: (state.statsBoard && state.statsBoard.calendar) || {
          month: '',
          start_date: '',
          end_date: '',
          total_rec_amount: 0,
          by_day: []
        },
        missing_purchase_accounts: Array.isArray(data.missing_purchase_accounts) ? data.missing_purchase_accounts : [],
        configured_account_count: Number(data.configured_account_count || 0)
      };
    }

    async function loadAuthManage() {
      const data = await request('/api/auth/platforms');
      const channels = Array.isArray(data.data) ? data.data : [];
      state.authManage = { channels };
    }

    async function loadOrderOffThresholdRule() {
      const data = await request('/api/user-rules/order-off-threshold');
      const v = Number(data.threshold || 3);
      state.userRules.order_off_threshold = Number.isFinite(v) ? Math.max(1, Math.min(10, Math.floor(v))) : 3;
      state.userRules.order_off_mode = normalizeOrderOffMode(data.mode, ORDER_OFF_MODE_NATURAL_DAY);
    }
    function renderDrawer() {
      const opened = Boolean(state.drawerOpen);
      els.drawerMask.classList.toggle('hidden', !opened);
      els.sideDrawer.classList.toggle('hidden', !opened);
      els.sideDrawer.setAttribute('aria-hidden', opened ? 'false' : 'true');
      Array.from(document.querySelectorAll('.drawer-item')).forEach((n) => {
        const k = String(n.getAttribute('data-menu') || '').trim();
        const active = k === state.currentMenu;
        const baseLabel = String(n.getAttribute('data-label') || n.textContent || '').trim();
        n.classList.toggle('active', active);
        n.textContent = active ? `${baseLabel}（当前）` : baseLabel;
      });
    }

    function openDrawer() {
      state.drawerOpen = true;
      renderDrawer();
    }

    function closeDrawer() {
      state.drawerOpen = false;
      closeOrderOffModeHelp();
      renderDrawer();
    }

    function renderAuthView() {
      const listNode = els.authChannelList;
      if (!listNode) return;
      const channels = (state.authManage && Array.isArray(state.authManage.channels))
        ? state.authManage.channels
        : [];
      if (channels.length === 0) {
        listNode.innerHTML = '<div class="panel auth-empty">暂无渠道配置</div>';
        return;
      }

      listNode.innerHTML = channels.map((c) => {
        const name = String((c && c.name) || '').trim() || '-';
        const mode = String((c && c.mode) || '').trim() || '-';
        const platform = String((c && c.platform) || '').trim() || '';
        const authorized = Boolean(c && c.authorized);
        const statusText = authorized ? '已授权' : '未授权';
        const actionText = String((c && c.button_text) || (authorized ? '修改授权' : '新增授权'));
        const keyValues = Array.isArray(c && c.key_values) ? c.key_values : [];
        const keyHtml = keyValues.map((kv) => {
          const key = String((kv && kv.key) || '').trim();
          const masked = String((kv && kv.masked_value) || '').trim() || '空';
          return `<div class="auth-kv-row"><span class="auth-kv-key">${key}</span><span class="auth-kv-val">${masked}</span></div>`;
        }).join('');
        return `
          <div class="auth-channel-card">
            <div class="auth-channel-head">
              <div>
                <p class="auth-channel-name">${name}</p>
                <p class="auth-channel-mode">${mode}</p>
              </div>
              <span class="auth-status ${authorized ? 'ok' : 'empty'}">${statusText}</span>
            </div>
            <div class="auth-kv-list">${keyHtml}</div>
            <div class="auth-op-row">
              <button class="btn btn-ghost auth-op-btn" data-op="auth-edit" data-platform="${platform}">${actionText}</button>
            </div>
          </div>
        `;
      }).join('');
    }

    function render() {
      const loggedIn = Boolean(state.token && state.user);
      els.loginView.classList.toggle('hidden', loggedIn);
      const showProducts = loggedIn && state.currentMenu === 'products';
      const showOrders = loggedIn && state.currentMenu === 'orders';
      const showStats = loggedIn && state.currentMenu === 'stats';
      const showAuth = loggedIn && state.currentMenu === 'auth';
      els.listView.classList.toggle('hidden', !showProducts);
      els.orderView.classList.toggle('hidden', !showOrders);
      els.statsView.classList.toggle('hidden', !showStats);
      els.authView.classList.toggle('hidden', !showAuth);
      els.heroLoginView.classList.toggle('hidden', loggedIn);
      els.heroAppView.classList.toggle('hidden', !loggedIn);
      els.heroMenuTitle.textContent = menuTitleByKey(state.currentMenu);
      if (els.rememberLogin) {
        els.rememberLogin.checked = Boolean(state.rememberLogin);
      }
      if (loggedIn) {
        els.drawerUserName.textContent = `当前用户：${state.user.name || state.user.account}`;
        if (els.drawerOrderOffThreshold) {
          els.drawerOrderOffThreshold.textContent = `• 阈值：${Number(state.userRules.order_off_threshold || 3)}单`;
        }
        if (els.drawerOrderOffMode) {
          const modeText = orderOffModeLabel(state.userRules.order_off_mode);
          els.drawerOrderOffMode.innerHTML = `• 统计周期：${modeText} <button id="drawerOrderOffModeHelpBtn" class="drawer-help-btn" aria-label="查看下架模式时间范围说明" type="button">?</button>`;
          const btn = document.getElementById('drawerOrderOffModeHelpBtn');
          if (btn) {
            btn.addEventListener('click', (e) => {
              e.stopPropagation();
              toggleOrderOffModeHelp();
            });
          }
        }
        if (els.drawerOrderOffModeHelpText) {
          els.drawerOrderOffModeHelpText.textContent = orderOffModeRangeText(state.userRules.order_off_mode);
        }
        if (showProducts) renderList();
        if (showOrders) renderOrdersView();
        if (showStats) renderStatsView();
        if (showAuth) renderAuthView();
        renderDrawer();
        renderMoreOpsSheet();
        renderForbiddenSheet();
        renderPurchaseSheet();
        if (!showStats) els.statsMissingOverlay.classList.add('hidden');
        if (showProducts) updatePullRefreshUi();
      } else {
        els.drawerUserName.textContent = '当前用户：-';
        if (els.drawerOrderOffThreshold) {
          els.drawerOrderOffThreshold.textContent = '• 阈值：-';
        }
        if (els.drawerOrderOffMode) {
          els.drawerOrderOffMode.innerHTML = '• 统计周期：自然日 <button id="drawerOrderOffModeHelpBtn" class="drawer-help-btn" aria-label="查看下架模式时间范围说明" type="button">?</button>';
          const btn = document.getElementById('drawerOrderOffModeHelpBtn');
          if (btn) {
            btn.addEventListener('click', (e) => {
              e.stopPropagation();
              toggleOrderOffModeHelp();
            });
          }
        }
        closeActionSheets();
        closePurchaseSheet();
        closeOrderOffThresholdSheet();
        closeOrderOffModeHelp();
        els.statsMissingOverlay.classList.add('hidden');
        resetPullRefreshUi();
      }
    }

    els.btnLogin.addEventListener('click', login);
    els.btnLogout.addEventListener('click', () => {
      closeDrawer();
      clearAuthState();
      state.list = [];
      state.total = 0;
      state.page = 1;
      state.currentMenu = 'products';
      state.drawerOpen = false;
      state.onlineStatusMap = {};
      state.onlineLoadingMap = {};
      state.forbiddenLoadingMap = {};
      state.forbiddenSheet = { open: false, account: '', role_name: '', result_text: '', result_type: '', loading: false };
      state.moreOpsSheet = { open: false, account: '', role_name: '' };
      state.activeActionSheet = '';
      state.purchaseSheet = {
        open: false,
        account: '',
        role_name: '',
        purchase_price: '',
        purchase_date: '',
        result_text: '',
        result_type: '',
        loading: false
      };
      state.cardNodeMap = {};
      state.pullRefresh = { dragging: false, ready: false, loading: false, startY: 0, distance: 0 };
      state.statsBoard = {
        period: 'today',
        range: { start_date: '', end_date: '' },
        summary: null,
        profitability: null,
        by_account: [],
        calendar: {
          month: '',
          start_date: '',
          end_date: '',
          total_rec_amount: 0,
          by_day: []
        },
        missing_purchase_accounts: [],
        configured_account_count: 0
      };
      state.authManage = { channels: [] };
      state.userRules = {
        order_off_threshold: 3,
        order_off_mode: ORDER_OFF_MODE_NATURAL_DAY
      };
      state.orders.syncing = false;
      render();
    });

    if (els.btnSetOrderOffThreshold) {
      els.btnSetOrderOffThreshold.addEventListener('click', () => openOrderOffThresholdSheet());
    }
    if (els.orderOffThresholdSaveBtn) {
      els.orderOffThresholdSaveBtn.addEventListener('click', async () => {
        try {
          await submitOrderOffThreshold();
        } catch (e) {
          if (els.orderOffThresholdSheetResult) {
            els.orderOffThresholdSheetResult.textContent = e.message || '阈值设置失败';
            els.orderOffThresholdSheetResult.classList.add('err');
          }
        }
      });
    }
    if (els.orderOffThresholdCancelBtn) {
      els.orderOffThresholdCancelBtn.addEventListener('click', () => closeOrderOffThresholdSheet());
    }
    if (els.orderOffThresholdSheet) {
      els.orderOffThresholdSheet.addEventListener('click', (e) => {
        if (e.target === els.orderOffThresholdSheet) closeOrderOffThresholdSheet();
      });
    }
    if (els.orderOffModeNatural) {
      els.orderOffModeNatural.addEventListener('click', () => {
        orderOffModeDraft = ORDER_OFF_MODE_NATURAL_DAY;
        renderOrderOffModeOptions();
      });
    }
    if (els.orderOffModeRolling) {
      els.orderOffModeRolling.addEventListener('click', () => {
        orderOffModeDraft = ORDER_OFF_MODE_ROLLING_24H;
        renderOrderOffModeOptions();
      });
    }
    document.addEventListener('click', (e) => {
      const helpBtn = document.getElementById('drawerOrderOffModeHelpBtn');
      if (!els.drawerOrderOffModeHelp || !helpBtn) return;
      const t = e.target;
      if (els.drawerOrderOffModeHelp.contains(t) || helpBtn.contains(t)) return;
      closeOrderOffModeHelp();
    });

    els.prevPage.addEventListener('click', async () => {
      if (state.page <= 1) return;
      state.page -= 1;
      await loadList();
      renderList();
    });

    els.nextPage.addEventListener('click', async () => {
      const totalPages = Math.max(1, Math.ceil(state.total / state.pageSize));
      if (state.page >= totalPages) return;
      state.page += 1;
      await loadList();
      renderList();
    });

    els.orderPrevPage.addEventListener('click', async () => {
      if (state.orders.page <= 1) return;
      state.orders.page -= 1;
      await loadOrders();
      renderOrdersView();
    });

    els.orderNextPage.addEventListener('click', async () => {
      const totalPages = Math.max(1, Math.ceil(Number(state.orders.total || 0) / Number(state.orders.pageSize || 20)));
      if (state.orders.page >= totalPages) return;
      state.orders.page += 1;
      await loadOrders();
      renderOrdersView();
    });

    if (els.orderSyncNowBtn) {
      els.orderSyncNowBtn.addEventListener('click', async () => {
        if (state.orders.syncing) return;
        state.orders.syncing = true;
        renderOrdersView();
        try {
          await request('/api/orders/sync', { method: 'POST', body: '{}' });
          await loadOrders();
          renderOrdersView();
          showToast('订单已同步');
        } catch (e) {
          showToast(e.message || '订单同步失败');
        } finally {
          state.orders.syncing = false;
          renderOrdersView();
        }
      });
    }

    els.overlayClose.addEventListener('click', hideReason);
    els.reasonOverlay.addEventListener('click', (e) => {
      if (e.target === els.reasonOverlay) hideReason();
    });
    els.sheetEnableForbidden.addEventListener('click', () => submitForbidden(true));
    els.sheetDisableForbidden.addEventListener('click', () => submitForbidden(false));
    els.sheetCancelForbidden.addEventListener('click', () => closeForbiddenSheet());
    els.forbiddenSheet.addEventListener('click', (e) => {
      if (e.target === els.forbiddenSheet) closeForbiddenSheet();
    });
    els.moreOpsForbiddenBtn.addEventListener('click', () => {
      const account = String((state.moreOpsSheet || {}).account || '').trim();
      if (!account) return;
      const item = (state.list || []).find((x) => String((x && x.game_account) || '').trim() === account);
      if (!item) return;
      closeMoreOpsSheet();
      openForbiddenSheet(item);
    });
    els.moreOpsPurchaseBtn.addEventListener('click', () => {
      const account = String((state.moreOpsSheet || {}).account || '').trim();
      if (!account) return;
      const item = (state.list || []).find((x) => String((x && x.game_account) || '').trim() === account);
      if (!item) return;
      closeMoreOpsSheet();
      openPurchaseSheet(item);
    });
    els.moreOpsCloseBtn.addEventListener('click', () => closeMoreOpsSheet());
    els.moreOpsSheet.addEventListener('click', (e) => {
      if (e.target === els.moreOpsSheet) closeMoreOpsSheet();
    });
    els.purchaseSaveBtn.addEventListener('click', () => submitPurchaseConfig());
    els.purchaseCancelBtn.addEventListener('click', () => closePurchaseSheet());
    els.purchaseSheet.addEventListener('click', (e) => {
      if (e.target === els.purchaseSheet) closePurchaseSheet();
    });
    els.statsMissingClose.addEventListener('click', () => {
      els.statsMissingOverlay.classList.add('hidden');
    });
    els.statsMissingOverlay.addEventListener('click', (e) => {
      if (e.target === els.statsMissingOverlay) {
        els.statsMissingOverlay.classList.add('hidden');
      }
    });
    els.statsRefreshBtn.addEventListener('click', async () => {
      try {
        const days = calcRefreshDaysByStatsPeriod(state.statsBoard.period);
        await request('/api/stats/refresh', {
          method: 'POST',
          body: JSON.stringify({ days, game_name: 'WZRY' })
        });
        await loadStatsBoard();
        if (typeof loadStatsCalendar === 'function') {
          await loadStatsCalendar((state.statsBoard.calendar && state.statsBoard.calendar.month) || '');
        }
        renderStatsView();
        showToast('统计已刷新');
      } catch (e) {
        alert(e.message || '统计刷新失败');
      }
    });
    if (els.authChannelList) {
      els.authChannelList.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('[data-op="auth-edit"]') : null;
        if (!btn) return;
        const platform = String(btn.getAttribute('data-platform') || '').trim();
        if (!platform) return;
        showToast(`${platform} 授权功能开发中`);
      });
    }

    els.menuTrigger.addEventListener('click', openDrawer);
    els.drawerMask.addEventListener('click', closeDrawer);
    Array.from(document.querySelectorAll('.drawer-item')).forEach((n) => {
      n.addEventListener('click', () => {
        const key = String(n.getAttribute('data-menu') || '').trim();
        state.currentMenu = key || 'products';
        closeActionSheets();
        closeDrawer();
        if (key === 'products') {
          render();
          return;
        }
        if (key === 'orders') {
          render();
          (async () => {
            try {
              await loadOrders();
              render();
            } catch (e) {
              showToast(e.message || '订单列表加载失败');
            }
          })();
          return;
        }
        if (key === 'stats') {
          render();
          (async () => {
            try {
              await loadStatsBoard();
              if (typeof loadStatsCalendar === 'function') {
                await loadStatsCalendar((state.statsBoard.calendar && state.statsBoard.calendar.month) || '');
              }
              render();
            } catch (e) {
              showToast(e.message || '统计看板加载失败');
            }
          })();
          return;
        }
        if (key === 'auth') {
          render();
          (async () => {
            try {
              await loadAuthManage();
              render();
            } catch (e) {
              showToast(e.message || '授权列表加载失败');
            }
          })();
          return;
        }
        render();
        alert('该功能正在开发中');
      });
    });

    window.addEventListener('touchstart', (e) => {
      if (!SUPPORT_TOUCH_PULL) return;
      if (!(state.token && state.user)) return;
      if (
        state.pullRefresh.loading ||
        state.drawerOpen ||
        (state.moreOpsSheet && state.moreOpsSheet.open) ||
        (state.forbiddenSheet && state.forbiddenSheet.open) ||
        (state.purchaseSheet && state.purchaseSheet.open)
      ) return;
      if (window.scrollY > 0) return;
      const t = e.touches && e.touches[0];
      if (!t) return;
      state.pullRefresh.dragging = true;
      state.pullRefresh.ready = false;
      state.pullRefresh.startY = Number(t.clientY || 0);
      state.pullRefresh.distance = 0;
      updatePullRefreshUi();
    }, { passive: true });

    window.addEventListener('touchmove', (e) => {
      if (!SUPPORT_TOUCH_PULL) return;
      const pr = state.pullRefresh;
      if (!pr.dragging || pr.loading) return;
      const t = e.touches && e.touches[0];
      if (!t) return;
      const delta = Number(t.clientY || 0) - Number(pr.startY || 0);
      if (delta <= 0) {
        pr.distance = 0;
        pr.ready = false;
        updatePullRefreshUi();
        return;
      }
      if (window.scrollY > 0) {
        resetPullRefreshUi();
        return;
      }
      e.preventDefault();
      const dist = Math.min(90, delta * 0.55);
      pr.distance = dist;
      pr.ready = dist >= 62;
      updatePullRefreshUi();
    }, { passive: false });

    window.addEventListener('touchend', async () => {
      if (!SUPPORT_TOUCH_PULL) return;
      const pr = state.pullRefresh;
      if (!pr.dragging || pr.loading) return;
      const shouldRefresh = Boolean(pr.ready);
      resetPullRefreshUi();
      if (shouldRefresh) await triggerPullRefresh();
    }, { passive: true });

    window.__bootH5App = async () => {
      if (state.user && !state.token && state.refreshToken) {
        try {
          await tryRefreshAccessToken();
        } catch {
          clearAuthState();
        }
      }
      if (state.token && state.user) {
        try {
          await loadOrderOffThresholdRule();
          await loadList();
          await loadOrders();
          await loadStatsBoard();
        } catch {
          clearAuthState();
        }
      }
      render();
    };

    window.addEventListener('DOMContentLoaded', () => {
      if (typeof window.__bootH5App === 'function') {
        window.__bootH5App().catch((e) => {
          // eslint-disable-next-line no-console
          console.error('[h5] boot failed:', e);
        });
      }
    });
