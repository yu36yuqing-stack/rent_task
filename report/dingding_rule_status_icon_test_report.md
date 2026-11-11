# 钉钉规则下架图标测试报告

## 范围与环境

- 日期：2026-11-11，Asia/Shanghai；本机 macOS，Node.js v24.13.0，c8。
- 核心改动：`report/dingding/ding_style.js`、`report/dingding/ding_report_dedup.js`。
- 新增测试：`test/dingding_rule_status_icon_test.js`、`test/run_dingding_status_icon_tests.js`。
- 更新回归预期：`test/dingding_cooldown_icon_test.js`、`test/dingding_report_dedup_smoke_test.js`。
- 复用报告已有的有效黑名单标记、原因后缀、出租订单事实、授权渠道列表及商品绑定，不新增数据库字段。
- 不改变黑名单收口、实际上下架、在线检测、授权、订单、Telegram 或 H5 页面逻辑；发送器仍为纯文本实现。

## 行首规则

按顺序判断，命中后不再继续：

1. 有效冷却期黑名单使用 `⏳`，保留原优先级。
2. 有实际出租订单，或参与比较的渠道正在出租，使用 `💰`。
3. 其他有效黑名单使用 `⬇️`，包括人工、维护、N 单下架、在线和风控规则；不因 U 号租审核失败而变成行首警告。
4. 无下架规则且参与比较的渠道全部上架，使用 `✅`。
5. 无下架规则、无出租事实，渠道状态已知但未全部上架，使用 `⚠️`；包括三个渠道全下架的情况。
6. 没有可比较渠道、绑定数据非法、状态缺失或未知，使用 `❔`，不凭空判断应该上架。

参与比较的渠道取报告传入的授权列表，并排除没有商品绑定的渠道。旧报告没有绑定元数据时，兼容使用明确的渠道状态；缺少授权列表兼容原三渠道，显式空列表不再等同于三渠道。

本次问题的输出已做完整字符串断言：

```text
⬇️[0单](OFF) 呆小雨 Y下/U审/Z下 🔸已按人工下架规则下架
```

中括号、圆括号、各渠道真实状态、规则后缀、授权异常和同步异常提示均保留。通知快照和正文复用同一个图标判定；从旧警告变为下箭头时可产生一次内容变更通知，后续仅时间变化不会重复发送。

## 执行结果

```bash
node_modules/.bin/c8 --all \
  --include=report/dingding/ding_style.js \
  --include=report/dingding/ding_report_dedup.js \
  --include=report/dingding/ding_notify.js \
  --check-coverage --per-file --lines=90 --functions=90 \
  --reporter=text --reporter=json --reporter=json-summary --reporter=html \
  --report-dir=coverage/dingding-status-icons \
  node test/run_dingding_status_icon_tests.js
```

总入口 3/3 通过，退出码 0，无失败项。

| 类别 | 结果与断言范围 |
| --- | --- |
| 规则与边界 | 170 个图标分类场景通过；覆盖四游戏、六类非冷却原因、五种渠道状态、冷却及出租优先级、失效规则、授权子集、未绑定商品、空值和非法数据 |
| 格式与快照 | 呆小雨完整行、原有括号和渠道状态、正文与快照一致、不修改输入、旧快照图标变化、时间变化不重发、不同用户检查点隔离均通过 |
| 冷却与发送 | 9/9 组通过；单个原生沙漏、纯文本、签名与提及、配置错误、HTTP/业务/网络失败等原路径保持兼容 |
| 关联回归 | 通知去重、用户流水线阶段、主调度任务分支、H5 失败任务回归 4/4 通过 |
| 本地服务 | 已重启本地 H5，PID 48692；`http://127.0.0.1:8080/api/ping` 返回 HTTP 200、`ok: true`；风控 Worker 保持关闭 |
| 静态检查 | `git diff --check` 通过 |

自动测试使用隔离临时数据库和 stub 请求，未调用真实钉钉 Webhook 或生产业务写接口。日志：`/tmp/rent-task-dingding-status-icons-test.log`。

## 完整文件覆盖率

| 文件 | 行 | 分支 | 函数 |
| --- | --- | --- | --- |
| ding_style.js，本次修改 | 100.00% | 96.86% | 100.00% |
| ding_report_dedup.js，本次修改 | 97.34% | 85.71% | 100.00% |
| ding_notify.js，未修改，发送回归 | 100.00% | 99.00% | 100.00% |
| 上述三文件合计 | 98.73% | 93.17% | 100.00% |

两个修改文件的行覆盖率均超过 90%。以上是指定文件的完整文件覆盖率，不是全仓覆盖率；没有排除文件内难测代码。去重模块尚未覆盖的行主要是旧检查点缺少快照时，继续向更早历史行补找快照的原兼容路径；本次不修改该路径。

详细产物：`coverage/dingding-status-icons/index.html`、`coverage-summary.json`、`coverage-final.json`。

## 限制与上线

- 本轮使用模拟账号验证，没有向 UID=8 或其他真实群发送消息，也没有以最新生产数据核验呆小雨当前状态。
- 本次只调整账号行首图标。末尾汇总仍使用报告已有的 `allNormal` 字段；上游全部授权失效时的三渠道回退机制也未调整，不把本次变更描述为授权同步或汇总判定重构。
- Emoji 外观由客户端决定；不重新引入图片、Markdown 转换或颜色定制。
- 没有发布生产、重启生产、运行迁移、修改生产数据或回拉 Runtime 库。现有本地数据库运行态改动保留，不应提交。
- 正式上线仍需明确授权后使用项目既有发布流程。回滚仅撤销本次通知图标和授权列表兼容调整及对应测试，不涉及数据库迁移，不覆盖其他改动。
