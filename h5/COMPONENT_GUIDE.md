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
| ListSearch | `.field.list-search-field` + 页面搜索输入框 | 板卡、阶梯定价账号列表 | 复用 Field 外观；页面只提供检索字段和本地过滤函数 |
| ModeOption | `.mode-options` `.mode-option-row` | 个人中心、订单规则、商品级配置 | 选项内容和选中状态可变 |
| AppHeader | `.hero` `.hero-toolbar` `.hero-menu-trigger` `.hero-menu-title` | 登录态和应用态顶部区域 | 标题和菜单状态可变 |
| Drawer | `.drawer-item` `.drawer-group` `.drawer-group-toggle` `.drawer-sub-list` `.drawer-sub-item` | 全局导航 | 菜单数据、展开和激活状态可变 |
| Button | `.btn` + `.btn-primary/.btn-ghost/.btn-ok/.btn-danger` | 登录、分页、普通操作 | 只增加有明确语义的变体 |
| PageAction | `.btn-page-action` | 商品、订单、统计、定价、板卡、维护、风控 | 页面头部主操作统一使用 |
| CardAction | `.btn-card-action` | 商品卡片、个人中心卡片、阶梯定价账号卡片 | 危险操作使用语义变体 |
| FeatureSwitch | `.feature-switch` `.feature-switch-copy` `.feature-switch-track` | 页面级功能启停 | 使用原生 checkbox + `role="switch"`，页面只绑定状态和保存行为 |
| HeaderTabs | `.orders-tabs-row` `.orders-tabs` `.orders-tab.header-tab` | 订单、板卡、风控、渠道价格 Sheet；商品页只复用容器 | 数据项和激活状态可变 |
| QuickFilters | `.orders-quick` `.orders-quick-item.header-quick-tab` | 订单二级筛选 | 仅内容和选中值可变 |
| HeadSummary | `.head-summary-text` | 商品、订单、统计、板卡、维护、阶梯定价 | 文案可变，视觉层级固定；阶梯定价的实际北京时间区间放在帮助Sheet和渠道详情中，主列表不重复已选周期 |
| OrderCard | `.order-card` `.order-card-top` `.order-card-role` `.order-card-line` | 订单、商品及相关列表 | 通过附加类增加领域差异 |
| StatusTag | `.chip` `.order-chip` `.plat` 及已有语义变体 | 商品、订单、统计状态 | 新状态必须保留统一语义 |
| Pager | `.pager` `.page-info` + `.btn` | 商品、订单、风控 | 页码和禁用状态可变 |
| Overlay | `.overlay` `.overlay-card` | 提示和确认类遮罩 | 内容可变，不重建遮罩层 |
| Sheet | `.sheet` `.sheet-card` `.sheet-head` `.sheet-actions` `.sheet-btn` | 商品操作、授权、成本、板卡、渠道价格 | 字段和动作可变，外壳固定 |
| GameAvatar | `.game-avatar` + 图片资源 | 商品、订单、统计、定价、板卡 | 图标和无图回退可变 |
| Toast | `.toast` 及 `.toast-detail` 反馈变体 | 全局轻提示和渠道错误详情 | 普通提示定时关闭；详情模式允许 `durationMs=0` 持续展示，并由用户点击关闭 |
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
| ChannelPriceResult | `.pricing-package-table` `.pricing-package-row` `.pricing-error-log-list` `.pricing-log-detail-btn` | 阶梯定价渠道价格 Sheet | 所有渠道和视口统一使用表头表格，套餐列读取渠道能力的 `package_labels`，窄屏由 `.pricing-package-scroll` 横向滚动；当前档仅高亮已确认应用的档位，目标档独立展示，未知档显示“未应用”；有效订单按号主计数模式统计，显示周期、订单数和北京时间起止区间；换档失败展示错误；调价记录统一展示成功/失败、触发来源和前后价格；失败详情复用持久 Toast；内容区必须可滚动；不得把渠道特有字段写入通用账号卡片 |
| ChannelPriceSummary | `window.ChannelPriceSummary.formatSuffix(summary)`，`h5/public/js/ui/channel_price_summary.js`；复用 `.plat` | 商品列表全部游戏使用同一后缀格式 | 接在原渠道状态后，格式为“ · 2档 · ¥2.30/时”；档位取渠道最后成功应用记录，时租取同步快照；ZHW仅日租优先展示已确认日租套餐对应的 `hour_basis` 计算基价，缺少基价时兼容旧有效时租快照，不使用未启用时租接口的旧值或未确认目标价；不推导目标档、不展示调价异常；未知档为“未应用”，缺价为 `--`；停用/未关联渠道及已售商品不追加；商品页变体仅限制宽度和换行；验证 API 身份隔离、缺失数据、失败保留旧档、多游戏及手机/桌面布局 |
| ProductIncomeSummary（试用） | `window.ProductIncomeSummary.render(item, { soldView })`，`h5/public/js/ui/product_income_summary.js`；复用 `.purchase-brief` 和 `.purchase-brief-line` | 商品列表四游戏共用同一采购、成本及累计租金结构 | 在售卡片保留原采购价、采购日期，其后以相邻两行固定展示“总成本 ¥500.00”“累计租金 ¥368.50”；同一容器内 `data-slot=total-cost/rental-income` 为紧邻兄弟，使用原纵向 Grid 和2px行距，不横排、不新增回本/差额/按钮。总成本等于采购价也保留，缺失或默认0的未配置成本显示 `--`；累计租金取 `rental_income={status:'ready',amount:number}` 的有限金额，明确0显示 `¥0.00`，退款/冲正的负值按实际显示，缺失、不可用或非法值显示 `--`，不扣成本。没有采购信息仍展示两行。已售卡片保持原采购和成本显示条件，不新增累计租金。验证金额精度、零与负数、缺失、相同成本、异常输入、已售回归、四游戏及手机/桌面布局 |
| DailyPricePolicy（试用） | `window.DailyPricePolicy`，`h5/public/js/ui/daily_price_policy.js`；`draft/parse/render/preview/bind` | 套餐倍率页面三渠道共用，不按游戏分叉 | 接受日租模式、四档系数、渠道能力与演算时租价；复用 HeaderTabs、Field、HeadSummary 和现有定价表单类，无新增 CSS 或内联样式；跟随时租、持平、递减切换；递减四档均可编辑，比例大于0且不超过100%，后续不得递增，均乘未折扣的首档日租基准价；递减模式下，U号租包夜、悠悠2/3/5/7/9/10小时套餐分别按未折扣首档套餐基准乘同一系数，预览显示各套餐四档金额；时租和包周/168小时不变；跟随、持平及租号王不改变短套餐；演算值不持久化，各渠道草稿隔离；验证解析异常、精度、切换、保存与重载，以及三渠道手机/桌面布局 |
| HelpSheet（试用） | `window.HelpSheet.bind(trigger, sheet, closeButton)`，`h5/public/js/ui/help_sheet.js` | 阶梯定价全部四个游戏共用档位说明 | 复用现有 `.drawer-help-btn`、Sheet 和 HeadSummary，不新增 CSS；阶梯计数说明由当前号主模式驱动，所有游戏共用相同四档映射；重复绑定幂等；问号点击打开，关闭按钮/遮罩/Escape关闭；维护 aria-expanded/aria-hidden、打开聚焦关闭按钮、关闭归还触发器焦点，Tab锁定唯一操作；无业务读写；验证缺少节点、重复渲染、键盘、四游戏及手机/桌面布局 |
| PricingFeatureState（试用） | `window.PricingFeatureState`，`h5/public/js/ui/pricing_feature_state.js`；`read/merge/confirms/status/isRejected/withTimeout`，不操作 DOM | 阶梯定价全部四个游戏共用号主级周期配置状态 | 保存选择与后台处理进度分离；合并配置必须校验明确模式及版本，丢弃较旧版本完整响应，不能用默认24小时覆盖已保存选择；同版本允许完成重算，不允许旧待处理状态倒退；保存和回查请求各有15秒时限，超时先回查，不直接回退；明确失败才恢复上次确认配置；跨游戏、跨号主旧请求不得覆盖新列表。周期反馈只允许“待生效 / 已生效 / 保存失败”，未读取到可信配置时隐藏，不增加第四种可见状态；“已生效”仅代表计数周期重算，不代表所有渠道改价成功。验证正常保存、旧响应、失败与不确定结果、版本冲突、跨游戏并发、换号主及四游戏手机/桌面布局 |

“试用”不表示禁止使用，而是表示复用时必须优先补齐公共契约，不能继续复制。

### 悠悠在线授权状态（试用）

- 实现：`window.UuzuhaoAuthStatus`，`h5/public/js/ui/uuzuhao_auth_status.js`；四游戏商品卡片共用，不新建卡片或状态标签组件。
- 数据契约：`uuzuhao_auth_state.required === true` 时显示待授权；缺省或非布尔值不解释为待授权。手工响应通过 `applyState` 合并，低版本响应不得覆盖高版本状态。`messageFor(item)` 按标记的 `error_code` 选择提示：`12101001` 显示“悠悠商品不存在”，指导检查并恢复商品、必要时重新授权；其他值兼容原 QQ 鉴权失败提示。旧 `message` 常量保留兼容，不用于商品缺失提示。
- 顶部复用 `.chip`、`.status-main-chip`、`.plat-abnormal`：“状态正常”替换为“需重新授权”；已有黑名单/维护等原因保留原标签，旁边增加授权标签。已售主状态不变。
- 渠道标签复用 `.plat.plat-abnormal`，只将悠悠状态部分替换为“授权异常”；原 `ChannelPriceSummary` 的最后成功档位、渠道价格和缺值回退全部保留，其他渠道不变。不重写实际渠道上下架状态。
- 点击授权异常标签通过现有持久 Toast 展示 `messageFor(item)` 对应原因和恢复建议，并说明点击“状态查询”恢复；手工恢复不修改在线风控开关。带标记时不展示旧在线快照。
- 页面布局仅用 `#listView .product-card[data-auth-required="true"]` 变体允许顶部标签换行、禁止挤窄状态标签，不改变其他卡片布局。
- 验证：`test/uuzuhao_online_auth_frontend_test.js`、`test/uuzuhao_online_auth_visual_test.js`；覆盖四游戏、320/375/390/430/768/1280px、维护状态、QQ 鉴权失败/商品不存在两种原因、价格保留、请求失败及手工恢复；商品缺失持久 Toast 单独验证手机/桌面完整显示。

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
| Pricing | `.pricing-ladder-head` `.pricing-title-row` `.pricing-settings-row` `.pricing-ladder-list` `.pricing-account-card` `.pricing-ladder-grid` `.pricing-copy-field` `.pricing-count-field` `.pricing-search-field` `.pricing-channel-tabs` `.pricing-package-table` `.pricing-ratio-panel` `.pricing-ratio-grid` `.pricing-ratio-example` `.pricing-ratio-result` | 基于 GameTabs、Panel、Card、Field、ListSearch、CardAction、PageAction、HeaderTabs、Sheet；四档统一时租输入、账号复制、当前游戏内搜索、渠道动态套餐列和按渠道套餐倍率表单为页面变体。标题与配置分层；订单周期和FeatureSwitch组成等宽两列，标签同基线、36px控件行同中心；select保留原生键盘行为，箭头用页面变体内缩14px，宽度最多192px。周期标签同行放置 `#pricingCountStatus.head-summary-text`，使用 `role=status`、`aria-live=polite`、`aria-atomic=true`，且由select的 `aria-describedby` 关联；`data-state=pending/effective/failed` 分别复用 `--warn/--ok/--danger`，仅显示“待生效/已生效/保存失败”，不另占一行。右侧FeatureSwitch只显示“已开启/已关闭”，不混入周期保存或重算状态。实际窗口仅放帮助Sheet/渠道详情，主列表无重复说明；无数据时隐藏空窗口。全号主的滚动24小时/每日06:00设置通过PricingFeatureState共用保存版本，保存中及配置未确认时禁用控件；选择后立即保持新选项和“待生效”，明确保存失败才回退；成功保存不等于已生效，关闭自动调价时新设置仍待生效；列表刷新失败不回退已确认保存，较旧响应及跨游戏旧请求不得覆盖。手机与桌面均不允许页面横向溢出。套餐倍率页直接复用 HeaderTabs、Panel、Field 与 PageAction，头部示例时租价只用于前端演算、不持久化，结果以普通文字紧跟各倍率字段展示；不在通用账号卡片写入渠道字段 |
| Board | `.board-top-row` `.board-card` `.board-mobile-card` `.board-account-list` `.board-account-tag` | 基于 PageAction、Panel、Card、GameAvatar |
| Maintenance | `.maintenance-top-row` `.maintenance-summary-grid` `.maintenance-kpi-card` `.maintenance-log-card` `.maintenance-status-pill`；清理记录使用 `.maintenance-detail-table` 统一展示数据表、日志文件和数据库压缩结果；页面及 Grid 子项必须允许收缩，移动端仅表格容器横向滚动并固定项目列；`640px` 以下顶部操作改为纵向、指标卡改为两列，`360px` 以下改为单列 | 基于 Panel、Card、StatusTag、Table、PageAction |
| Products | `.product-filters` `.product-filter-tab` `.product-op-btn` `.product-op-btn-danger` `.product-income-brief` | 基于 HeaderTabs、Button、CardAction、OrderCard；ProductIncomeSummary复用原采购brief纵向Grid显示相邻总成本和累计租金，不新增横向指标块。`#listView .product-income-brief`仅允许容器收缩和长金额自然换行，保留原2px行距，不截断金额，不影响已售采购brief。仅在售卡片新增累计租金，已售卡片维持原展示 |

页面变体只记录与基础组件不同的部分。若变体被第二个页面采用，应重新评估并提升为公共变体或公共组件。

阶梯周期等待状态仅在当前可见的阶梯页面每15秒通过原列表GET复查，单次最多20轮（间隔合计约5分钟，请求耗时另计）；已关闭、已生效、保存失败、离页或注销后不继续请求。编辑或保存账号价格期间暂停，编辑期间发起或迟到的轮询不重建表单、不覆盖价格草稿。后台复查使用共享请求的 `background: true` 选项，不弹全局加载；普通请求默认行为不变。达到轮询上限后仍可手动刷新重新确认，不把超时解释为保存失败。

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
