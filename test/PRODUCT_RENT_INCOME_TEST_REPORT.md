# 商品卡片累计租金测试报告

- 日期：2026-10-22，Asia/Shanghai。
- 环境：macOS、Node.js、SQLite、c8、Puppeteer / Google Chrome。
- 需求：在售商品卡片中，“总成本”下方紧挨“累计租金”，纵向排列；不增加回本、差额、按钮或新面板。累计租金沿用统计页累计实收，不扣成本，不包含售出款。
- 本次只实现和验证本地代码；未提交、未发布或修改生产。本轮测试全部使用隔离临时数据库、桩响应或阻断API的浏览器fixture。

## 改动范围与兼容

| 文件 | 实际变化 |
| --- | --- |
| `database/product_income_db.js` | 按用户、游戏、当前页账号批量校验归属与采购配置；单条SELECT同时读取已有周快照和日收入，不执行schema初始化或新建业务表 |
| `stats/historical_income.js` | 提取共享历史累计算法：最新累计周快照加快照日期之后的日收入，避免重复相加；商品严格区分无数据和0，原统计调用保留既有回退语义 |
| `stats/product_income_service.js` | 当前页按游戏分组，输出 `game_id::game_account -> { amount, status }`；非法、缺失或读取失败降级为 `null / unavailable`，不影响商品列表 |
| `stats/order_stats.js` | 原历史聚合段改为调用共享算法；统计刷新、账号范围、订单归属、年化和成本口径保持不变 |
| `h5/local_h5_server.js` | 分页后并行编排渠道价格与累计租金；在售商品附加可选 `rental_income`；已售商品不查询、不增加字段 |
| `h5/public/js/ui/product_income_summary.js` | 四游戏共享采购与金额展示；总成本和累计租金是同容器内相邻兄弟行；成本等于采购价仍展示；缺失显示 `--`，已知0显示 `¥0.00`，有限负金额如实显示 |
| `h5/public/js/menu_products.js` | 采购摘要使用共享渲染器，传递在售/已售状态；原复制、订单数、倒计时、渠道和操作保留 |
| `h5/public/css/app.css` | 仅在售 `.product-income-brief` 变体允许收缩和长金额自然换行，不裁切、不横排，不影响已售采购摘要 |
| `h5/public/index.html` | 共享模块在商品脚本之前加载，相关静态资源版本更新至 `20261022a` |
| `h5/COMPONENT_GUIDE.md` | 登记 ProductIncomeSummary 试用组件、相邻行契约、缺失值和已售兼容 |
| `package.json` | 新增 `test:product-income`、`test:product-income-visual`、`coverage:product-income`，保留已有命令 |

没有新增数据库迁移、统计任务或真实渠道请求。累计租金不读取 `lifecycle_income_amount`，也不使用5E单渠道原始收入代替跨渠道累计实收。用户、游戏、账号分别隔离，不照搬统计“全部游戏”页按同号合并的显示键。

## 执行结果

| 检查 | 结果 |
| --- | --- |
| `npm run coverage:product-income` | 12个测试脚本全部通过；四个新增核心文件整文件及既有文件改动行90%门禁全部通过 |
| `node test/product_rent_income_visual_test.js` | 192例全部通过：168个在售场景 + 24个已售场景，四游戏 × 320/375/390/430/768/1280px |
| 语法与 `git diff --check` | 通过 |
| 本地H5重启与 `/api/ping` | 唯一 LaunchAgent 重启成功，健康检查 `ok=true` |

12个脚本包括：新收入Service、共享前端格式、真实H5接口，以及既有历史累计、统计刷新、渠道价格Service/前端/接口、CSGO操作、解除授权卡片、商品订单配置和阶梯接口回归。

### 正常、边界与异常

- 快照100加其后跨渠道10/20/5得到135；快照之前和同日的日收入不重复计入；最新快照、未来数据和逻辑删除过滤正确。
- 四个游戏的同号商品分别返回135、201、0、12.34；其他用户同号9001不串入。
- 明确0、有限负数、两位精度、无快照、仅快照、无记录、未配置采购信息、非法金额和溢出分别按合同处理。
- 统计来源失败、主库归属查询失败和单游戏失败均安全降级；HTTP产品列表仍正常返回，不输出内部异常详情。
- 未登录401；分页后只对当前页一次调用批量Service；空页和其他号主正确处理；接口查询前后日收入和周快照行完全一致。
- 已售页保留原售出价与生命周期收益，不调用新收入Service，不增加累计租金字段或新行。
- 前端真实渲染器与共享格式均验证成本/租金相邻，不出现待回本、已回本、差额或额外按钮；未知不能伪装成0。
- 浏览器验证相邻DOM兄弟、纵向几何位置、同采购价仍显示总成本、零值/未知/退款负数、长账号/名称/13位金额；复制事件、渠道档位/时租、订单数、倒计时和按钮顺序保留。
- 浏览器测试拦截所有API并确认0次业务API请求；Chrome关闭后清理测试拥有的stdio，正常退出，无强制成功退出。

### 首轮发现与修正

- 强化长金额场景发现320px卡片原nowrap样式可能裁切；已增加仅在售摘要的换行变体，最终192例通过。
- 首轮覆盖率门禁发现商品列表真实调用行只被浏览器执行、未进入Node覆盖率；补充真实 `renderList()` 的VM/DOM集成断言后，改动行全覆盖。未排除难测代码或调整90%阈值。
- 最终未通过项：无。

## 覆盖率

本命令限定范围内的新增核心及既有改动可执行行 **217/217 = 100%**。四个新增核心文件整文件行覆盖率均100%，不代表整个仓库或大型既有文件达到100%。

| 文件 | 行 | 分支 | 函数 | 说明 |
| --- | --- | --- | --- | --- |
| `database/product_income_db.js` | 100% | 95.23% | 100% | 新核心整文件 |
| `stats/product_income_service.js` | 100% | 100% | 100% | 新核心整文件 |
| `stats/historical_income.js` | 100% | 90.19% | 100% | 新核心整文件 |
| `h5/public/js/ui/product_income_summary.js` | 100% | 100% | 100% | 新共享前端模块整文件 |
| `stats/order_stats.js` | 72.79% | 39.49% | 80.95% | 既有大文件；改动2/2行覆盖 |
| `h5/local_h5_server.js` | 32.92% | 65.28% | 30% | 既有大文件；当前HEAD差异中的15/15行覆盖，包含前序未提交的周期接口改动 |
| `h5/public/js/menu_products.js` | 21.56% | 63.73% | 14.94% | 既有大文件；本轮改动3/3行覆盖 |

所有统计百分比均来自实际c8结果；没有宣称全仓覆盖率。覆盖率目录：`coverage/product-rent-income/code/`，逐文件门禁：`changed-lines.json`。

## 组件复用

| 元素 | 已有组件 | 决策 | 影响面 | 验证 |
| --- | --- | --- | --- | --- |
| 商品卡片/左右信息区 | OrderCard / `.info-squares` | 直接复用 | 四游戏商品及已售回归 | 六视口和原操作 |
| 成本/租金两行 | `.purchase-brief` / `.purchase-brief-line` | 直接复用纵向Grid，仅长金额页面变体 | 在售商品卡片 | 相邻DOM、上下位置、0/缺失/大金额 |
| 统一金额及已售兼容 | ProductIncomeSummary（试用） | 新建共享逻辑，不新建视觉面板 | 四游戏共用同一合同 | 整文件100%行覆盖与已售回归 |
| 游戏头像/状态/渠道摘要 | GameAvatar / StatusTag / ChannelPriceSummary | 保持不变 | 四游戏 | 复制、渠道档位、时租、状态与倒计时 |

## 风险与未覆盖范围

- 显示的是已有统计结果，不是实时订单拉取。当前统计依赖采购配置；未配置或没有可靠统计时显示 `--`，不扩展统计账号覆盖，不承诺平台接入前历史完整。
- 数据库读取异常与无统计均显示 `--`，不把内部错误传给前端；本轮未新增异常明细入口或持续告警。
- 未调用生产写接口，真实号主/渠道环境仍需单独完整发布后观察。此前生产发布中断问题不在本轮范围。
- 回滚只移除商品字段/展示并恢复原聚合调用，不回写成本、收入、已有统计或已售快照。

## 执行记录与截图

- 覆盖率执行日志：`/tmp/product-rent-income-coverage-final.log`。
- HTTP定向执行日志：`/tmp/product-rent-income-h5.log`。
- 视觉结果：`coverage/product-rent-income/visual-results.json`。
- 手机正常卡片：`coverage/product-rent-income/income-card-390-cost-equals-purchase.png`。
- 桌面卡片：`coverage/product-rent-income/income-card-1280-cost-equals-purchase.png`。
- 320px长金额：`coverage/product-rent-income/income-card-320-long-amount-account-name.png`。

工作区原有阶梯周期功能和运行态数据库改动均保留，没有回滚、覆盖或提交无关文件。
