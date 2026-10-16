# 阶梯定价计数周期切换测试报告

- 日期：2026-10-16，时区 Asia/Shanghai。
- 基线提交：`ded314e`。
- 环境：macOS、Node.js、SQLite、c8、Puppeteer / Google Chrome。
- 测试使用隔离的临时数据库和模拟渠道发布器，未访问生产或向真实渠道提交改价。

## 实现范围

- 新增号主级 `count_mode`：`rolling_24h` 默认、`business_day` 每日北京时间06:00切日。
- 查询窗口分别为 `[now-24h, now)` 和 `[最近一次北京时间06:00, now)`，按订单开始时间、秒精度、左闭右开统计，排除未来订单。
- 保留有效订单口径：在租、出租中、结算中或实收大于零；按用户、游戏、账号隔离，过滤逻辑删除记录。
- 列表、套餐详情、保存规则初始化及后台调价共用 `price_ladder_count_service`。
- 默认四档映射、渠道套餐倍率、日租策略、发布接口及重试退避继续沿用现有实现。
- 配置版本变化会阻止旧计数快照继续确认或下发；切换模式且目标档位相同时不额外调用发布器。
- 配置表新增 `count_mode` 与 `reconcile_reason`。后者区分首次开启校准和纯周期重算，避免模式切换触发同档强制发布。旧客户端省略模式时保留原选择。
- 首次启用校准入队一轮后沿用原重试机制；模式切换等待本轮成功处理后清除待重算标记，避免失败渠道每轮绕过30分钟退避。

## 改动位置

- `common/price_ladder_count_mode.js`：模式校验、统一北京时间窗口。
- `price/price_ladder_count_service.js`：读取号主模式并查询订单数。
- `database/order_db.js`、`order/service/order_query_service.js`：共享有效订单SQL，保留原滚动查询并新增固定周期查询；已有 `natural_day` 查询保持原行为。
- `database/price_ladder_feature_config_db.js`、`database/migrations/20261016_020_price_ladder_count_mode.js`：配置持久化、旧表幂等补列、版本保护。
- `price/price_ladder_service.js`、`price/price_ladder_reconcile_service.js`：统一计数、返回窗口、模式一致性保护和运行日志。
- `h5/local_h5_server.js`：透传配置、映射非法模式为400、版本冲突为409。
- `h5/public/index.html`、`h5/public/js/menu_price.js`、`h5/public/css/app.css`：标题和配置分层，周期选择与自动调价配置对齐，动态文案、帮助内实际北京时间范围及资源版本。

## 执行结果

| 检查 | 结果 |
| --- | --- |
| `npm run coverage:price-rolling` | 22个测试脚本通过；逐文件改动行及定价核心整文件90%行覆盖率门禁通过 |
| `npm run coverage:price-ladder` | 三渠道阶梯定价、套餐倍率、发布、迁移、H5 API与相关订单回归全部通过 |
| `npm run test:daily-price-policy` | 日租计算/折扣、真实发布器桩接口、说明组件、四游戏页面及租号王价格快照相关回归通过 |
| `node test/pricing_ladder_visual_check.js` | 桌面1365×900、手机320/360/390×640通过；切换保存、刷新持久化、切回原模式、详情一致、空账号头部、配置标签与控件对齐及无横向溢出 |
| `git diff --check` | 通过 |
| 本地服务重启与 `/api/ping` | launchd重启成功，返回 `ok=true` |
| 本地迁移 | 已应用 `20261016_020`，未修改已有模式选择或现有阶梯价格配置 |

关键用例：

- 06:00前、恰好06:00、06:00后；跨月、跨年；同一时刻两种模式得到不同订单数与档位。
- 同一模式在主机 `TZ=UTC` 下仍使用北京时间窗口，SQL结果一致。
- 在租、结算中、实收、零实收、取消、未来订单及用户/游戏隔离。
- 三渠道随模式升档、降档；新周期无需额外清零任务；列表、详情与初始化结果一致。
- 已开启、已关闭、关闭再开启、旧客户端省略字段、非法模式400与并发版本409。
- 模式切换同档去重，不覆盖渠道手工价格；中途切换模式或配置版本后，不下发旧快照。
- 同步不完整或SQL查询失败不按零订单处理、不更改确认档位。
- 首次启用不完整同步不入队；部分失败后12:05仍等待、12:30只重试失败渠道，成功渠道不重复下发。
- 旧schema重复迁移和并发初始化；旧的待开启校准优先于随后模式切换，过期任务不能清掉新版本标记。

## 覆盖率

`coverage:price-rolling`：本次新增/修改的可执行行 **287/289 = 99.31%**。

| 文件 | 整文件行 | 分支 | 函数 |
| --- | --- | --- | --- |
| `common/price_ladder_count_mode.js` | 100% | 100% | 100% |
| `price/price_ladder_count_service.js` | 100% | 100% | 100% |
| `database/price_ladder_feature_config_db.js` | 99.03% | 96.29% | 100% |
| `database/migrations/20261016_020_price_ladder_count_mode.js` | 100% | 100% | 100% |
| `price/price_ladder_reconcile_service.js` | 96.90% | 84.78% | 100% |
| `price/price_ladder_service.js` | 96.25% | 80.34% | 93.33% |

`coverage:price-ladder`限定的既有定价范围：行94.96%、分支76.31%、函数97.68%。这不是全仓覆盖率。

订单数据库、订单查询网关、H5服务和页面JS属于已有大型文件，本次改动可执行行全部覆盖；其余旧业务未宣称达到90%。未覆盖的新增两行是旧表初始化异常时的回滚/重新抛出路径；正常、幂等、并发迁移路径已验证。

覆盖率明细：`coverage/price-rolling/index.html`、`coverage/price-rolling/changed-lines.json`。

## 组件与页面验收

复用现有 Field/select、FeatureSwitch、HeadSummary、HelpSheet；仅在 `#pricingView` 下扩展周期字段布局，没有新增公共组件或独立设置页面。标题独立一行，周期与自动调价组成等宽配置列，标签同基线、控件行同中心；select保留原生键盘交互，箭头内缩14px。主列表去掉重复周期与时间范围，实际区间移入帮助Sheet，缺失区间时隐藏空段。关闭、开启、待重算使用简短状态文案。注册表 `h5/COMPONENT_GUIDE.md` 已同步更新。

影响阶梯定价列表、账号渠道结果Sheet和周期帮助Sheet；覆盖四个游戏的公共帮助契约、桌面与手机、保存中禁用、失败恢复选择及版本冲突提示。套餐比例设置页通过原视觉流程回归。

截图：

- `coverage/price-ladder/pricing-count-mode-desktop.png`
- `coverage/price-ladder/pricing-ladder-mobile.png`
- `coverage/price-ladder/pricing-header-detail.png`
- `coverage/price-ladder/pricing-header-empty-desktop.png`
- `coverage/price-ladder/pricing-header-mobile-320.png`

## 风险与发布

- 当前无阻塞失败项。各渠道真实写入结果需发布后观察既有PriceLadder日志；自动化没有改动真实渠道价格。
- 保存模式只更新设置，实际换档在下一轮完整、成功的订单同步处理；不会承诺06:00整秒已完成外部渠道请求。
- 本地服务启动已应用新增迁移；现有脏主库/运行库保留，未覆盖数据库快照。
- 尚未提交或发布生产。生产发布需单独明确授权并执行项目既有发布流程。
- 如需恢复原策略，可选择滚动24小时等待正常校准。旧代码不理解固定窗口配置，代码回滚前应先关闭受影响号主的自动调价；已下发价格不自动撤销。
