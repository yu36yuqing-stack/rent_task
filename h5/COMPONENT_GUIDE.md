# H5 Component Guide

## 1. 目标

统一 H5 页面视觉与交互，避免新页面重复造样式。  
新需求优先复用已有组件类，只有在确实无法满足时才新增组件或变体。

## 2. 设计 Token（基础变量）

来源：`h5/public/css/app.css` 的 `:root`。

- 颜色：`--bg` `--ink` `--muted` `--line` `--card` `--brand` `--ok` `--warn` `--danger`
- 按钮：`--btn-green-bg` `--btn-green-border` `--btn-green-text`
- 阴影：`--shadow`

规则：

- 不直接硬编码新颜色，优先复用 token。
- 新增颜色前先评估是否可由现有 token 组合实现。

## 3. 通用组件清单

来源：`h5/public/css/app.css`

- Layout
  - `.wrap`：主容器
  - `.orders-view`：列表页垂直栅格容器
  - `.panel`：通用卡片容器
- Header / Drawer
  - `.hero` `.hero-toolbar` `.hero-menu-trigger` `.hero-menu-title`
  - `.drawer-item` `.drawer-item.active`
- Button
  - `.btn` `.btn-primary` `.btn-ghost` `.btn-ok` `.btn-danger`
- Tabs / Filters
  - `.orders-tabs-row`
  - `.orders-tabs` + `.orders-tab`
  - `.orders-quick` + `.orders-quick-item`
  - `#statsGameTabs.stats-game-tabs` + `.stats-game-tab`（统计页按游戏切换 Tab）
  - `#statsPeriods.stats-periods` + `.stats-period-btn`（统计周期切换）
- Card
  - `.order-card` `.order-card-top` `.order-card-role` `.order-card-line`
- Status Chip / Tag
  - `.order-chip`（状态 badge）
  - `.plat` / `.plat-renting` / `.plat-abnormal`（信息标签）
- Pager
  - `.pager` `.page-info`
- Overlay / Sheet
  - `.overlay` `.overlay-card`
  - `.sheet` `.sheet-card` `.sheet-actions` `.sheet-btn`
- Profile（页面锚点变体）
  - `#profileView .profile-card`：个人中心卡片容器（基于 `.panel` 的页面变体）
  - `#profileView .profile-head-row`：卡片头部横向布局
  - `#profileView .profile-field`：字段行紧凑间距
  - `#profileView .profile-mode-inline`：通知模式三按钮横排（复用 `.mode-options` / `.mode-option-row`）
  - `#profileView .profile-threshold-row`：单量阈值标题与输入同一行
  - `#profileView .profile-threshold-input-wrap`：阈值输入容器（含单位）
  - `#profileView .profile-threshold-input`：阈值数字输入框样式
  - `#profileView .profile-threshold-unit`：阈值单位文案
- Board（页面锚点变体）
  - `#boardView .board-top-row`：板卡页标题和新增按钮行
  - `#boardView .board-card`：板卡主卡片容器（基于 `.panel` 的页面变体）
  - `#boardView .board-card-head`：板卡卡片头部横向布局
  - `#boardView .board-mobile-card`：手机号子卡片
  - `#boardView .board-account-list`：account 标签列表
  - `#boardView .board-account-tag`：account 标签
  - `#boardView .board-account-tag-text`：account 标签文案区（配合 `.game-avatar`）
- Products（页面锚点变体）
  - `#listView .product-filters`：商品页筛选容器（复用 `.orders-tabs`）
  - `#listView .product-filter-tab`：商品页筛选项（复用 `.orders-tab`）
  - `#listView .product-op-btn`：商品卡片操作按钮（复用 `.btn.btn-ghost`）
  - `#listView .product-op-btn-danger`：商品卡片危险操作按钮变体

## 4. 复用优先级

1. 优先直接复用已有类（不新增样式）。
2. 其次新增“变体类”（如 `order-chip.xxx`），不改基础组件语义。
3. 最后才新增新组件；新增时需补齐本指南组件清单。

## 5. 命名规范

- 使用“基础类 + 变体类”：
  - 例：`.order-chip` + `.order-chip.progress`
- 页面专属样式必须带页面锚点，避免污染全局：
  - 例：`#riskView .order-card { ... }`
- 禁止无语义缩写类名（如 `.x1` `.box2`）。

## 6. 页面落地规范

- 新页面应优先按“订单页结构”搭建：
  - 顶部筛选：`orders-tabs-row`
  - 列表卡片：`order-card`
  - 分页：`pager`
- 文案调整优先在 JS 渲染层处理，不新增仅为文案存在的样式类。

## 7. 变更流程

当前端新增/修改组件时，必须同步：

1. 更新 `h5/public/css/app.css`（组件定义）
2. 更新 `h5/COMPONENT_GUIDE.md`（组件清单或规范）
3. 说明“复用了哪些类、为何新增变体”

## 8. H5统一样式基线

以下为 H5 页面通用样式分层，跨页面必须保持一致：

- 页面级按钮（头部操作按钮）
  - 类名：`.btn-page-action`
  - 用途：页面头部右上角主操作，如“同步商品 / 同步订单 / 手动刷新 / 手工刷新”。
  - 规则：不同页面复用同一类，不允许单页面再定义字号/高度差异。
- 卡片级按钮（卡片内操作按钮）
  - 类名：`.btn-card-action`
  - 用途：商品卡片/订单卡片内的操作按钮。
  - 规则：与页面级按钮视觉层级区分（更紧凑），跨卡片保持一致。
- 页面头部第一级筛选（主Tab）
  - 类名：`.header-tab`（基于 `.orders-tab`）
  - 用途：页面头部第一行主筛选，如“全部/租赁中/已完成”等。
  - 规则：所有页面第一行主筛选统一复用该类。
- 页面头部第二级筛选（快捷筛选）
  - 类名：`.header-quick-tab`（基于 `.orders-quick-item`）
  - 用途：页面头部第二行快捷时间/状态筛选。
  - 规则：统一胶囊样式，不允许页面单独改尺寸体系。
- 页面头部第三级信息汇总文案
  - 类名：`.head-summary-text`
  - 用途：第三行的汇总文字、提示文案、统计区间文本。
  - 规则：统一字号、字重、行高、颜色层级，避免各页漂移。
