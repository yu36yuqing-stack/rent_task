# ZHW 日租基价与历史价格快照修复测试报告

日期：2026-10-03。结果：通过。仅本地实现、测试和只读证据回放；未发布生产。

## 1. 变更范围

- `price/zuhaowang_price_snapshot_service.js`：独立保存、展示已确认的 `hour_basis`；从成功回读记录安全恢复历史缺价；提供显式调用的只读模板补采。
- `price/price_publish_service.js`：成功调价和 `already_matches` 两条路径均保存快照。仅日租的基价取已确认日租套餐对应的目标基价，不取未启用时租接口中的旧值。已有有效时租快照保留为独立事实。
- `price/channel_adapters/zuhaowang_price_adapter.js`：仅日租核验不比较旧时租，仅时租核验不比较未启用日租；不改变渠道租赁模式或发布规则。
- `price/product_channel_price_service.js`：ZHW 仅日租优先展示独立基价，其他渠道和当前档位来源不变。
- `product/zuhaowang_price_snapshot.js`、`product/product.js`：商品同步保留基价；仅在同步商品ID和旧商品ID相同且价格缺失时恢复历史证据。
- `database/price_publish_log_db.js`：按用户批量查询各游戏、账号、商品的最新成功记录。最新记录不可靠时不回退到更旧记录冒充当前价格。
- `scripts/recover_zuhaowang_price_snapshots.js`：默认预览；`--query-missing` 才只读查询模板，`--apply` 才写账号快照；停用渠道跳过。写入只涉及 ZHW 价格字段，保留当前名称、状态和其他渠道。
- `h5/COMPONENT_GUIDE.md`：更新现有 ChannelPriceSummary 取值契约；HTML、CSS、前端组件结构和文案未改变。
- npm 增加定向测试与覆盖率入口。无新增表、数据库迁移、定时任务或通知。

## 2. 环境与用例

环境：macOS、Node.js、SQLite、c8、无头 Chrome。测试使用五个独立临时数据库及模拟渠道接口，不调用生产写接口。测试 runner 为每个子任务设置隔离数据库路径。

新增4组测试：

1. 基价与实际启用价格分离、正数/非法值、精度截断、日租/时租模式、旧字段兼容；历史证据的用户、游戏、账号、商品、软删除、验证状态和价格一致性校验。
2. 真实发布 Service 与临时数据库集成：日租档位上升/下降、旧实际时租不丢、查询已一致更新快照但不调用改价、不生成伪调价成功日志；回读不一致或快照写入失败不污染快照。
3. 历史查询最新记录选择、后续失败记录、不同用户/游戏/商品、软删除与字段解析；一次商品同步自动恢复，后续同步保持幂等且不重复读取历史。
4. 按需只读补采只使用 `applied_price_signature`，不使用目标档位；远端不匹配、缺授权、停用渠道、查询异常不恢复；默认预览不写账号；显式写入重查商品ID、删除/售出和渠道开关。真实 CLI 默认路径在临时库验证。

相关回归30组：原 ZHW 商品同步7组、阶梯价格/订单/迁移20组、商品列表定价摘要/前端/HTTP3组。保留其他渠道和多游戏行为验证。

## 3. 执行结果

| 执行项 | 结果 |
| --- | --- |
| `npm run coverage:zuhaowang-snapshot-repair` | 34组全部通过，覆盖率门禁通过 |
| `npm run test:product-channel-price-visual` | 24个视口/游戏组合通过；无真实业务API调用 |
| 2026-10-02 22:37生产快照只读回放 | 通过；仅读取隔离排查目录，无生产/真实本地账号写入 |
| 本地H5重启、`/api/ping` | 通过，`ok: true` |
| `git diff --check` | 通过 |

最终失败项：无。

生产证据回放：`2571775932` 从缺价恢复为“1档 · ¥3.20/时”；`1903036159` 保持“3档 · ¥2.50/时”。两者已启用套餐均与已应用档位记录匹配，没有把日租接口里未启用的旧时租3.4当成基价。该结果是上述历史快照的离线回放，不代表已修改当前生产数据。

## 4. 覆盖率

统计以下8个运行文件全量代码，同时按HEAD差异检查修改行，两个新增运行文件按全文件计。未排除难测代码。

| 文件 | 行 | 分支 | 函数 |
| --- | --- | --- | --- |
| `price/zuhaowang_price_snapshot_service.js` | 100% | 100% | 100% |
| `scripts/recover_zuhaowang_price_snapshots.js` | 100% | 100% | 100% |
| `price/channel_adapters/zuhaowang_price_adapter.js` | 97.27% | 80.70% | 92.30% |
| `price/price_publish_service.js` | 98.90% | 72.32% | 100% |
| `database/price_publish_log_db.js` | 96.69% | 60% | 94.73% |
| `price/product_channel_price_service.js` | 100% | 100% | 100% |
| `product/zuhaowang_price_snapshot.js` | 100% | 100% | 100% |
| `product/product.js` | 91.46% | 53.33% | 84.21% |
| 上述8文件合计 | 96.87% | 73.34% | 95% |

本次新增/改动可执行行：257/257，100%。各运行文件全文件行覆盖率均超过90%。这是明确范围的覆盖率，不是全仓覆盖率；既有共享文件的分支和函数并未全部覆盖。

报告：`coverage/zuhaowang-snapshot-repair/index.html`。
明细：该目录下 `changed-lines.json`、`coverage-summary.json`、`production-replay.json`。
日志：`test-execution.log`、`visual-execution.log`。coverage继续被Git与发布同步忽略。

## 5. 使用、发布与回滚

普通商品同步会自动恢复有可靠历史记录的缺价，不增加平台模板请求；恢复完成后不再重复查历史。历史证据不足仍显示未知，不猜价格。

以下命令使用当前环境配置的数据库；本次未对真实账号执行：

```bash
# 预览可由成功回读记录恢复的快照，不查询渠道API、不写账号。
node scripts/recover_zuhaowang_price_snapshots.js --user-id 8
# 对剩余缺价按需只读查询；必须与已应用档位价格核验一致，不调用改价接口。
node scripts/recover_zuhaowang_price_snapshots.js --user-id 8 --query-missing
# 经确认后显式保存，不改变渠道价格或租赁模式。
node scripts/recover_zuhaowang_price_snapshots.js --user-id 8 --query-missing --apply
```

生产发布仍需用户明确授权并使用 `scripts/merge_code.sh`；发布不自动执行补采脚本。优先观察下一轮正常商品同步的 `[ZHWPriceSnapshot] stage=history recovered=...`，以及调价路径的 `source=verified_publish/already_matches`。

只读补采没有可用授权、没有已应用价格签名、模板已被人工改成其他价格或接口失败时不会写入。`hour_basis` 表示已确认日租定价的计算基价，不代表渠道已开启时租。

未新增跨库事务、版本锁或实时读价；正常任务并发窗口仍属于既有风险。历史读取失败会降级为正常商品同步并记录错误码，不虚构价格、不告警其他渠道。回滚只回退代码，保留新增JSON字段和现有业务数据库，旧版本忽略新字段。
