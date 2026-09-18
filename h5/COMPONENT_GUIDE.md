# H5 Component Guide

## 1. 目标与边界

本文件是 `rent_task` H5 公共组件注册表，用于声明已有组件、使用契约、成熟度和积累规则。强制开发约束见 `h5/AGENTS.md`。

当前 H5 使用原生 HTML、CSS 和 JavaScript。本版本只登记现状，不重构已有页面；组件状态以 `h5/public/index.html`、`h5/public/css/app.css` 和 `h5/public/js/` 的实际实现为准。

## 2. 组件状态

- **稳定**：已有明确基础类和多个使用场景，新页面应直接复用。
- **试用**：已经跨页面出现，但契约或公共 JS 行为尚未完全收口；新调用方不得复制，应在新需求方案中完成复用或公共化。
- **页面变体**：只适用于特定页面，必须建立在公共组件之上，不视为新的基础组件。
- **废弃**：停止新增调用方，必须登记替代组件后再逐步迁移。

公共组件进入“稳定”状态的条件：

1. 有独立、语义明确的基础类或公共 JS 接口。
2. 已在至少两个页面或两个游戏场景复用，或者属于全局应用外壳、反馈等明确的基础原语。
3. 已登记 DOM/CSS/行为契约、使用方和允许的变体。
4. 已完成相关功能测试和手机、桌面视觉验证。

## 3. 设计 Token

事实来源：`h5/public/css/app.css` 的 `:root`。

| 类别 | 已有 Token | 规则 |
| --- | --- | --- |
| 基础颜色 | `--bg` `--ink` `--muted` `--line` `--card` | 新组件优先复用 |
| 语义颜色 | `--brand` `--ok` `--warn` `--danger` | 状态含义必须保持一致 |
| 按钮 | `--btn-green-bg` `--btn-green-border` `--btn-green-text` | 不在页面内重建按钮色板 |
| 阴影 | `--shadow` | 优先复用，不新增同义阴影 |

新增视觉值前先确认现有 Token 无法表达，并在方案中说明新增语义。禁止仅为单个游戏增加颜色体系。

## 4. 稳定公共组件注册表

| 组件 | 基础契约 | 已有使用场景 | 允许扩展 |
| --- | --- | --- | --- |
| PageContainer | `.wrap` `.orders-view` | 全局页面、列表型页面 | 页面锚点只调整布局 |
| Panel | `.panel` | 登录、配置、页面内容区 | 页面变体可以调整内部排版 |
| Field | `.field` 及表单控件基础样式 | 登录、授权、配置、Sheet 表单 | 页面变体只调整排列和密度 |
| ModeOption | `.mode-options` `.mode-option-row` | 个人中心、订单规则、商品级配置 | 选项内容和选中状态可变 |
| AppHeader | `.hero` `.hero-toolbar` `.hero-menu-trigger` `.hero-menu-title` | 登录态和应用态顶部区域 | 标题和菜单状态可变 |
| Drawer | `.drawer-item` `.drawer-group` `.drawer-group-toggle` `.drawer-sub-list` `.drawer-sub-item` | 全局导航 | 菜单数据、展开和激活状态可变 |
| Button | `.btn` + `.btn-primary/.btn-ghost/.btn-ok/.btn-danger` | 登录、分页、普通操作 | 只增加有明确语义的变体 |
| PageAction | `.btn-page-action` | 商品、订单、统计、定价、板卡、维护、风控 | 页面头部主操作统一使用 |
| CardAction | `.btn-card-action` | 商品卡片、个人中心卡片、阶梯定价账号卡片 | 危险操作使用语义变体 |
| FeatureSwitch | `.feature-switch` `.feature-switch-copy` `.feature-switch-track` | 页面级功能启停 | 使用原生 checkbox + `role="switch"`，页面只绑定状态和保存行为 |
| HeaderTabs | `.orders-tabs-row` `.orders-tabs` `.orders-tab.header-tab` | 订单、板卡、风控、渠道价格 Sheet；商品页只复用容器 | 数据项和激活状态可变 |
| QuickFilters | `.orders-quick` `.orders-quick-item.header-quick-tab` | 订单二级筛选 | 仅内容和选中值可变 |
| HeadSummary | `.head-summary-text` | 商品、订单、统计、板卡、维护 | 文案可变，视觉层级固定 |
| OrderCard | `.order-card` `.order-card-top` `.order-card-role` `.order-card-line` | 订单、商品及相关列表 | 通过附加类增加领域差异 |
| StatusTag | `.chip` `.order-chip` `.plat` 及已有语义变体 | 商品、订单、统计状态 | 新状态必须保留统一语义 |
| Pager | `.pager` `.page-info` + `.btn` | 商品、订单、风控 | 页码和禁用状态可变 |
| Overlay | `.overlay` `.overlay-card` | 提示和确认类遮罩 | 内容可变，不重建遮罩层 |
| Sheet | `.sheet` `.sheet-card` `.sheet-head` `.sheet-actions` `.sheet-btn` | 商品操作、授权、成本、板卡、渠道价格 | 字段和动作可变，外壳固定 |
| GameAvatar | `.game-avatar` + 图片资源 | 商品、订单、统计、定价、板卡 | 图标和无图回退可变 |
| Toast | `.toast` 及已有反馈变体 | 全局轻提示和详情提示 | 文案、持续时间和语义状态可变 |
| GlobalLoading | `.global-loading` 及其子元素 | 全局请求等待 | 文案和可见状态可变 |
| PullRefresh | `.pull-refresh` `.pull-refresh-inner` `.pull-spinner` | 商品列表下拉刷新 | 遵循固定 Loading 文案规则 |
| ClipboardCopy | `copyTextToClipboard(text)` + `.copy-btn` | 商品账号、渠道价格错误日志 | 复制行为统一回退，调用方只负责反馈文案 |

## 5. 试用组件与待收口能力

以下能力已经重复出现，但公共契约尚未完全收口。新页面不得复制现有实现，应在对应需求方案中优先完成公共化：

| 候选组件 | 当前实现 | 已知问题 | 新调用方要求 |
| --- | --- | --- | --- |
| GameTabs | `.stats-game-tabs` `.stats-game-tab` `.stats-game-tab-text` | CSS 仍枚举商品、订单、统计、定价页面 ID；各页面分别渲染 | 复用同一 DOM 语义，并先提出通用选择器/渲染方案 |
| GameCatalog | 各 `menu_*.js` 内的游戏名称和图标映射 | 商品、订单、定价、板卡等存在重复映射 | 不得新增第五份映射，先收口公共数据源 |
| GameTabsRenderer | 商品、订单、统计、定价分别生成页签 HTML 和绑定事件 | 行为相近但数据属性不同 | 新页面不得复制模板，先设计公共渲染接口 |
| ProductFilters | 商品页使用 `.stats-period-btn.product-filter-tab` | 与 HeaderTabs/周期筛选存在视觉复用，但契约仍是页面级组合 | 新页面不得照搬，应先确认归入 HeaderTabs 还是独立组件 |
| SheetController | 各页面分别维护 Sheet 的打开、关闭、Loading 和结果状态 | 外壳统一但行为分散 | 可复用现有外壳；新增重复行为时应抽公共控制器 |
| EmptyState | 多页面各自生成空数据内容 | 尚无统一结构和状态契约 | 新页面需先声明统一空状态方案 |
| ChannelPriceResult | `.pricing-package-table` `.pricing-package-row` `.pricing-error-log-list` | 阶梯定价渠道价格 Sheet | 套餐列由渠道能力数据决定；不得把渠道特有字段写入通用账号卡片 |

“试用”不表示禁止使用，而是表示复用时必须优先补齐公共契约，不能继续复制。

## 6. 多游戏组件契约

- 同一个页面组件必须接受游戏数据作为输入，至少包含 `game_id`、显示名称和可选图标。
- 组件 DOM、基础类、交互状态和尺寸规则不得根据游戏复制。
- 游戏名称长度、图标缺失、游戏增删和排序变化不能破坏布局。
- 游戏特有字段应通过可选区域、配置或变体表达，不得复制整张卡片或整套页签。
- 新增游戏时，理想目标是只扩展公共游戏目录和后端数据，不修改每个页面的组件实现。

现有多游戏页签视觉约定：

- 连续浏览器标签形态，不使用胶囊按钮。
- 标签间无明显间距，仅保留细分隔线。
- 激活项白底并与内容区连通，未激活项浅灰底。
- 支持移动端横向滚动且不换行。
- 内容统一为“游戏图标 + 游戏中文名”。

## 7. 页面变体登记

以下为已有页面锚点变体，不属于独立公共组件：

| 页面 | 已有变体 | 基础组件关系 |
| --- | --- | --- |
| Profile | `.profile-card` `.profile-field` `.profile-mode-inline` `.profile-threshold-*` | 基于 Panel、Field、ModeOption |
| Pricing | `.pricing-ladder-head` `.pricing-ladder-list` `.pricing-account-card` `.pricing-ladder-grid` `.pricing-copy-field` | 基于 GameTabs、Panel、Card、Field、CardAction；四档输入和账号复制为页面变体 |
| Board | `.board-top-row` `.board-card` `.board-mobile-card` `.board-account-list` `.board-account-tag` | 基于 PageAction、Panel、Card、GameAvatar |
| Maintenance | `.maintenance-top-row` `.maintenance-summary-grid` `.maintenance-kpi-card` `.maintenance-log-card` `.maintenance-status-pill` | 基于 Panel、Card、StatusTag |
| Products | `.product-filters` `.product-filter-tab` `.product-op-btn` `.product-op-btn-danger` | 基于 HeaderTabs、Button、CardAction |

页面变体只记录与基础组件不同的部分。若变体被第二个页面采用，应重新评估并提升为公共变体或公共组件。

## 8. 新页面复用流程

新页面进入方案 Review 时，必须提交下表：

| 需求元素 | 对应已有组件 | 决策 | 差异原因 | 影响页面 | 验证方式 |
| --- | --- | --- | --- | --- | --- |
| 示例：游戏切换 | GameTabs（试用） | 完成公共化后复用 | 需要支持新页面容器 | 商品/订单/统计/定价/新页面 | 手机、桌面、多游戏 |

决策只能使用以下值：

- **直接复用**：不增加新的基础样式和重复行为。
- **新增变体**：基础语义不变，仅扩展明确差异。
- **新建公共组件**：现有组件无法表达，并预计具有跨页面或跨游戏价值。
- **页面专属**：只在当前页面有意义，且方案中已说明不能公共化的原因。

## 9. 组件变更流程

新增或修改公共组件时，同一次改动必须完成：

1. 更新实际 HTML、CSS 或 JS 实现。
2. 更新本注册表中的状态、契约、使用方和变体。
3. 列出受影响的全部页面和游戏。
4. 增加或更新正常、边界、异常和交互状态测试。
5. 验证手机、桌面视口以及长文案、空数据、Loading、禁用等状态。
6. 在交付报告中说明复用了什么、为什么新增、覆盖率和剩余风险。

禁止只新增类名而不登记组件，也禁止只更新本指南而没有对应实现。

## 10. 新页面完成标准

- 已提交并通过组件复用清单 Review。
- 已优先使用稳定组件，未复制试用组件或已有页面逻辑。
- 所有支持游戏使用同一套组件契约。
- 新组件或变体已登记，文档与实现一致。
- 公共组件改动已验证全部使用方。
- 功能测试、覆盖率、手机和桌面视觉验证符合 `h5/AGENTS.md`。
