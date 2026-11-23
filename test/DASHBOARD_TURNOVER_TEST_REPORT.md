# 看板周转率与结算口径验收

2026-11-23，本机 Node v24、SQLite 临时数据库、Chrome。业务及渠道回归使用隔离数据和测试服务；生产样本对照采用业务库本地副本，未向渠道重发订单。

| 验证 | 结果 |
|---|---|
| dashboard_operating_metrics_test | 跨周结束整单计入、无拆单、700% 不封顶、空闲账号入分母、采购/售出日、追加成本、无成本收入、提前退租、零收入占用、退款后正实收、未知零值、空分母、排除在租/结算中、游戏/号主隔离，均通过 |
| dashboard_turnover_visual_test | 用真实页面渲染确定性样例；375px / 1280px 均为 16 卡、四列；168.0 小时/天、700.0%、20.0% 撤单率；说明弹层打开并用 Escape 关闭，卡片无横向溢出 |
| rental_device_order_integration_test --ui | 通过。隔离数据库启动 H5，测试主机订单、游戏筛选和退款重算；两种视口经菜单进入真实统计页面 |
| order_stats_historical_total_scope_smoke_test、order_stats_refresh_policy_smoke_test | 历史累计、已售账号、日统计刷新、快照和现有日期筛选通过 |
| uhaozu_order_detail_smoke_test、five_e_order_sync_smoke_test | 渠道详情解析、主订单同步和既有运营规则通过 |
| 本地 H5 | 已重启，/api/ping 返回 ok=true |

核心覆盖率范围为 `order/report_receipt.js`、`order/service/dashboard_order_facts.js`、`stats/dashboard_metrics.js`。c8 行 100%，分支 92.92%，函数 100%。这是上述三个文件的覆盖率；既有调度、页面和渠道文件通过对应的集成与回归用例验证。详细数据在 `coverage/dashboard-turnover/coverage-summary.json`，页面截图在 `coverage/dashboard-turnover-ui/`。

读取本地历史库副本时可复现缺少结算原值和实际时长的记录。只按可确认记录计算撤单率；无法核实的时长按下限展示。订单统计的历史快照在原刷新窗口内更新；本次未重算生产历史。周转时间代表可核实的订单履约/租期，不测量租客实际在线游戏时间。
