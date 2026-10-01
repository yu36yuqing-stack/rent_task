# 阶梯定价滚动 24h 与运行日志测试报告

- 日期：2026-10-01，Asia/Shanghai。
- 基线：`54f7282`；覆盖率包含当前未提交的滚动定价与日志累计改动，不是只统计本轮日志。
- 环境：macOS、Node.js v24.13.0、sqlite3 3.44.2、c8。
- 测试采用临时隔离数据库、注入的渠道发布器和 API fixture，不操作生产数据或真实渠道价格。
- 已完成本地实现和验证，未提交、未发布生产。

## 实现范围

滚动计数复用通知使用的有效订单查询，窗口为 `[now-24h, now)`，按 `start_time` 计数；在租、出租中、结算中或实收大于零的订单贡献计数，过滤逻辑删除记录。0、1、2、至少3单分别使用第1、2、3、4档。

每轮检查已配置账号的各渠道档位，不依赖新完成订单、业务日期或凌晨6点重置。失败渠道独立保留已应用档位和30分钟重试时间，等待期间刷新目标档。订单同步不完整、计数查询异常不按零订单改价。同档的渠道手工价格仍不自动覆盖。

本轮日志代码修改位于 `price/price_ladder_reconcile_service.js` 与 `order/order.js`。不新增数据表、迁移、告警通知或调价策略。

## 执行结果

| 命令 | 结果 |
| --- | --- |
| `npm run coverage:price-rolling` | 20个测试脚本全部通过；逐文件改动行及核心整文件行覆盖率门禁通过 |
| `npm run coverage:price-ladder` | 定价、渠道适配器、发布器、H5 API及相关回归通过；定价范围行覆盖率95.64% |
| `npm run test:order-service-regression` | 6个订单相关脚本通过，部分脚本与上面的套件复用 |
| `node test/pricing_ladder_visual_check.js` | 前一阶段滚动定价页面验证通过：1365px桌面、390px手机、价格表、抽屉、保存、复制、搜索、错误详情；本轮没有新增视觉改动 |
| `git diff --check` | 通过 |
| 本地H5重启及 `/api/ping` | launchd重新启动，端口8080监听，返回 `ok=true` |

新增日志断言验证了真实业务结果及数据库状态，不以“执行过代码”替代结果断言。

| 用例分类 | 已验证结果 |
| --- | --- |
| 同档正常 | 仅输出start与summary，不逐账号打印unchanged |
| 升档、降档、已有档位纠偏 | 原档、目标档、订单数和渠道发布结果正确；时间到期无新订单也能降档 |
| 发布器确认无需写入 | attempted=1，result=unchanged，仍记录确认后的档位 |
| 三渠道部分失败 | 独立成功/失败；summary为partial_failed；扫描账号数与渠道数区分正确 |
| 等待重试 | 不调用发布器；日志记录最新目标档、原错误、next_retry_at和retry_waiting |
| 渠道停用 | 跳过发布；记录channel_unavailable，不累计为failed |
| 订单同步不完整 | 不发布；count_24h为null、count_snapshot_valid=false，不伪造零订单 |
| 计数查询或初始化异常 | 真实临时表缺失导致异常；记录error汇总并继续向上抛原异常，不变更确认档位 |
| 功能关闭 | 订单入口记录skip；保持关闭状态下不加载定价模块的原有行为 |
| 任务关联 | Order Worker的trigger_task_id传递为trace_id；同轮事件具有相同trace_id |
| 日志写入失败 | 注入抛异常的logger，业务结果不受影响 |
| 安全 | 错误消息中的token、app_secret、Authorization/Bearer脱敏；不输出授权或原始API载荷 |

## 覆盖率

相对`HEAD`的6个业务JavaScript文件新增/修改可执行行：**249/249，100%**。删除的旧逻辑不进入可执行行分母；HTML及样式契约通过页面测试验证。

| 文件 | 改动行 | 整文件行 | 整文件分支 | 整文件函数 |
| --- | --- | --- | --- | --- |
| `database/order_db.js` | 6/6 | 80.37% | 53.75% | 89.47% |
| `order/order.js` | 7/7 | 19.26% | 14.89% | 6.77% |
| `order/service/order_query_service.js` | 1/1 | 89.06% | 46.82% | 88.88% |
| `price/price_ladder_reconcile_service.js` | 186/186 | 98.30% | 84.88% | 100% |
| `price/price_ladder_service.js` | 21/21 | 96.14% | 74.69% | 93.33% |
| `h5/public/js/menu_price.js` | 28/28 | 52.91% | 66.44% | 65.30% |

两个实质修改的定价核心服务整文件行覆盖率均超过90%。大文件其余未改业务不是本次全量测试范围，不宣称全仓或所有分支达到90%。`coverage:price-ladder`限定的定价范围行/分支/函数覆盖率为95.64%/75.23%/97.63%。

报告位置：

- `coverage/price-rolling/index.html`：6个累计改动业务文件的整文件覆盖率。
- `coverage/price-rolling/changed-lines.json`：逐文件改动行结果及90%门禁。
- `coverage/price-ladder/index.html`：既有定价范围回归覆盖率。
- `coverage/price-ladder/`：前一阶段手机、桌面截图。

覆盖率目录继续保持Git忽略，不上传或回传宿主机。

## 线上观察方法

订单Worker执行时，新日志复用`log/order_worker.log`；手工请求中产生的日志进入H5进程的现有标准输出/错误日志，不另建文件。新PriceLadder日志不依赖`ORDER_COUNT_TRACE`开关。

在对应环境的项目根目录查看：

```sh
rg '\[PriceLadder\]' log/order_worker.log
rg '\[PriceLadder\]\[summary\]' log/order_worker.log
rg '具体账号' log/order_worker.log
```

| 事件 | 含义 |
| --- | --- |
| `[PriceLadder][start]` | 进入一轮定价处理，包含用户、trace_id、滚动窗口和allow_apply |
| `[PriceLadder][apply_start]` | 开始某渠道调价尝试，包含账号、游戏、渠道、计数、from_tier、to_tier及目标价格 |
| `[PriceLadder][result]` | 调价结果或未执行原因，包含状态、错误、重试时间；同档正常不打印 |
| `[PriceLadder][summary]` | 轮次耗时、扫描账号/渠道数、attempted/applied/unchanged/failed/pending/skipped/retry_waiting |
| `[PriceLadder][skip]` | 功能关闭或读取功能配置失败，未进入定价轮次 |

`scanned_channels`及结果计数按“账号+游戏+渠道”计，`scanned_accounts`按“账号+游戏”去重。`attempted`是发布器调用尝试数，不是底层HTTP请求数；`retry_waiting`属于pending的子集。正常同档时attempted=0、unchanged>0是预期行为。

正常轮次看`status=ok`且failed=0；部分渠道失败看`status=partial_failed`；待同步或待重试看`status=pending`并按trace_id找原因；整轮异常看`status=error`与error_message。扫描异常的scanned_channels为null，不误报为空扫描成功。

`apply_start`没有对应result/summary时可能仍在执行、请求卡住或进程退出，不能当成发布成功。窗口字段的ISO时间带Z，表示UTC；北京时间需加8小时。next_retry_at沿用业务库本地时间格式。

不要以OrderSync的ok=true替代上述检查：日志增强不改变原有订单任务的成功判定或通知策略。日志只证明程序已执行及已有渠道验证结果；同档时不主动检测平台手工改价漂移。

## 风险与发布

- 当前失败项为0；尚未执行生产渠道真实改价验收。
- 未覆盖核心文件的全部旧分支，包括超过200个账号的分页路径和部分参数兜底；改动可执行行无遗漏。
- 本地`database/rent_robot_runtime.db`在本次修改前已被只读quick_check确认损坏，未修复或覆盖。隔离测试结果不等于该本地库已恢复；ping成功也不代表数据库完整性检查通过。
- 本地H5仍由原launchd配置托管，未修改系统配置或后台Worker设置。
- 本次无新数据库结构迁移。正式发布仍须单独授权并执行项目production-release流程，保留旧代码版本；不能把本地运行态数据库覆盖生产库。
- 日志代码回滚不影响数据结构；整个滚动定价版本回滚会恢复旧策略，但不会自动撤销已发布到渠道的价格。异常时可先关闭阶梯定价功能，再按受审发布流程回滚。
