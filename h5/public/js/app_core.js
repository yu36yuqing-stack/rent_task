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

    function todayDateText() {
      const d = new Date();
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }

    const state = {
      token: initialAuth.token,
      refreshToken: initialAuth.refreshToken,
      rememberLogin: initialAuth.remember,
      user: initialAuth.user,
      filter: 'all',
      product_game_name: 'WZRY',
      productsSyncing: false,
      page: 1,
      pageSize: 20,
      total: 0,
      list: [],
      currentMenu: 'products',
      drawerExpandedGroups: { pricing: false },
      drawerOpen: false,
      pullRefresh: { dragging: false, ready: false, loading: false, startY: 0, distance: 0 },
      stats: {
        total_all: 0,
        master_total: 0,
        sync_effective_total: 0,
        total_blacklisted: 0,
        total_restricted: 0,
        total_renting: 0,
        total_paid: 0,
        sync_anomaly_count: 0,
        sync_anomaly_text: ''
      },
      orders: {
        status_filter: 'all',
        quick_filter: 'today',
        game_name: 'WZRY',
        page: 1,
        pageSize: 20,
        total: 0,
        syncing: false,
        stats: { progress: 0, done: 0 },
        list: [],
        complaint_detail: {
          open: false,
          loading: false,
          error: '',
          order_no: '',
          channel: '',
          order: null,
          data: null,
          preview_image_url: ''
        },
        detail_view: {
          open: false,
          loading: false,
          error: '',
          order_no: '',
          channel: '',
          order: null,
          detail: null
        }
      },
      statsBoard: {
        game_name: '全部',
        period: 'week',
        selected_date: '',
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
      statsCostDetail: {
        open: false,
        loading: false,
        deleting: false,
        game_account: '',
        game_name: 'WZRY',
        display_name: '',
        total_cost_amount: 0,
        purchase_cost_amount: 0,
        list: [],
        error: ''
      },
      riskCenter: {
        status: 'all',
        risk_type: '',
        page: 1,
        pageSize: 20,
        total: 0,
        list: [],
        loading: false
      },
      authManage: {
        channels: [],
        rows: []
      },
      board: {
        loading: false,
        query: '',
        filter: 'all',
        summary: {
          board_count: 0,
          mobile_count: 0,
          account_count: 0
        },
        list: [],
        smsSheet: {
          open: false,
          sending: false,
          board_id: 0,
          board_name: '',
          mobile_id: 0,
          mobile: '',
          recipient: '',
          content: '',
          result_text: '',
          result_type: ''
        },
        createSheet: {
          open: false,
          saving: false,
          board_name: '',
          board_ip: '',
          result_text: '',
          result_type: ''
        },
        mobileSlotSheet: {
          open: false,
          saving: false,
          board_id: 0,
          board_name: '',
          slot_index: '',
          mobile: '',
          result_text: '',
          result_type: ''
        },
        mobileAccountSheet: {
          open: false,
          saving: false,
          board_id: 0,
          mobile_slot_id: 0,
          mobile: '',
          account: '',
          result_text: '',
          result_type: ''
        },
        smsRecordSheet: {
          open: false,
          loading: false,
          mobile_slot_id: 0,
          title: '',
          result_text: '',
          result_type: '',
          list: []
        }
      },
      authEditor: {
        open: false,
        platform: '',
        title: '',
        saving: false,
        error: ''
      },
      authCookieEditor: {
        open: false,
        platform: '',
        title: '',
        saving: '',
        error: ''
      },
      userRules: {
        order_off_threshold: 3,
        order_off_mode: ORDER_OFF_MODE_NATURAL_DAY,
        cooldown_release_delay_min: 10
      },
      profile: {
        loading: false,
        notify_saving: false,
        order_off_saving: false,
        order_cooldown_saving: false,
        notify: {
          at_mode: 'none',
          at_mobiles: []
        },
        order_off: {
          threshold: 3,
          mode: ORDER_OFF_MODE_NATURAL_DAY
        },
        order_cooldown: {
          release_delay_min: 10
        }
      },
      pricing: {
        loading: false,
        publishing: false,
        channel: 'uhaozu',
        game_name: 'WZRY',
        form: {
          payback_days: 210,
          avg_daily_rent_hours: 3.5,
          platform_fee_rate: 0.2,
          withdrawal_fee_rate: 0.02,
          price_step: 0.5,
          deposit: 100
        },
        summary: {
          account_count: 0,
          zero_cost_count: 0,
          total_cost_amount: 0,
          avg_suggested_listing_hourly_price: 0
        },
        list: [],
        error: '',
        loaded_once: false
      },
      onlineStatusMap: {},
      onlineLoadingMap: {},
      forbiddenLoadingMap: {},
      forbiddenSheet: {
        open: false,
        account: '',
        game_id: '1',
        game_name: 'WZRY',
        role_name: '',
        result_text: '',
        result_type: '',
        loading: false,
        query_loading: false,
        query_status: '',
        query_text: ''
      },
      moreOpsSheet: { open: false, account: '', game_id: '1', game_name: 'WZRY', role_name: '', maintenance_enabled: false, maintenance_loading: false, prod_guard_enabled: true, prod_guard_loading: false },
      activeActionSheet: '',
      purchaseSheet: {
        open: false,
        account: '',
        game_id: '1',
        game_name: 'WZRY',
        role_name: '',
        purchase_price: '',
        purchase_date: '',
        result_text: '',
        result_type: '',
        loading: false
      },
      costSheet: {
        open: false,
        account: '',
        game_id: '1',
        game_name: 'WZRY',
        role_name: '',
        cost_amount: '',
        cost_date: '',
        cost_desc: '',
        result_text: '',
        result_type: '',
        loading: false
      },
      pricingCostSheet: {
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
      if (k === 'risk') return '风控中心';
      if (k === 'stats') return '统计看板';
      if (k === 'auth') return '授权管理';
      if (k === 'pricing_uhaozu') return '定价规则 · U号租';
      if (k === 'pricing_uuzuhao') return '定价规则 · 悠悠租号';
      if (k === 'pricing_zuhaowang') return '定价规则 · 租号王';
      if (k === 'board') return '板卡管理';
      if (k === 'profile') return '个人中心';
      return '商品列表';
    }

    function pricingChannelFromMenu(key) {
      const k = String(key || '').trim();
      if (k === 'pricing_uuzuhao') return 'uuzuhao';
      if (k === 'pricing_zuhaowang') return 'zuhaowang';
      return 'uhaozu';
    }

    function parseInitialRouteFromUrl() {
      try {
        const url = new URL(window.location.href);
        const m = String(url.searchParams.get('menu') || '').trim().toLowerCase();
        if (m === 'pricing_uhaozu' || m === 'pricing_uuzuhao' || m === 'pricing_zuhaowang') {
          return { menu: m, pricingChannel: pricingChannelFromMenu(m) };
        }
        if (m === 'orders' || m === 'risk' || m === 'stats' || m === 'auth' || m === 'board' || m === 'profile' || m === 'products') {
          return { menu: m, pricingChannel: 'uhaozu' };
        }
      } catch (_) {}
      return { menu: 'products', pricingChannel: 'uhaozu' };
    }

    function showReason(reason) {
      els.overlayBody.textContent = String(reason || '').trim() || '暂无具体原因';
      els.reasonOverlay.classList.remove('hidden');
    }

    function hideReason() {
      els.reasonOverlay.classList.add('hidden');
    }

    const els = {
      loginView: document.getElementById('loginView'),
      listView: document.getElementById('listView'),
      orderView: document.getElementById('orderView'),
      riskView: document.getElementById('riskView'),
      orderComplaintView: document.getElementById('orderComplaintView'),
      statsView: document.getElementById('statsView'),
      authView: document.getElementById('authView'),
      pricingView: document.getElementById('pricingView'),
      pricingGameTabs: document.getElementById('pricingGameTabs'),
      pricingFormulaHelpBtn: document.getElementById('pricingFormulaHelpBtn'),
      pricingFormulaHelp: document.getElementById('pricingFormulaHelp'),
      pricingCalcBtn: document.getElementById('pricingCalcBtn'),
      pricingPublishBtn: document.getElementById('pricingPublishBtn'),
      pricingPaybackDays: document.getElementById('pricingPaybackDays'),
      pricingAvgDailyRentHours: document.getElementById('pricingAvgDailyRentHours'),
      pricingPlatformFeeRate: document.getElementById('pricingPlatformFeeRate'),
      pricingWithdrawalFeeRate: document.getElementById('pricingWithdrawalFeeRate'),
      pricingPriceStep: document.getElementById('pricingPriceStep'),
      pricingDeposit: document.getElementById('pricingDeposit'),
      pricingMetricGrid: document.getElementById('pricingMetricGrid'),
      pricingListContainer: document.getElementById('pricingListContainer'),
      boardView: document.getElementById('boardView'),
      profileView: document.getElementById('profileView'),
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
      productGameTabs: document.getElementById('productGameTabs'),
      filters: document.getElementById('filters'),
      productSyncNowBtn: document.getElementById('productSyncNowBtn'),
      orderTotal: document.getElementById('orderTotal'),
      listContainer: document.getElementById('listContainer'),
      orderGameTabs: document.getElementById('orderGameTabs'),
      orderStatusTabs: document.getElementById('orderStatusTabs'),
      orderSyncNowBtn: document.getElementById('orderSyncNowBtn'),
      orderQuickFilters: document.getElementById('orderQuickFilters'),
      orderGameHint: document.getElementById('orderGameHint'),
      orderListContainer: document.getElementById('orderListContainer'),
      riskStatusTabs: document.getElementById('riskStatusTabs'),
      riskRefreshBtn: document.getElementById('riskRefreshBtn'),
      riskListContainer: document.getElementById('riskListContainer'),
      riskPrevPage: document.getElementById('riskPrevPage'),
      riskNextPage: document.getElementById('riskNextPage'),
      riskPageInfo: document.getElementById('riskPageInfo'),
      orderComplaintBackBtn: document.getElementById('orderComplaintBackBtn'),
      orderComplaintContainer: document.getElementById('orderComplaintContainer'),
      orderDetailView: document.getElementById('orderDetailView'),
      orderDetailBackBtn: document.getElementById('orderDetailBackBtn'),
      orderDetailContainer: document.getElementById('orderDetailContainer'),
      orderPrevPage: document.getElementById('orderPrevPage'),
      orderNextPage: document.getElementById('orderNextPage'),
      orderPageInfo: document.getElementById('orderPageInfo'),
      statsGameTabs: document.getElementById('statsGameTabs'),
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
      boardAddBtn: document.getElementById('boardAddBtn'),
      boardSearchInput: document.getElementById('boardSearchInput'),
      boardFilterTabs: document.getElementById('boardFilterTabs'),
      boardSummaryText: document.getElementById('boardSummaryText'),
      boardListContainer: document.getElementById('boardListContainer'),
      profileAtMode: document.getElementById('profileAtMode'),
      profileAtModeNone: document.getElementById('profileAtModeNone'),
      profileAtModeOwner: document.getElementById('profileAtModeOwner'),
      profileAtModeAll: document.getElementById('profileAtModeAll'),
      profileAtMobiles: document.getElementById('profileAtMobiles'),
      profileNotifySaveBtn: document.getElementById('profileNotifySaveBtn'),
      profileOrderOffThreshold: document.getElementById('profileOrderOffThreshold'),
      profileOrderOffMode: document.getElementById('profileOrderOffMode'),
      profileOrderOffModeNatural: document.getElementById('profileOrderOffModeNatural'),
      profileOrderOffModeRolling: document.getElementById('profileOrderOffModeRolling'),
      profileOrderOffSaveBtn: document.getElementById('profileOrderOffSaveBtn'),
      profileCooldownReleaseDelay: document.getElementById('profileCooldownReleaseDelay'),
      profileCooldownSaveBtn: document.getElementById('profileCooldownSaveBtn'),
      statsMissingOverlay: document.getElementById('statsMissingOverlay'),
      statsMissingList: document.getElementById('statsMissingList'),
      statsMissingClose: document.getElementById('statsMissingClose'),
      statsCostDetailSheet: document.getElementById('statsCostDetailSheet'),
      statsCostDetailTitle: document.getElementById('statsCostDetailTitle'),
      statsCostDetailSummary: document.getElementById('statsCostDetailSummary'),
      statsCostDetailList: document.getElementById('statsCostDetailList'),
      statsCostDetailClose: document.getElementById('statsCostDetailClose'),
      boardSmsSheet: document.getElementById('boardSmsSheet'),
      boardSmsSheetTitle: document.getElementById('boardSmsSheetTitle'),
      boardSmsSheetResult: document.getElementById('boardSmsSheetResult'),
      boardSmsSender: document.getElementById('boardSmsSender'),
      boardSmsRecipient: document.getElementById('boardSmsRecipient'),
      boardSmsContent: document.getElementById('boardSmsContent'),
      boardSmsSendBtn: document.getElementById('boardSmsSendBtn'),
      boardSmsCloseBtn: document.getElementById('boardSmsCloseBtn'),
      boardCreateSheet: document.getElementById('boardCreateSheet'),
      boardCreateSheetResult: document.getElementById('boardCreateSheetResult'),
      boardCreateName: document.getElementById('boardCreateName'),
      boardCreateIp: document.getElementById('boardCreateIp'),
      boardCreateSaveBtn: document.getElementById('boardCreateSaveBtn'),
      boardCreateCloseBtn: document.getElementById('boardCreateCloseBtn'),
      boardMobileSlotSheet: document.getElementById('boardMobileSlotSheet'),
      boardMobileSlotSheetTitle: document.getElementById('boardMobileSlotSheetTitle'),
      boardMobileSlotSheetResult: document.getElementById('boardMobileSlotSheetResult'),
      boardMobileSlotMobile: document.getElementById('boardMobileSlotMobile'),
      boardMobileSlotIndex: document.getElementById('boardMobileSlotIndex'),
      boardMobileSlotSaveBtn: document.getElementById('boardMobileSlotSaveBtn'),
      boardMobileSlotCloseBtn: document.getElementById('boardMobileSlotCloseBtn'),
      boardMobileAccountSheet: document.getElementById('boardMobileAccountSheet'),
      boardMobileAccountSheetTitle: document.getElementById('boardMobileAccountSheetTitle'),
      boardMobileAccountSheetResult: document.getElementById('boardMobileAccountSheetResult'),
      boardMobileAccountValue: document.getElementById('boardMobileAccountValue'),
      boardMobileAccountSaveBtn: document.getElementById('boardMobileAccountSaveBtn'),
      boardMobileAccountCloseBtn: document.getElementById('boardMobileAccountCloseBtn'),
      boardSmsRecordSheet: document.getElementById('boardSmsRecordSheet'),
      boardSmsRecordSheetTitle: document.getElementById('boardSmsRecordSheetTitle'),
      boardSmsRecordSheetResult: document.getElementById('boardSmsRecordSheetResult'),
      boardSmsRecordList: document.getElementById('boardSmsRecordList'),
      boardSmsRecordCloseBtn: document.getElementById('boardSmsRecordCloseBtn'),
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
      forbiddenSheetQueryResult: document.getElementById('forbiddenSheetQueryResult'),
      forbiddenSheetResult: document.getElementById('forbiddenSheetResult'),
      sheetQueryForbidden: document.getElementById('sheetQueryForbidden'),
      sheetEnableForbidden: document.getElementById('sheetEnableForbidden'),
      sheetDisableForbidden: document.getElementById('sheetDisableForbidden'),
      sheetCancelForbidden: document.getElementById('sheetCancelForbidden'),
      moreOpsSheet: document.getElementById('moreOpsSheet'),
      moreOpsSheetTitle: document.getElementById('moreOpsSheetTitle'),
      moreOpsForbiddenBtn: document.getElementById('moreOpsForbiddenBtn'),
      moreOpsProdGuardBtn: document.getElementById('moreOpsProdGuardBtn'),
      moreOpsMaintenanceBtn: document.getElementById('moreOpsMaintenanceBtn'),
      moreOpsPurchaseBtn: document.getElementById('moreOpsPurchaseBtn'),
      moreOpsCostBtn: document.getElementById('moreOpsCostBtn'),
      moreOpsCloseBtn: document.getElementById('moreOpsCloseBtn'),
      purchaseSheet: document.getElementById('purchaseSheet'),
      purchaseSheetTitle: document.getElementById('purchaseSheetTitle'),
      purchaseSheetResult: document.getElementById('purchaseSheetResult'),
      purchasePriceInput: document.getElementById('purchasePriceInput'),
      purchaseDateInput: document.getElementById('purchaseDateInput'),
      purchaseSaveBtn: document.getElementById('purchaseSaveBtn'),
      purchaseCancelBtn: document.getElementById('purchaseCancelBtn'),
      costSheet: document.getElementById('costSheet'),
      costSheetTitle: document.getElementById('costSheetTitle'),
      costSheetResult: document.getElementById('costSheetResult'),
      costAmountInput: document.getElementById('costAmountInput'),
      costDateInput: document.getElementById('costDateInput'),
      costDescInput: document.getElementById('costDescInput'),
      costDetailBtn: document.getElementById('costDetailBtn'),
      costSaveBtn: document.getElementById('costSaveBtn'),
      costCancelBtn: document.getElementById('costCancelBtn'),
      pricingCostSheet: document.getElementById('pricingCostSheet'),
      pricingCostSheetTitle: document.getElementById('pricingCostSheetTitle'),
      pricingCostSheetResult: document.getElementById('pricingCostSheetResult'),
      pricingCostAmountInput: document.getElementById('pricingCostAmountInput'),
      pricingBaseCostInput: document.getElementById('pricingBaseCostInput'),
      pricingCostNoteInput: document.getElementById('pricingCostNoteInput'),
      pricingCostSaveBtn: document.getElementById('pricingCostSaveBtn'),
      pricingCostCancelBtn: document.getElementById('pricingCostCancelBtn'),
      orderOffThresholdSheet: document.getElementById('orderOffThresholdSheet'),
      orderOffThresholdSheetResult: document.getElementById('orderOffThresholdSheetResult'),
      orderOffThresholdInput: document.getElementById('orderOffThresholdInput'),
      orderOffModeNatural: document.getElementById('orderOffModeNatural'),
      orderOffModeRolling: document.getElementById('orderOffModeRolling'),
      orderOffThresholdSaveBtn: document.getElementById('orderOffThresholdSaveBtn'),
      orderOffThresholdCancelBtn: document.getElementById('orderOffThresholdCancelBtn'),
      authUuzuhaoSheet: document.getElementById('authUuzuhaoSheet'),
      authUuzuhaoTitle: document.getElementById('authUuzuhaoTitle'),
      authUuzuhaoResult: document.getElementById('authUuzuhaoResult'),
      authUuzuhaoAppKey: document.getElementById('authUuzuhaoAppKey'),
      authUuzuhaoAppSecret: document.getElementById('authUuzuhaoAppSecret'),
      authUuzuhaoSaveBtn: document.getElementById('authUuzuhaoSaveBtn'),
      authUuzuhaoCloseBtn: document.getElementById('authUuzuhaoCloseBtn'),
      authUhaozuSheet: document.getElementById('authUhaozuSheet'),
      authUhaozuTitle: document.getElementById('authUhaozuTitle'),
      authUhaozuResult: document.getElementById('authUhaozuResult'),
      authUhaozuCurl: document.getElementById('authUhaozuCurl'),
      authUhaozuDetailCurl: document.getElementById('authUhaozuDetailCurl'),
      authUhaozuMainSaveBtn: document.getElementById('authUhaozuMainSaveBtn'),
      authUhaozuDetailSaveBtn: document.getElementById('authUhaozuDetailSaveBtn'),
      authUhaozuCloseBtn: document.getElementById('authUhaozuCloseBtn'),
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

    function renderAuthUuzuhaoSheet() {
      const opened = Boolean(state.authEditor && state.authEditor.open);
      if (!els.authUuzuhaoSheet) return;
      els.authUuzuhaoSheet.classList.toggle('hidden', !opened);
      if (els.authUuzuhaoSaveBtn) {
        const saving = Boolean(state.authEditor && state.authEditor.saving);
        els.authUuzuhaoSaveBtn.disabled = saving;
        els.authUuzuhaoSaveBtn.textContent = saving ? '保存中...' : '保存';
      }
      if (els.authUuzuhaoResult) {
        const msg = String((state.authEditor && state.authEditor.error) || '').trim();
        els.authUuzuhaoResult.textContent = msg;
        els.authUuzuhaoResult.classList.toggle('err', Boolean(msg));
        els.authUuzuhaoResult.classList.remove('ok');
      }
      if (els.authUuzuhaoTitle) {
        els.authUuzuhaoTitle.textContent = String((state.authEditor && state.authEditor.title) || '新增悠悠授权');
      }
    }

    function closeAuthUuzuhaoSheet() {
      state.authEditor = {
        open: false,
        platform: '',
        title: '',
        saving: false,
        error: ''
      };
      if (els.authUuzuhaoAppKey) els.authUuzuhaoAppKey.value = '';
      if (els.authUuzuhaoAppSecret) els.authUuzuhaoAppSecret.value = '';
      renderAuthUuzuhaoSheet();
    }

    function openAuthUuzuhaoSheet(channel) {
      const authorized = Boolean(channel && channel.authorized);
      state.authEditor = {
        open: true,
        platform: 'uuzuhao',
        title: authorized ? '修改悠悠授权' : '新增悠悠授权',
        saving: false,
        error: ''
      };
      if (els.authUuzuhaoAppKey) els.authUuzuhaoAppKey.value = '';
      if (els.authUuzuhaoAppSecret) els.authUuzuhaoAppSecret.value = '';
      renderAuthUuzuhaoSheet();
    }

    async function submitAuthUuzuhao() {
      if (!state.authEditor || state.authEditor.saving) return;
      const appKey = String((els.authUuzuhaoAppKey && els.authUuzuhaoAppKey.value) || '').trim();
      const appSecret = String((els.authUuzuhaoAppSecret && els.authUuzuhaoAppSecret.value) || '').trim();
      if (!appKey || !appSecret) {
        state.authEditor.error = 'app_key 和 app_secret 不能为空';
        renderAuthUuzuhaoSheet();
        return;
      }
      state.authEditor.saving = true;
      state.authEditor.error = '';
      renderAuthUuzuhaoSheet();
      try {
        await request('/api/auth/platforms/upsert', {
          method: 'POST',
          body: JSON.stringify({
            platform: 'uuzuhao',
            auth_type: 'token',
            auth_payload: {
              app_key: appKey,
              app_secret: appSecret
            },
            auth_status: 'valid',
            desc: 'h5 uuzuhao auth upsert'
          })
        });
        await loadAuthManage();
        render();
        closeAuthUuzuhaoSheet();
        showToast('悠悠授权已保存');
      } catch (e) {
        state.authEditor.saving = false;
        state.authEditor.error = e.message || '授权保存失败';
        renderAuthUuzuhaoSheet();
      }
    }

    function renderAuthUhaozuSheet() {
      const opened = Boolean(state.authCookieEditor && state.authCookieEditor.open);
      if (!els.authUhaozuSheet) return;
      els.authUhaozuSheet.classList.toggle('hidden', !opened);
      if (els.authUhaozuMainSaveBtn) {
        const savingMain = String((state.authCookieEditor && state.authCookieEditor.saving) || '') === 'main';
        els.authUhaozuMainSaveBtn.disabled = Boolean(state.authCookieEditor && state.authCookieEditor.saving);
        els.authUhaozuMainSaveBtn.textContent = savingMain ? '保存中...' : '保存订单列表授权';
      }
      if (els.authUhaozuDetailSaveBtn) {
        const savingDetail = String((state.authCookieEditor && state.authCookieEditor.saving) || '') === 'detail';
        els.authUhaozuDetailSaveBtn.disabled = Boolean(state.authCookieEditor && state.authCookieEditor.saving);
        els.authUhaozuDetailSaveBtn.textContent = savingDetail ? '保存中...' : '保存订单详情授权';
      }
      if (els.authUhaozuResult) {
        const msg = String((state.authCookieEditor && state.authCookieEditor.error) || '').trim();
        els.authUhaozuResult.textContent = msg;
        els.authUhaozuResult.classList.toggle('err', Boolean(msg));
        els.authUhaozuResult.classList.remove('ok');
      }
      if (els.authUhaozuTitle) {
        els.authUhaozuTitle.textContent = String((state.authCookieEditor && state.authCookieEditor.title) || '新增U号租授权');
      }
    }

    function closeAuthUhaozuSheet() {
      state.authCookieEditor = {
        open: false,
        platform: '',
        title: '',
        saving: '',
        error: ''
      };
      if (els.authUhaozuCurl) els.authUhaozuCurl.value = '';
      if (els.authUhaozuDetailCurl) els.authUhaozuDetailCurl.value = '';
      renderAuthUhaozuSheet();
    }

    function openAuthUhaozuSheet(channel) {
      const authorized = Boolean(channel && channel.authorized);
      const rows = (state.authManage && Array.isArray(state.authManage.rows)) ? state.authManage.rows : [];
      const row = rows.find((item) => String((item && item.platform) || '').trim() === 'uhaozu') || null;
      const payload = row && row.auth_payload && typeof row.auth_payload === 'object' ? row.auth_payload : {};
      state.authCookieEditor = {
        open: true,
        platform: 'uhaozu',
        title: authorized ? '修改U号租授权' : '新增U号租授权',
        saving: '',
        error: ''
      };
      if (els.authUhaozuCurl) {
        const mainPayload = {};
        if (payload.cookie) mainPayload.cookie = payload.cookie;
        if (payload.default_headers && typeof payload.default_headers === 'object') mainPayload.default_headers = payload.default_headers;
        if (payload.order_list_path) mainPayload.order_list_path = payload.order_list_path;
        els.authUhaozuCurl.value = Object.keys(mainPayload).length ? JSON.stringify(mainPayload, null, 2) : '';
      }
      if (els.authUhaozuDetailCurl) {
        const detailPayload = payload.order_detail_headers && typeof payload.order_detail_headers === 'object'
          ? payload.order_detail_headers
          : {};
        els.authUhaozuDetailCurl.value = Object.keys(detailPayload).length ? JSON.stringify(detailPayload, null, 2) : '';
      }
      renderAuthUhaozuSheet();
    }

    async function submitAuthUhaozu(target) {
      if (!state.authCookieEditor || state.authCookieEditor.saving) return;
      const mode = String(target || '').trim() === 'detail' ? 'detail' : 'main';
      const curl = mode === 'main' ? String((els.authUhaozuCurl && els.authUhaozuCurl.value) || '').trim() : '';
      const orderDetailCurl = mode === 'detail' ? String((els.authUhaozuDetailCurl && els.authUhaozuDetailCurl.value) || '').trim() : '';
      if (!curl && !orderDetailCurl) {
        state.authCookieEditor.error = mode === 'main' ? '请输入订单列表 curl' : '请输入订单详情 curl';
        renderAuthUhaozuSheet();
        return;
      }
      state.authCookieEditor.saving = mode;
      state.authCookieEditor.error = '';
      renderAuthUhaozuSheet();
      try {
        await request('/api/auth/platforms/upsert-from-curl', {
          method: 'POST',
          body: JSON.stringify({
            platform: 'uhaozu',
            curl,
            order_detail_curl: orderDetailCurl,
            desc: 'h5 uhaozu curl auth upsert'
          })
        });
        await loadAuthManage();
        render();
        closeAuthUhaozuSheet();
        showToast(mode === 'main' ? '订单列表授权已保存' : '订单详情授权已保存');
      } catch (e) {
        state.authCookieEditor.saving = '';
        state.authCookieEditor.error = e.message || '授权保存失败';
        renderAuthUhaozuSheet();
      }
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
        const contentType = String(headers['Content-Type'] || headers['content-type'] || '').toLowerCase();
        if (contentType.includes('application/json')
          && fetchOptions.body
          && typeof fetchOptions.body === 'object'
          && !(fetchOptions.body instanceof FormData)
          && !(fetchOptions.body instanceof URLSearchParams)
          && !ArrayBuffer.isView(fetchOptions.body)
          && !(fetchOptions.body instanceof ArrayBuffer)) {
          fetchOptions.body = JSON.stringify(fetchOptions.body);
        }
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
          const retryOptions = Object.assign({}, options, { headers: retryHeaders });
          const retryContentType = String(retryHeaders['Content-Type'] || retryHeaders['content-type'] || '').toLowerCase();
          if (retryContentType.includes('application/json')
            && retryOptions.body
            && typeof retryOptions.body === 'object'
            && !(retryOptions.body instanceof FormData)
            && !(retryOptions.body instanceof URLSearchParams)
            && !ArrayBuffer.isView(retryOptions.body)
            && !(retryOptions.body instanceof ArrayBuffer)) {
            retryOptions.body = JSON.stringify(retryOptions.body);
          }
          res = await fetch(fullPath, retryOptions);
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
        await loadProfileSafe();
        await loadList();
        render();
      } catch (e) {
        els.loginErr.textContent = e.message;
      }
    }

    async function loadList() {
      const gameName = String(state.product_game_name || 'WZRY').trim() || 'WZRY';
      const data = await request(`/api/products?page=${state.page}&page_size=${state.pageSize}&filter=${state.filter}&game_name=${encodeURIComponent(gameName)}`);
      state.list = Array.isArray(data.list) ? data.list : [];
      state.total = Number(data.total || 0);
      state.product_game_name = String(data.game_name || gameName).trim() || gameName;
      state.stats = data.stats || {
        total_all: 0,
        master_total: 0,
        sync_effective_total: 0,
        total_blacklisted: 0,
        total_restricted: 0,
        total_renting: 0,
        total_paid: 0,
        sync_anomaly_count: 0,
        sync_anomaly_text: ''
      };
    }

    async function loadOrders() {
      const o = state.orders || {};
      const data = await request(`/api/orders?page=${o.page}&page_size=${o.pageSize}&status_filter=${o.status_filter}&quick_filter=${o.quick_filter}&game_name=${encodeURIComponent(o.game_name || 'WZRY')}`);
      state.orders.total = Number(data.total || 0);
      state.orders.list = Array.isArray(data.list) ? data.list : [];
      state.orders.stats = data.stats || { progress: 0, done: 0, done_zero: 0, today_total: 0 };
      state.orders.page = Number(data.page || o.page || 1);
      state.orders.pageSize = Number(data.page_size || o.pageSize || 20);
      state.orders.game_name = String(data.game_name || o.game_name || 'WZRY').trim() || 'WZRY';
    }

    async function loadStatsBoard(options = {}) {
      const s = state.statsBoard || {};
      const period = String(s.period || 'today').trim();
      const gameName = String(s.game_name || '全部').trim() || '全部';
      const statDateCandidate = String(options.stat_date === undefined ? (s.selected_date || '') : options.stat_date).trim();
      const hasStatDate = /^\d{4}-\d{2}-\d{2}$/.test(statDateCandidate);
      const data = await request(`/api/stats/dashboard?period=${encodeURIComponent(period)}&game_name=${encodeURIComponent(gameName)}${hasStatDate ? `&stat_date=${encodeURIComponent(statDateCandidate)}` : ''}`);
      state.statsBoard = {
        game_name: String(data.game_name || gameName).trim() || gameName,
        period: String(data.period || period),
        selected_date: hasStatDate ? statDateCandidate : '',
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

    async function loadRiskCenter() {
      const r = state.riskCenter || {};
      const page = Math.max(1, Number(r.page || 1));
      const pageSize = Math.min(100, Math.max(1, Number(r.pageSize || 20)));
      const status = String(r.status || 'all').trim().toLowerCase();
      const statusQuery = status === 'all' ? '' : `&status=${encodeURIComponent(status)}`;
      const riskType = String(r.risk_type || '').trim();
      const riskTypeQuery = riskType ? `&risk_type=${encodeURIComponent(riskType)}` : '';
      const data = await request(`/api/risk-center/events?page=${page}&page_size=${pageSize}${statusQuery}${riskTypeQuery}`);
      state.riskCenter = {
        ...state.riskCenter,
        page: Number(data.page || page),
        pageSize: Number(data.page_size || pageSize),
        total: Number(data.total || 0),
        list: Array.isArray(data.list) ? data.list : [],
        loading: false
      };
    }

    async function loadAuthManage() {
      const data = await request('/api/auth/platforms?with_payload=1');
      const channels = Array.isArray(data.data) ? data.data : [];
      const rows = Array.isArray(data.rows) ? data.rows : [];
      state.authManage = { channels, rows };
    }

    async function loadOrderOffThresholdRule() {
      const data = await request('/api/user-rules/order-off-threshold');
      const v = Number(data.threshold || 3);
      state.userRules.order_off_threshold = Number.isFinite(v) ? Math.max(1, Math.min(10, Math.floor(v))) : 3;
      state.userRules.order_off_mode = normalizeOrderOffMode(data.mode, ORDER_OFF_MODE_NATURAL_DAY);
    }

    async function loadProfileSafe() {
      if (typeof window.loadProfile === 'function') {
        await window.loadProfile();
      }
    }

    async function loadBoardCardsSafe() {
      if (typeof window.loadBoardCards === 'function') {
        await window.loadBoardCards();
      }
    }

    async function loadPricingViewSafe() {
      if (typeof window.loadPricingView === 'function') {
        await window.loadPricingView();
      }
    }

    function renderProfileViewSafe() {
      if (typeof window.renderProfileView === 'function') {
        window.renderProfileView();
      }
    }

    function renderBoardViewSafe() {
      if (typeof window.renderBoardView === 'function') {
        window.renderBoardView();
      }
    }

    function renderPricingViewSafe() {
      if (typeof window.renderPricingView === 'function') {
        window.renderPricingView();
      }
    }

    function closeBoardSmsSheetSafe() {
      if (typeof window.closeBoardSmsSheet === 'function') {
        window.closeBoardSmsSheet();
      }
    }

    function closeBoardEditorSheetsSafe() {
      if (typeof window.closeBoardEditorSheets === 'function') {
        window.closeBoardEditorSheets();
      }
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
      Array.from(document.querySelectorAll('[data-drawer-group]')).forEach((node) => {
        const key = String(node.getAttribute('data-drawer-group') || '').trim();
        const active = key === 'pricing'
          ? (state.currentMenu === 'pricing_uhaozu' || state.currentMenu === 'pricing_uuzuhao' || state.currentMenu === 'pricing_zuhaowang')
          : key === state.currentMenu;
        const expanded = Boolean(state.drawerExpandedGroups && state.drawerExpandedGroups[key]);
        node.classList.toggle('active', active);
        const toggle = node.querySelector('[data-drawer-group-toggle]');
        const list = node.querySelector('[data-drawer-group-list]');
        if (toggle) toggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        if (list) list.classList.toggle('hidden', !expanded);
      });
      Array.from(document.querySelectorAll('.drawer-sub-item')).forEach((n) => {
        const key = String(n.getAttribute('data-menu') || '').trim();
        const active = key === state.currentMenu;
        n.classList.toggle('active', active);
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
        const channelEnabled = !(c && c.channel_enabled === false);
        const statusText = !channelEnabled ? '已停用' : (authorized ? '已授权' : '未授权');
        const actionText = String((c && c.button_text) || (authorized ? '修改授权' : '新增授权'));
        const toggleText = String((c && c.toggle_text) || (channelEnabled ? '停用渠道' : '开启渠道'));
        const keyValues = Array.isArray(c && c.key_values) ? c.key_values : [];
        const keyHtml = keyValues.map((kv) => {
          const key = String((kv && kv.key) || '').trim();
          const masked = String((kv && kv.masked_value) || '').trim() || '空';
          return `<div class="auth-kv-row"><span class="auth-kv-key">${key}</span><span class="auth-kv-val">${masked}</span></div>`;
        }).join('');
        return `
          <div class="auth-channel-card">
            <div class="auth-channel-head">
              <div class="auth-channel-head-main">
                <p class="auth-channel-name">${name}</p>
                <p class="auth-channel-mode">${mode}</p>
              </div>
              <span class="chip auth-status ${authorized ? 'ok' : 'empty'}">${statusText}</span>
            </div>
            <div class="auth-kv-list">${keyHtml}</div>
            <div class="auth-op-row">
              <button class="btn btn-ghost btn-card-action auth-op-btn" data-op="auth-edit" data-platform="${platform}">${actionText}</button>
              <button class="btn btn-ghost btn-card-action auth-op-btn" data-op="auth-toggle" data-platform="${platform}" data-enabled="${channelEnabled ? '1' : '0'}">${toggleText}</button>
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
      const showOrderComplaint = showOrders && Boolean(state.orders && state.orders.complaint_detail && state.orders.complaint_detail.open);
      const showOrderDetail = showOrders && Boolean(state.orders && state.orders.detail_view && state.orders.detail_view.open);
      const showRisk = loggedIn && state.currentMenu === 'risk';
      const showStats = loggedIn && state.currentMenu === 'stats';
      const showAuth = loggedIn && state.currentMenu === 'auth';
      const showPricing = loggedIn && (state.currentMenu === 'pricing_uhaozu' || state.currentMenu === 'pricing_uuzuhao' || state.currentMenu === 'pricing_zuhaowang');
      const showBoard = loggedIn && state.currentMenu === 'board';
      const showProfile = loggedIn && state.currentMenu === 'profile';
      els.listView.classList.toggle('hidden', !showProducts);
      els.orderView.classList.toggle('hidden', !showOrders || showOrderComplaint || showOrderDetail);
      if (els.riskView) els.riskView.classList.toggle('hidden', !showRisk);
      if (els.orderComplaintView) els.orderComplaintView.classList.toggle('hidden', !showOrderComplaint);
      if (els.orderDetailView) els.orderDetailView.classList.toggle('hidden', !showOrderDetail);
      els.statsView.classList.toggle('hidden', !showStats);
      els.authView.classList.toggle('hidden', !showAuth);
      if (els.pricingView) els.pricingView.classList.toggle('hidden', !showPricing);
      if (els.boardView) els.boardView.classList.toggle('hidden', !showBoard);
      if (els.profileView) els.profileView.classList.toggle('hidden', !showProfile);
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
        if (showOrders && showOrderComplaint) renderOrderComplaintView();
        if (showOrders && showOrderDetail) renderOrderDetailView();
        if (showOrders && !showOrderComplaint && !showOrderDetail) renderOrdersView();
        if (showRisk) renderRiskCenterView();
        if (showStats) renderStatsView();
        if (showAuth) renderAuthView();
        if (showPricing) renderPricingViewSafe();
        if (showBoard) renderBoardViewSafe();
        if (showProfile) renderProfileViewSafe();
        renderDrawer();
        renderMoreOpsSheet();
        renderForbiddenSheet();
        renderPurchaseSheet();
        renderAuthUuzuhaoSheet();
        renderAuthUhaozuSheet();
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
        closeAuthUuzuhaoSheet();
        closeAuthUhaozuSheet();
        closeBoardSmsSheetSafe();
        closeBoardEditorSheetsSafe();
        closeOrderOffModeHelp();
        els.statsMissingOverlay.classList.add('hidden');
        resetPullRefreshUi();
      }
    }

    function resetStatsCostDetail() {
      state.statsCostDetail = {
        open: false,
        loading: false,
        deleting: false,
        game_account: '',
        game_name: 'WZRY',
        display_name: '',
        total_cost_amount: 0,
        purchase_cost_amount: 0,
        list: [],
        error: ''
      };
    }

    function activateMenu(key, options = {}) {
      const nextMenu = String(key || 'products').trim() || 'products';
      state.currentMenu = nextMenu;
      if (nextMenu === 'pricing_uhaozu' || nextMenu === 'pricing_uuzuhao' || nextMenu === 'pricing_zuhaowang') {
        state.pricing.channel = pricingChannelFromMenu(String(options.pricingChannel || nextMenu).trim());
        state.drawerExpandedGroups.pricing = true;
      }
      resetStatsCostDetail();
      closeActionSheets();
      closeAuthUuzuhaoSheet();
      closeAuthUhaozuSheet();
      closeDrawer();
    }

    function navigateMenu(key, options = {}) {
      activateMenu(key, options);
      if (key === 'products') {
        render();
        return;
      }
      if (key === 'orders') {
        state.orders.complaint_detail = { open: false, loading: false, error: '', order_no: '', channel: '', order: null, data: null, preview_image_url: '' };
        state.orders.detail_view = { open: false, loading: false, error: '', order_no: '', channel: '', order: null, detail: null };
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
      if (key === 'risk') {
        render();
        (async () => {
          try {
            await loadRiskCenter();
            render();
          } catch (e) {
            showToast(e.message || '风控中心加载失败');
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
      if (key === 'pricing_uhaozu' || key === 'pricing_uuzuhao' || key === 'pricing_zuhaowang') {
        render();
        (async () => {
          try {
            await loadPricingViewSafe();
            render();
            if (state.pricing.channel !== 'uhaozu') {
              showToast('该渠道定价页开发中');
            }
          } catch (e) {
            showToast(e.message || '定价规则加载失败');
          }
        })();
        return;
      }
      if (key === 'board') {
        render();
        (async () => {
          try {
            await loadBoardCardsSafe();
            render();
          } catch (e) {
            showToast(e.message || '板卡管理加载失败');
          }
        })();
        return;
      }
      if (key === 'profile') {
        render();
        (async () => {
          try {
            await loadProfileSafe();
            render();
          } catch (e) {
            showToast(e.message || '个人中心加载失败');
          }
        })();
        return;
      }
      render();
      alert('该功能正在开发中');
    }

    els.btnLogin.addEventListener('click', login);
    els.btnLogout.addEventListener('click', () => {
      closeDrawer();
      clearAuthState();
      state.list = [];
      state.productsSyncing = false;
      state.total = 0;
      state.page = 1;
      state.product_game_name = 'WZRY';
      state.currentMenu = 'products';
      state.drawerExpandedGroups = { pricing: false };
      state.drawerOpen = false;
      state.onlineStatusMap = {};
      state.onlineLoadingMap = {};
      state.forbiddenLoadingMap = {};
      state.forbiddenSheet = {
        open: false,
        account: '',
        game_id: '1',
        game_name: 'WZRY',
        role_name: '',
        result_text: '',
        result_type: '',
        loading: false,
        query_loading: false,
        query_status: '',
        query_text: ''
      };
      state.moreOpsSheet = { open: false, account: '', game_id: '1', game_name: 'WZRY', role_name: '', maintenance_enabled: false, maintenance_loading: false, prod_guard_enabled: true, prod_guard_loading: false };
      state.activeActionSheet = '';
      state.pricing = {
        loading: false,
        publishing: false,
        channel: 'uhaozu',
        game_name: 'WZRY',
        form: {
          payback_days: 210,
          avg_daily_rent_hours: 3.5,
          platform_fee_rate: 0.2,
          withdrawal_fee_rate: 0.02,
          price_step: 0.5,
          deposit: 100
        },
        summary: {
          account_count: 0,
          zero_cost_count: 0,
          total_cost_amount: 0,
          avg_suggested_listing_hourly_price: 0
        },
        list: [],
        error: '',
        loaded_once: false
      };
      state.board = {
        loading: false,
        query: '',
        filter: 'all',
        summary: {
          board_count: 0,
          mobile_count: 0,
          account_count: 0
        },
        list: [],
        smsSheet: {
          open: false,
          sending: false,
          board_id: 0,
          board_name: '',
          mobile_id: 0,
          mobile: '',
          recipient: '',
          content: '',
          result_text: '',
          result_type: ''
        },
        createSheet: {
          open: false,
          saving: false,
          board_name: '',
          board_ip: '',
          result_text: '',
          result_type: ''
        },
        mobileSlotSheet: {
          open: false,
          saving: false,
          board_id: 0,
          board_name: '',
          slot_index: '',
          mobile: '',
          result_text: '',
          result_type: ''
        },
        mobileAccountSheet: {
          open: false,
          saving: false,
          board_id: 0,
          mobile_slot_id: 0,
          mobile: '',
          account: '',
          result_text: '',
          result_type: ''
        },
        smsRecordSheet: {
          open: false,
          loading: false,
          mobile_slot_id: 0,
          title: '',
          result_text: '',
          result_type: '',
          list: []
        }
      };
      state.purchaseSheet = {
        open: false,
        account: '',
        game_id: '1',
        game_name: 'WZRY',
        role_name: '',
        purchase_price: '',
        purchase_date: '',
        result_text: '',
        result_type: '',
        loading: false
      };
      state.costSheet = {
        open: false,
        account: '',
        game_id: '1',
        game_name: 'WZRY',
        role_name: '',
        cost_amount: '',
        cost_date: '',
        cost_desc: '',
        result_text: '',
        result_type: '',
        loading: false
      };
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
      state.statsCostDetail = {
        open: false,
        loading: false,
        deleting: false,
        game_account: '',
        game_name: 'WZRY',
        display_name: '',
        total_cost_amount: 0,
        purchase_cost_amount: 0,
        list: [],
        error: ''
      };
      state.cardNodeMap = {};
      state.pullRefresh = { dragging: false, ready: false, loading: false, startY: 0, distance: 0 };
      state.statsBoard = {
        game_name: '全部',
        period: 'week',
        selected_date: '',
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
      state.statsCostDetail = {
        open: false,
        loading: false,
        deleting: false,
        game_account: '',
        game_name: 'WZRY',
        display_name: '',
        total_cost_amount: 0,
        purchase_cost_amount: 0,
        list: [],
        error: ''
      };
      state.riskCenter = {
        status: 'all',
        risk_type: '',
        page: 1,
        pageSize: 20,
        total: 0,
        list: [],
        loading: false
      };
      state.authManage = { channels: [], rows: [] };
      state.authEditor = {
        open: false,
        platform: '',
        title: '',
        saving: '',
        error: ''
      };
      state.authCookieEditor = {
        open: false,
        platform: '',
        title: '',
        saving: false,
        error: ''
      };
      state.userRules = {
        order_off_threshold: 3,
        order_off_mode: ORDER_OFF_MODE_NATURAL_DAY
      };
      state.profile = {
        loading: false,
        notify_saving: false,
        order_off_saving: false,
        notify: {
          at_mode: 'none',
          at_mobiles: []
        },
        order_off: {
          threshold: 3,
          mode: ORDER_OFF_MODE_NATURAL_DAY
        }
      };
      state.orders.syncing = false;
      state.orders.complaint_detail = { open: false, loading: false, error: '', order_no: '', channel: '', order: null, data: null, preview_image_url: '' };
      state.orders.detail_view = { open: false, loading: false, error: '', order_no: '', channel: '', order: null, detail: null };
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

    if (els.productSyncNowBtn) {
      els.productSyncNowBtn.addEventListener('click', async () => {
        if (state.productsSyncing) return;
        state.productsSyncing = true;
        renderList();
        try {
          await request('/api/products/sync', { method: 'POST', body: '{}' });
          state.page = 1;
          await loadList();
          renderList();
          showToast('商品已同步');
        } catch (e) {
          showToast(e.message || '商品同步失败');
        } finally {
          state.productsSyncing = false;
          renderList();
        }
      });
    }

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

    if (els.riskPrevPage) {
      els.riskPrevPage.addEventListener('click', async () => {
        if (state.riskCenter.page <= 1) return;
        state.riskCenter.page -= 1;
        await loadRiskCenter();
        renderRiskCenterView();
      });
    }

    if (els.riskNextPage) {
      els.riskNextPage.addEventListener('click', async () => {
        const totalPages = Math.max(1, Math.ceil(Number(state.riskCenter.total || 0) / Number(state.riskCenter.pageSize || 20)));
        if (state.riskCenter.page >= totalPages) return;
        state.riskCenter.page += 1;
        await loadRiskCenter();
        renderRiskCenterView();
      });
    }

    if (els.riskRefreshBtn) {
      els.riskRefreshBtn.addEventListener('click', async () => {
        if (state.riskCenter.loading) return;
        state.riskCenter.loading = true;
        renderRiskCenterView();
        try {
          state.riskCenter.page = 1;
          await loadRiskCenter();
          renderRiskCenterView();
          showToast('风控数据已刷新');
        } catch (e) {
          showToast(e.message || '风控刷新失败');
        } finally {
          state.riskCenter.loading = false;
          renderRiskCenterView();
        }
      });
    }

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
    if (els.sheetQueryForbidden) {
      els.sheetQueryForbidden.addEventListener('click', () => queryForbidden());
    }
    if (els.sheetEnableForbidden) {
      els.sheetEnableForbidden.addEventListener('click', () => submitForbidden(true));
    }
    if (els.sheetDisableForbidden) {
      els.sheetDisableForbidden.addEventListener('click', () => submitForbidden(false));
    }
    if (els.sheetCancelForbidden) {
      els.sheetCancelForbidden.addEventListener('click', () => closeForbiddenSheet());
    }
    els.forbiddenSheet.addEventListener('click', (e) => {
      if (e.target === els.forbiddenSheet) closeForbiddenSheet();
    });
    const findCurrentProductItem = () => {
      const account = String((state.moreOpsSheet || {}).account || '').trim();
      const gameId = String((state.moreOpsSheet || {}).game_id || '1').trim() || '1';
      if (!account) return null;
      return (state.list || []).find((x) => {
        return String((x && x.game_account) || '').trim() === account
          && String((x && x.game_id) || '1').trim() === gameId;
      }) || null;
    };
    els.moreOpsForbiddenBtn.addEventListener('click', () => {
      const item = findCurrentProductItem();
      if (!item) return;
      closeMoreOpsSheet();
      openForbiddenSheet(item);
    });
    if (els.moreOpsProdGuardBtn) {
      els.moreOpsProdGuardBtn.addEventListener('click', () => {
        const item = findCurrentProductItem();
        if (!item) return;
        void toggleProdGuard(item);
      });
    }
    if (els.moreOpsMaintenanceBtn) {
      els.moreOpsMaintenanceBtn.addEventListener('click', () => {
        const item = findCurrentProductItem();
        if (!item) return;
        void toggleMaintenance(item);
      });
    }
    els.moreOpsPurchaseBtn.addEventListener('click', () => {
      const item = findCurrentProductItem();
      if (!item) return;
      closeMoreOpsSheet();
      openPurchaseSheet(item);
    });
    if (els.moreOpsCostBtn) {
      els.moreOpsCostBtn.addEventListener('click', () => {
        const item = findCurrentProductItem();
        if (!item) return;
        closeMoreOpsSheet();
        openCostSheet(item);
      });
    }
    els.moreOpsCloseBtn.addEventListener('click', () => closeMoreOpsSheet());
    els.moreOpsSheet.addEventListener('click', (e) => {
      if (e.target === els.moreOpsSheet) closeMoreOpsSheet();
    });
    els.purchaseSaveBtn.addEventListener('click', () => submitPurchaseConfig());
    els.purchaseCancelBtn.addEventListener('click', () => closePurchaseSheet());
    els.purchaseSheet.addEventListener('click', (e) => {
      if (e.target === els.purchaseSheet) closePurchaseSheet();
    });
    if (els.costSaveBtn) {
      els.costSaveBtn.addEventListener('click', () => submitCostConfig());
    }
    if (els.costDetailBtn) {
      els.costDetailBtn.addEventListener('click', () => openCostDetailFromSheet());
    }
    if (els.costCancelBtn) {
      els.costCancelBtn.addEventListener('click', () => closeCostSheet());
    }
    if (els.costSheet) {
      els.costSheet.addEventListener('click', (e) => {
        if (e.target === els.costSheet) closeCostSheet();
      });
    }
    if (els.pricingCostCancelBtn) {
      els.pricingCostCancelBtn.addEventListener('click', () => {
        if (typeof window.closePricingCostSheet === 'function') window.closePricingCostSheet();
      });
    }
    if (els.pricingCostSaveBtn) {
      els.pricingCostSaveBtn.addEventListener('click', () => {
        if (typeof window.submitPricingCostConfig === 'function') void window.submitPricingCostConfig();
      });
    }
    if (els.pricingCostSheet) {
      els.pricingCostSheet.addEventListener('click', (e) => {
        if (e.target === els.pricingCostSheet && typeof window.closePricingCostSheet === 'function') window.closePricingCostSheet();
      });
    }
    if (els.authUuzuhaoSaveBtn) {
      els.authUuzuhaoSaveBtn.addEventListener('click', () => submitAuthUuzuhao());
    }
    if (els.authUuzuhaoCloseBtn) {
      els.authUuzuhaoCloseBtn.addEventListener('click', () => closeAuthUuzuhaoSheet());
    }
    if (els.authUuzuhaoSheet) {
      els.authUuzuhaoSheet.addEventListener('click', (e) => {
        if (e.target === els.authUuzuhaoSheet) closeAuthUuzuhaoSheet();
      });
    }
    if (els.authUhaozuMainSaveBtn) {
      els.authUhaozuMainSaveBtn.addEventListener('click', () => submitAuthUhaozu('main'));
    }
    if (els.authUhaozuDetailSaveBtn) {
      els.authUhaozuDetailSaveBtn.addEventListener('click', () => submitAuthUhaozu('detail'));
    }
    if (els.authUhaozuCloseBtn) {
      els.authUhaozuCloseBtn.addEventListener('click', () => closeAuthUhaozuSheet());
    }
    if (els.authUhaozuSheet) {
      els.authUhaozuSheet.addEventListener('click', (e) => {
        if (e.target === els.authUhaozuSheet) closeAuthUhaozuSheet();
      });
    }
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
        const gameName = String((state.statsBoard && state.statsBoard.game_name) || '全部').trim() || '全部';
        await request('/api/stats/refresh', {
          method: 'POST',
          body: JSON.stringify({ game_name: gameName })
        });
        await loadStatsBoard();
        if (typeof loadStatsCalendar === 'function') {
          await loadStatsCalendar((state.statsBoard.calendar && state.statsBoard.calendar.month) || '');
        }
        renderStatsView();
        showToast('统计已刷新（最近14天）');
      } catch (e) {
        alert(e.message || '统计刷新失败');
      }
    });
    if (els.authChannelList) {
      els.authChannelList.addEventListener('click', (e) => {
        const btn = e.target && e.target.closest ? e.target.closest('[data-op]') : null;
        if (!btn) return;
        const op = String(btn.getAttribute('data-op') || '').trim();
        const platform = String(btn.getAttribute('data-platform') || '').trim();
        if (!platform) return;
        const channels = (state.authManage && Array.isArray(state.authManage.channels))
          ? state.authManage.channels
          : [];
        if (op === 'auth-toggle') {
          const enabled = String(btn.getAttribute('data-enabled') || '').trim() === '1';
          const nextEnabled = !enabled;
          const actionLabel = nextEnabled ? '开启渠道' : '停用渠道';
          const confirmed = nextEnabled || window.confirm(`确认${actionLabel}？`);
          if (!confirmed) return;
          request('/api/auth/platforms/toggle-channel', {
            method: 'POST',
            body: {
              platform,
              channel_enabled: nextEnabled
            }
          }).then(() => loadAuthManage()).then(() => {
            renderAuthView();
            showToast(nextEnabled ? '渠道已开启' : '渠道已停用');
          }).catch((err) => {
            alert(err.message || `${actionLabel}失败`);
          });
          return;
        }
        if (op !== 'auth-edit') return;
        if (platform === 'uuzuhao') {
          const channel = channels.find((c) => String((c && c.platform) || '').trim() === 'uuzuhao') || { platform: 'uuzuhao', authorized: false };
          openAuthUuzuhaoSheet(channel);
          return;
        }
        if (platform === 'uhaozu') {
          const channel = channels.find((c) => String((c && c.platform) || '').trim() === 'uhaozu') || { platform: 'uhaozu', authorized: false };
          openAuthUhaozuSheet(channel);
          return;
        }
        showToast('当前仅支持悠悠/U号租授权');
      });
    }

    els.menuTrigger.addEventListener('click', openDrawer);
    els.drawerMask.addEventListener('click', closeDrawer);
    Array.from(document.querySelectorAll('.drawer-item[data-menu]')).forEach((n) => {
      n.addEventListener('click', () => {
        const key = String(n.getAttribute('data-menu') || '').trim();
        navigateMenu(key || 'products');
      });
    });
    Array.from(document.querySelectorAll('[data-drawer-group-toggle]')).forEach((n) => {
      n.addEventListener('click', () => {
        const group = String(n.getAttribute('data-drawer-group-toggle') || '').trim();
        if (!group) return;
        state.drawerExpandedGroups[group] = !Boolean(state.drawerExpandedGroups[group]);
        renderDrawer();
      });
    });
    Array.from(document.querySelectorAll('.drawer-sub-item')).forEach((n) => {
      n.addEventListener('click', () => {
        const key = String(n.getAttribute('data-menu') || '').trim();
        navigateMenu(key || 'pricing_uhaozu', { pricingChannel: pricingChannelFromMenu(key) });
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
        (state.purchaseSheet && state.purchaseSheet.open) ||
        (state.costSheet && state.costSheet.open) ||
        (state.pricingCostSheet && state.pricingCostSheet.open) ||
        (state.statsCostDetail && state.statsCostDetail.open) ||
        (state.authEditor && state.authEditor.open) ||
        (state.authCookieEditor && state.authCookieEditor.open)
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
      const initialRoute = parseInitialRouteFromUrl();
      state.currentMenu = initialRoute.menu;
      state.pricing.channel = initialRoute.pricingChannel;
      if (state.currentMenu === 'pricing_uhaozu' || state.currentMenu === 'pricing_uuzuhao' || state.currentMenu === 'pricing_zuhaowang') {
        state.drawerExpandedGroups.pricing = true;
      }
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
          await loadProfileSafe();
          await loadList();
          await loadOrders();
          await loadRiskCenter();
          await loadStatsBoard();
          if (state.currentMenu === 'pricing_uhaozu' || state.currentMenu === 'pricing_uuzuhao' || state.currentMenu === 'pricing_zuhaowang') {
            await loadPricingViewSafe();
          }
          if (state.currentMenu === 'board') {
            await loadBoardCardsSafe();
          }
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
