# 日租阶梯策略实施与测试报告

日期：2026-10-07。基线：`106b715`。本次仅本地实现和验证，未发布生产。

本报告数值为日租策略完成时的测试快照。后续阶梯页面简化新增两组测试并重新生成同一coverage目录，最新结果见 `test/PRICING_LADDER_HELP_TEST_REPORT.md`。

2026-10-08又放开了日租递减首档比例，最新行为和覆盖率见 `test/DAILY_PRICE_FIRST_FACTOR_TEST_REPORT.md`。本报告中的首档非100%拒绝用例为历史行为，不再适用。

## 1. 实际行为与改动范围

- H5 入口：阶梯定价 -> 套餐比例设置 -> 选择渠道 -> 日租阶梯。
- 每个用户、每个渠道独立设置 `follow`（跟随时租）、`flat`（日租持平）、`decrease`（日租递减）。适用于该渠道全部已配置、关联且未售账号，不按游戏分叉。
- 默认 `follow` 保持旧算法；持平取账号首档日租价，递减取首档日租价乘四档系数，建议 `100% / 100% / 95% / 90%`。先将首档基价按渠道精度处理，再计算后续档位。
- 仅改变 U号租 `day`、悠悠及租号王 `p24`；其他套餐仍沿用原有倍率计算。不改变滚动24小时订单口径、时租四档、上下架、风控、渠道启停或租赁模式。
- 保存策略或倍率前检查全部关联未售账号四档；较短套餐总价不得高于日租，较长套餐总价不得低于日租。保存账号时租四档时也检查已有日租策略，冲突拒绝写入，不暗改其他套餐。
- 同档改策略也递增配置版本并进入现有纠偏流程；失败保留最后成功记录、按现有机制重试。订单移出24小时窗口后恢复目标档日租，而非永久停留在最低价格。
- 日志：`[PriceLadder][apply_start]` 增加 `daily_policy`，结合现有 `target_prices`、渠道、档位、订单数、trace_id、result 和 summary 查看应用结果。

核心改动文件：`price/daily_price_policy.js`、`price/channel_package_ratio.js`、`price/package_ratio_service.js`、`price/price_ladder_service.js`、`price/price_ladder_reconcile_service.js`、三个 `price/channel_adapters/*_price_adapter.js`、`database/user_channel_package_ratio_db.js`、迁移 `20261007_019_daily_price_policy.js`、公共组件 `h5/public/js/ui/daily_price_policy.js`。

接入文件：`h5/local_h5_server.js`、`h5/public/js/menu_price.js`、`h5/public/index.html`；组件契约登记于 `h5/COMPONENT_GUIDE.md`；测试入口登记于 `package.json`。

## 2. 环境与命令

- macOS、本机 Node.js `v24.13.0`、SQLite、c8、Puppeteer + 本机 Chrome。
- 所有自动化业务测试使用临时 MAIN / PRICE / ORDER / RUNTIME / STATS 数据库。平台改价、查询和回读均为 stub，不调用生产写接口。
- 浏览器只允许访问临时本地 H5 服务，其他请求拦截取消；视口 `375 x 900`、`1365 x 900`，三渠道共六份截图。
- 覆盖率合并 Node V8 与浏览器真实 JS 执行数据，不通过虚构页面执行或排除未覆盖分支凑数。

```sh
npm run test:daily-price-policy
npm run coverage:daily-price-policy
```

执行结果：**38 组测试执行全部通过，覆盖率门禁退出码 0**。包括4组新测试与34组相关回归执行；回归入口之间有少量重复测试文件，此处不是38个独立场景的计数。

## 3. 功能覆盖

| 分类 | 验证内容 | 结果 |
| --- | --- | --- |
| 计算与边界 | 三模式、三渠道四档、输入类型、NaN、零、超100%、首档非100%、递增系数、精度归零、数据缺失 | 通过 |
| 兼容与不变项 | follow 与原价格一致；其他套餐不变；计算不修改原数据；旧客户端省略策略不覆盖已保存模式 | 通过 |
| 套餐冲突 | 短套餐高于日租、长套餐低于日租、非法新时租规则；拒绝后配置和版本不变；已售账号不纳入校验 | 通过 |
| 数据迁移 | 真实旧表补列、旧倍率与版本及时间保留、默认follow、重复迁移幂等、完整迁移注册与执行 | 通过 |
| 日常纠偏 | 同档保存强制调价、成功后不重复调价、有效订单增长升档、订单过期降档并恢复对应日租 | 通过 |
| 部分失败 | 两渠道成功一渠道失败、旧成功签名保留、仅失败渠道重试成功、恢复follow后实际重新发布旧算法价格 | 通过 |
| 实际发布服务 | 两种新模式进入三渠道真实发布Service，stub边界检查请求日租值及其他套餐值、成功日志与回读；ZHW小时+日租/仅日租模式不改变 | 通过 |
| H5 API | 未认证401、保存200、版本冲突409、非法模式及价格冲突400、失败不持久化 | 通过 |
| H5 浏览器 | 模式切换、系数输入、时租/倍率变化实时演算、保存重载、渠道草稿隔离、非法输入不提交、隐藏的非法草稿不阻止恢复follow | 通过 |
| 视觉与组件 | 三渠道手机/桌面，无横向溢出，按钮高度；复用既有Panel、Field、HeaderTabs、HeadSummary、PageAction，无新增内联样式 | 通过 |
| 共享回归 | 原阶梯开关、三渠道发布/回读、商品同步与价格快照、商品展示、订单查询/写入/冷却、统计刷新、H5权限、迁移流程 | 通过 |

测试中曾发现日租冲突被映射为500，已修复为领域错误码 `DAILY_PRICE_POLICY_INVALID`，由BFF映射400；最终重跑无失败项。

## 4. 覆盖率

相对于HEAD的新代码行及新增核心文件：**219 / 219，100%**。每个改动文件可测改动行均达到100%。HTML、文档、配置声明不计入JavaScript行覆盖率，HTML通过浏览器实际加载验证。

11个核心文件完整文件范围合计：**行98.41%（1981/2013）、分支85.12%（767/901）、函数98.14%（106/108）**。每个核心文件行覆盖率均超过90%，没有仅取改动行替代核心整文件门禁。

| 核心文件 | 行 | 分支 | 函数 |
| --- | ---: | ---: | ---: |
| price/daily_price_policy.js | 100% | 100% | 100% |
| database/user_channel_package_ratio_db.js | 100% | 89.41% | 100% |
| database/migrations/20261007_019_daily_price_policy.js | 100% | 100% | 100% |
| price/channel_package_ratio.js | 100% | 82.75% | 100% |
| price/package_ratio_service.js | 100% | 86.04% | 100% |
| price/channel_adapters/uhaozu_price_adapter.js | 100% | 80.43% | 100% |
| price/channel_adapters/uuzuhao_price_adapter.js | 100% | 85% | 100% |
| price/channel_adapters/zuhaowang_price_adapter.js | 97.33% | 80.70% | 92.30% |
| price/price_ladder_service.js | 96.23% | 76.02% | 93.33% |
| price/price_ladder_reconcile_service.js | 98.31% | 84.98% | 100% |
| h5/public/js/ui/daily_price_policy.js | 100% | 100% | 100% |

H5接入文件整文件：`menu_price.js` 行68.60%、分支67.10%、函数77.77%；`local_h5_server.js` 行33.80%、分支61.47%、函数35%。两文件本次改动行100%，但未覆盖所有无关页面和路由。

全部13个采集文件合计：行61.44%、分支74.62%、函数69.84%。**这不是全仓覆盖率，也不能描述为全仓达到90%。分支覆盖率并未达到90%。**

报告文件：`coverage/daily-price-policy/index.html`、`coverage-final.json`、`changed-lines.json`。详细执行输出：`/tmp/rent-daily-price-policy-tests.log`。六份截图位于同一coverage目录。coverage继续被Git忽略，不提交、不回传宿主机。

## 5. 本地状态、发布和回退

- 本地H5通过launchd重启，日志确认应用 `20261007_019`；`GET http://127.0.0.1:8080/api/ping` 返回 `ok: true`。本地实际业务库迁移只补配置列，未批量启用新模式或修改现有定价配置。
- 本次未提交Git、未发布生产。原有主库和runtime库未提交、未还原。
- 将来明确授权生产发布时按项目 production-release Skill 和 `scripts/merge_code.sh` 执行；启动迁移自动补列，旧配置默认follow。先确认迁移、健康检查及现有功能正常，再逐渠道显式启用新策略，观察一轮同步的apply_start/result/summary和平台回读。
- 开启阶梯定价的用户，保存日租策略后由下一轮现有同步纠偏；阶梯功能关闭时仅保存/排队，不会绕过功能开关调价。
- 回退价格：将对应渠道切回follow并保存，等待纠偏调价成功。代码回滚本身不会恢复渠道已经执行的价格；新列可保留，旧代码忽略该列，不需要删列。

## 6. 未覆盖风险

- 平台实际限价、套餐折扣约束、网络延迟及线上账号特例需要上线后逐渠道观察；本次没有以真实生产写接口验证。
- 悠悠现有查询只确认时租，套餐回读仍是 `verification_status=partial`。本次验证准确日租值进入请求及日志，但不把平台未返回的日租值宣称为已完整回读确认。
- 价格关系检查是保守的全套餐校验；若现有四档时租涨幅过大，递减日租可能低于夜租/短租总价，保存将被拒绝，需要显式调整倍率或日租系数。
- 38组测试含旧故障注入用例，日志中的模拟失败、部分失败不代表最终测试失败。没有进行真实生产负载或远程并发压测。
