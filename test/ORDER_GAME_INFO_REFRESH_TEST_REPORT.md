# 订单终态刷新悠悠账号资料：实现与验收报告

验收日期：2026-11-12（Asia/Shanghai）。当前结论：实现及本地验收通过；**未发布生产、未启用自动刷新**。

## 变更范围

| 文件 | 用途 |
| --- | --- |
| `order/game_info_refresh_policy.js` | 配置读取、五种终态、20分钟含边界、启用历史范围、业务锁命名 |
| `order/game_info_refresh_service.js` | 同步前观察、同步成功后登记、发送前校验、一次调用及脱敏结果保存 |
| `database/order_game_info_refresh_db.js` | 订单库永久防重记录、同步令牌、原子领取、失败及未知结果保存 |
| `database/migrations/20261112_023_order_game_info_refresh.js` | 创建执行表，首次写入默认关闭的 uid=8 灰度配置 |
| `order/game_info_refresh_worker.js` | 异步消费、Runtime owner租约与续租、日志及运行批次汇总 |
| `order/order.js` | 单用户、全用户同步入口接线；刷新异常独立隔离 |
| `scripts/merge_code.sh` | 既有发布流程增加新 Worker 的停止项，未执行发布脚本 |
| `package.json`、`test/*order_game_info_refresh*` | 隔离测试入口及逐文件覆盖率门槛 |
| `test/uhaozu_pending_status_smoke_test.js` | 旧回归固定夹具日期，补充价格库临时路径，避免污染真实库 |
| `order/PRD_ORDER.md` | 更新实际触发口径、配置、运行边界及回退方式 |

原有主库与 Runtime 库的未提交变更已保留；未提交或覆盖这些运行态文件。

## 环境及执行方式

- 本机 Node.js、SQLite；每个测试入口使用独立的主库、Runtime、订单、统计、价格临时库。
- 测试固定 `TZ=Asia/Shanghai`，关闭本地自动任务；业务日期使用明确夹具。
- API 使用 stub 或本地 HTTP 夹具。测试预加载保护拒绝外部 HTTP，未被 stub 替换的外部请求即使被业务代码捕获，也会使测试失败。没有执行真实平台写请求。
- 正式命令：`npm run coverage:order-game-info-refresh`。
- 执行结果：**25/25 个测试入口通过，失败项0**；其中 Service 为95个用例。日志保存于 `coverage/order-game-info-refresh/test-logs/`。
- 额外检查：8个实现及测试工具文件的 JavaScript 语法、发布脚本 shell 语法、`git diff --check` 均通过。
- DB/迁移、Service、订单入口与 Worker 经过交叉只读复核；发现并修复了“本轮同步失败但旧水位仍新鲜”的待处理任务发送风险。

## 用例分类与结果

| 分类 | 关键验证 | 结果 |
| --- | --- | --- |
| 正常触发 | 四个来源渠道；已完成、部分完成、已退款、已撤单、投诉/撤单；更新正确悠悠商品 | 通过 |
| 边界及历史 | 1199秒不触发、1200秒触发；结算中不触发；无效/未来时间；启用前终态不补发；启用后观察的旧在租订单可触发 | 通过 |
| 配置与授权 | 默认关闭、灰度用户、未来启用时间、缺失/非法配置、配置读取失败、用户停用、渠道授权过期或暂停 | 通过 |
| 状态与映射 | 无悠悠商品、商品更换、跨号主/游戏/账号隔离、新在租订单阻断、订单恢复在租 | 通过 |
| 同步代际 | 旧pending在新轮开始后不可领取；失败轮不恢复；下一成功轮恢复；旧Worker即使预检完成也不能用旧令牌领取；扫描中断不恢复 | 通过 |
| 永久防重 | 并发登记/领取、重复同步、重启式重新消费、Runtime租约过期、业务场景及来源渠道隔离、逻辑删除不释放唯一身份 | 通过 |
| 发送异常 | 业务失败、HTTP失败、超时、断连、返回格式异常、结果保存失败；失败/未知均不自动重发 | 通过 |
| Worker | 默认关闭不启动、异步启动失败、全局owner租约、丢租约停止、运行记录写失败不改变调用次数、汇总日志 | 通过 |
| 迁移与回归 | 跨库迁移分步失败重跑、已有配置不覆盖、队列公平性；订单规则、冷却期、授权撤销、收益、阶梯定价、多渠道入口及发布排除规则 | 通过 |

## 完整文件覆盖率

以下范围是本次实质修改的 **6个核心文件完整内容**，不是仓库全量覆盖率。没有排除难测代码；每个文件行覆盖率均达到90%要求。

| 文件 | 行 | 分支 | 函数 |
| --- | ---: | ---: | ---: |
| `database/order_game_info_refresh_db.js` | 100% | 96.96% | 100% |
| `database/migrations/20261112_023_order_game_info_refresh.js` | 100% | 100% | 100% |
| `order/game_info_refresh_policy.js` | 100% | 100% | 100% |
| `order/game_info_refresh_service.js` | 100% | 93.99% | 100% |
| `order/game_info_refresh_worker.js` | 96.52% | 77.77% | 100% |
| `order/order.js` | 99.41% | 81.64% | 100% |
| **上述文件合计** | **99.41%（2878/2895）** | **86.35%（1291/1495）** | **100%（130/130）** |

机器可读结果：`coverage/order-game-info-refresh/core-coverage.json`；HTML：`coverage/order-game-info-refresh/index.html`。未覆盖行主要为 Worker CLI 顶层异常出口及订单旧链路的少数异常路径；线上第三方实际可用性不由离线测试证明。

## 本地迁移与启动验证

- 迁移前已对本地5个数据库做 SQLite 一致性备份，目录：`/Users/rs/Library/Application Support/rent_task/local-backups/order-game-info-refresh-20261112-175525/`，备份权限0600。
- 本地 `20261112_023` 迁移成功；再次运行待迁移数为0，无重复变更。
- 已核对订单库新表包含公共字段及同步令牌字段，当前执行记录为0条。
- 本地主库配置为 `{"enabled":false,"user_ids":[8],"activated_at":""}`。没有启用功能。
- 已重启本地 H5，保留 `SHEEP_FIX_ENABLE=false`；8080端口仅一个监听进程，`GET /api/ping` 返回 `ok:true`，启动错误日志无新增错误。

## 剩余边界、发布与回退

- 永久记录保证“最多一次自动尝试”，不保证必达：若发送标记落库后进程在真正发请求前崩溃，该订单可能零次实际请求；超时及结果未知也不自动重试。
- 依赖订单源 `start_time/end_time` 的租赁时长口径及成功同步后的事实；同步不完整、授权或当前在租检查不通过时阻断或延后处理。
- 本轮未做生产发布或生产启用。发布仍须显式授权并使用既有唯一发布流程；灰度启用需单独设置有效 `activated_at`。
- 暂停时关闭该通用配置；回退代码应保留执行表及已尝试记录，避免删除防重事实后重复发送。
