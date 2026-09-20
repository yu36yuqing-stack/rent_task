# 账号阶梯定价与渠道价格结果测试报告

## 1. 本轮变更范围

- 用户首次保存或修改阶梯策略后，立即按当前业务日完成订单数计算档位，并强制向 U号租发布一次。
- 订单状态进入或退出 `已完成 + 部分完成` 时重算档位；档位未变化时不调用 U号租，保留渠道 App 手工调价结果。
- 每天 06:00 日切校准第 1 档；日切和实际换档都会先读取 U号租真实套餐价，不一致时覆盖，一致时跳过写接口。
- 冷却期、在租状态、黑名单和 U号租商品状态不再拦截阶梯改价；平台拒绝或异常统一记录为失败结果。
- 调价记录同时展示成功与失败，按用户、渠道、游戏、账号隔离，每个账号物理保留最近 20 条。
- 失败记录提供问号详情入口，展示失败阶段、错误代码和 U号租原始返回；详情 Toast 不自动消失，点击后关闭。
- 调价成功后回读四个套餐价格，只有回读与目标完全一致才更新运行档位。

本轮不包含生产发布，也未调用生产写接口。

## 2. 测试环境

- Node.js 本地环境。
- SQLite 临时隔离数据库，不读取或修改生产数据。
- Chrome Headless：桌面视口 `1365x900`，手机视口 `390x640`。
- 本地 H5：`http://127.0.0.1:8080`，使用 `/api/ping` 健康检查。

## 3. 用例与结果

| 分类 | 关键用例 | 结果 |
| --- | --- | --- |
| 保存即发布 | 首次保存、主动修改均按当前完成单数计算档位并强制发布 | 通过 |
| 账号隔离 | 保存 A 账号只处理 A，不扫描或发布其他待处理账号 | 通过 |
| 档位计算 | 0 单用第 1 档，完成 1/2/3 单后使用第 2/3/4 档，4 档封顶 | 通过 |
| 状态触发 | 进入或退出已完成、部分完成时重算；完成态之间切换不重复处理 | 通过 |
| 同档跳过 | 普通订单事件未换档时不查询或修改 U号租，保留手工渠道价 | 通过 |
| 远端校验 | 换档先读取四套餐价；相同跳过写入，不同覆盖并回读校验 | 通过 |
| 日切重置 | 06:00 进入新业务日，已记录第 1 档也会校验远端真实价 | 通过 |
| 门禁放行 | 冷却期、在租、黑名单、商品异常状态不阻止调价尝试 | 通过 |
| 同步门禁 | 本轮订单同步不完整时保留待处理，不基于残缺单量改价 | 通过 |
| 功能开关 | 总开关关闭时不进入新增逻辑；重新启用后执行远端校准 | 通过 |
| 未配置账号 | 不创建运行态、不参与日切和订单换档 | 通过 |
| 清空策略 | 四档全部清空后回到待配置，不再参与自动调价 | 通过 |
| 发布成功 | 记录触发来源、调整前、目标、回读后套餐价格 | 通过 |
| 发布失败 | 授权、查询、修改、回读不一致均记录失败阶段和结构化详情 | 通过 |
| U号租详情 | 保留错误代码和 U号租原始响应，敏感字段继续脱敏 | 通过 |
| 日志留存 | 成功与失败合计仅保留每账号最近 20 条，并清理无引用批次 | 通过 |
| 并发保护 | 保存版本冲突返回 `409`；发布前规则或开关变化则停止远程写入 | 通过 |
| H5 接口 | 未登录拦截、查询、保存、调价记录响应结构 | 通过 |
| H5 交互 | 成功/失败样式、失败问号、持久详情 Toast、点击关闭 | 通过 |
| 响应式 | 手机无横向溢出、套餐表三列、Sheet 内容可滚动到最后一档 | 通过 |
| 回归 | 订单库迁移、订单查询、商品补账号、冷却释放和收益统计 | 通过 |

## 4. 覆盖率

本轮实质修改的核心业务文件局部覆盖率：

| 文件 | 行 | 分支 | 函数 |
| --- | ---: | ---: | ---: |
| `database/price_publish_log_db.js` | 96.55% | 57.40% | 94.44% |
| `price/price_ladder_reconcile_service.js` | 98.14% | 68.50% | 100% |
| `price/price_ladder_service.js` | 97.95% | 74.54% | 100% |
| `price/price_publish_service.js` | 98.97% | 75.68% | 100% |
| **合计** | **97.95%** | **69.55%** | **98.55%** |

行覆盖率满足本次修改文件 `90%` 以上的要求。该结果是局部覆盖率，不代表全仓覆盖率。H5 DOM、CSS 和浏览器交互不计入 Node.js 行覆盖率，使用接口测试、前端 helper 测试和真实浏览器测试验证。

覆盖率报告：`coverage/price-ladder-v4/index.html`

## 5. 执行命令

```bash
node test/run_price_ladder_v3_tests.js
node test/pricing_ladder_frontend_helpers_smoke_test.js
node test/h5_auth_revoke_card_smoke_test.js
node test/pricing_ladder_visual_check.js
npx c8 --all \
  --include=price/price_ladder_reconcile_service.js \
  --include=price/price_ladder_service.js \
  --include=price/price_publish_service.js \
  --include=database/price_publish_log_db.js \
  --reporter=text --reporter=json-summary --reporter=html \
  --report-dir=coverage/price-ladder-v4 \
  node test/run_price_ladder_v3_tests.js
```

## 6. 截图

- `coverage/price-ladder/pricing-ladder-desktop-edit.png`
- `coverage/price-ladder/pricing-ladder-mobile.png`
- `coverage/price-ladder/pricing-channel-desktop.png`
- `coverage/price-ladder/pricing-channel-mobile.png`
- `coverage/price-ladder/pricing-channel-logs-desktop.png`

## 7. 剩余风险

- 渠道暂无订单推送，换档发现时延取决于现有 5 分钟订单同步；06:00 重置在日切后的首个同步周期执行。
- U号租准确套餐上下限规则仍未知；平台拒绝会记录目标价格及原始响应，后续可依据日志补充提交前校验。
- 分支覆盖率低于行覆盖率，主要集中在数据库底层异常回调和防御性空值分支；本轮要求的正常、边界、异常及关键回归路径均已覆盖。
