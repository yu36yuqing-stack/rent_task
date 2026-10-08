# 日租阶梯日志增强测试报告

日期：2026-10-08。仅本地代码与测试，未提交、未发布生产，未创建定时监控。

## 改动范围

仅运行文件 `price/price_ladder_reconcile_service.js` 增加日志字段及两个容错日志辅助函数。没有改渠道接口、定价算法、数据库结构、调价判定、重试时间或任务调度，没有新增远程查询请求。

`[PriceLadder][apply_start]` 追加 `rule_version`、`baseline_version` 和 `daily_calculation`：

| 字段 | 含义 |
| --- | --- |
| mode / daily_price_key | 日租模式和该渠道日租字段day/p24 |
| first_tier_hour_price / target_tier_hour_price | 首档时租与目标档时租 |
| daily_ratio | 当前用户该渠道实际采用的日租倍率 |
| base_daily_price | 未打折首档日租基准，已按渠道精度处理 |
| calculation_base | 跟随模式target_tier_hour，持平/递减first_tier_daily |
| factor / target_daily_price | 目标档折扣系数和最终目标日租价 |

例如首档时租2、日租倍率6、首档系数0.95，日志应为基准12、系数0.95、目标11.4，而不是重复打折。

`[PriceLadder][result]` 追加 `verification_status`、`verified_price_keys`、`readback_prices`；失败追加批次 `batch_id`、脱敏 `error_code` 和 `error_stage`。保留既有失败原因、retry_count、next_retry_at及轮次summary。

验证状态：full为当前租赁模式下的价格返回齐全且与目标匹配；partial为仅部分套餐可验证；unknown为成功返回但无完整价格证据或证据不一致；failed为发布失败。full不能只根据ok=true或声称full得出。

U号租将回读rentalByHour/Night/Day/Week映射为统一价格字段。租号王日租模式只比较p24/p72/p168，时租模式只比较hour，混合模式比较四项。悠悠返回的套餐字段属于目标值，不当作套餐回读，最多验证hour并标partial。

共同字段user_id、game_account、channel、trace_id、count_24h、from_tier、to_tier、trigger_source用于串联计算与结果，batch_id用于关联数据库中的发布明细。日志构造及输出异常不改变调价结果或重试策略；价格字段采用白名单，不输出授权凭据或完整API响应。

## 测试执行

环境：本地macOS、Node.js、SQLite、Chrome/Puppeteer、c8；写操作使用临时五库，渠道查询/写入/回读使用stub，没有真实生产API操作。

```sh
node test/daily_price_logging_test.js
node test/daily_price_policy_integration_test.js
node test/daily_price_policy_publish_test.js
node test/price_ladder_reconcile_smoke_test.js
npm run coverage:daily-price-policy
```

全部定向测试通过，完整覆盖率入口及门禁退出码0。八个顶层入口包含原日租、浏览器、说明浮层、渠道快照、订单/统计及原阶梯回归，日志中的模拟失败属于故障注入用例。

覆盖场景：三渠道三模式四档计算日志、未折扣基准、首档95%、配置版本、成功与未变更结果、真实发布Service返回字段、租号王三种模式、悠悠partial、无证据成功unknown、假full与回读不一致、字段缺失/字符串/NaN/零/Infinity、失败批次/阶段/代码/重试、秘密字段脱敏、日志输出抛错后调价仍成功。

测试文件：新增 `test/daily_price_logging_test.js`；更新 `test/daily_price_policy_integration_test.js`、`test/daily_price_policy_publish_test.js`、`test/price_ladder_reconcile_smoke_test.js`、`test/run_daily_price_tests.js`。

## 覆盖率与本地状态

- 本次修改的核心完整文件 `price/price_ladder_reconcile_service.js`：行98.43%、分支86.87%、函数100%，行覆盖率达90%门禁。
- 该文件相对HEAD的可测改动行58/58覆盖100%，包含此前未提交的daily_policy字段；累计全部未提交定价/页面改动330/330覆盖100%。
- 十二个核心文件合计行98.48%、分支86.14%、函数98.23%；全部十四个采集文件合计行64.24%、分支76.75%、函数71.69%。不是全仓覆盖率，不能宣称分支也达到90%。
- 报告 `coverage/daily-price-policy/index.html`、`changed-lines.json`、`coverage-final.json`；完整日志 `/tmp/rent-daily-price-logging-coverage.log`。
- 本地H5经launchd重启，`GET /api/ping`返回ok:true。coverage继续忽略，不提交、不回传宿主机；原有本地数据库修改保留，不提交。

## 线上判断边界

先按账号和channel定位apply_start，再用trace_id匹配result和summary；失败用batch_id关联发布明细并检查next_retry_at。summary证明本轮执行，不代表每个套餐都有平台回读证据；悠悠partial始终不能宣称日租已完整远端验证。

目标档与已应用档不变且无需远端核验时，保持既有逐账号unchanged日志抑制，仅输出summary中的计数，避免每轮日志膨胀。本轮不增加日常远端全量价格扫描或改变保留手工价格逻辑。

没有生产调价、负载测试或定时监控。未来需要分析时可同步生产日志和数据库只读排查。回退本次日志字段不会改变价格；回退定价策略仍需显式恢复配置并等待现有纠偏。
