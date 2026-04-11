# PRD - ORDER

## 订单冷却期与 N 单下架方案记录

### 1. 目标
- 在不改动现有“黑名单执行链路（强制下架 + 阻断上架）”的前提下，新增一种可自动进出的冷却类型。
- 用于处理订单结束后短时间内不要立即上架的问题。

### 2. 设计原则
- 复用 `user_blacklist` 通道，不新增一套并行动作引擎。
- 新增黑名单类型（`reason`）用于区分展示文案，避免误导成手工黑名单。
- 只调整“进出黑名单”的判定逻辑。

### 3. 新增类型
- `reason = 冷却期下架`
- 语义：订单冷却期内，账号应保持全渠道下架/阻断上架。

### 4. 进黑名单规则（当前代码口径）
- 执行任务：订单同步任务。
- 触发条件：
  1. 订单状态属于有效租赁（当前实现按 `租赁中 / 出租中` 识别）。
  2. 当前时间仍早于订单结束时间：`now < order_end_time`。
  3. 当前时间已经进入“临近结束窗口”：`order_end_time - now <= near_end_sec`。
- 默认参数：
  1. `near_end_sec = 10 分钟`。
  2. 即默认在“订单结束前 10 分钟”扫描命中并进入冷却期下架。
- 入黑名单动作：
  1. 写入/更新 `reason=冷却期下架`。
  2. 计算并保存 `cooldown_until = order_end_time + release_delay_min`。
- 说明：
  1. 这里不是“订单开始后 10 分钟触发”。
  2. 当前真实代码逻辑是“订单结束前 10 分钟进入冷却期下架窗口”。

### 5. 出黑名单规则（当前代码口径）
- 建议执行任务：商品同步任务（当前 5 分钟频率）。
- 释放判断字段：使用预先计算并保存的 `cooldown_until`。
- 释放条件：`now >= cooldown_until` 时，移除“冷却期下架”类型。
- 当前参数来源：
  1. `release_delay_min` 已支持按用户配置读取。
  2. 例如用户配置为 `15`，则 `cooldown_until = order_end_time + 15 分钟`。
- 删除粒度：仅删除该冷却类型，不影响手工黑名单/X 单下架等其他类型。

### 6. 为什么出黑名单放在商品任务
- 若放在订单任务（10 分钟频率），`结束+release_delay_min` 的实际恢复可能出现较大延迟（最坏可接近额外 10 分钟）。
- 放在商品任务（5 分钟频率）可明显降低恢复延迟，恢复更平滑。

### 7. 安全保护（避免提前释放）
- 商品任务在释放前增加“订单数据新鲜度”校验：
  - 仅当最近一次订单同步成功且在新鲜窗口内（如 12 分钟）才允许释放。
  - 若订单同步滞后，本轮不释放，等待下轮，避免因订单视图过期导致提前上架。

### 8. 多订单与幂等处理
- 同账号多订单并存时：
  - `cooldown_until` 取最大值（更晚时间优先），新订单只延后不缩短。
- 幂等策略：
  - 入场采用 upsert（已有记录则更新截止时间）。
  - 出场按“账号 + 类型（冷却期下架）”精确删除。

### 9. 冷却期当前实现结论
- 已确认：
  1. 黑名单通道可复用。
  2. 冷却期命中时应执行下架。
  3. 展示文案按 `reason` 区分为“冷却期下架”。
  4. 入场时机以当前代码为准：结束前 `near_end_sec` 命中，而非开始后 10 分钟。
  5. 释放时机按用户配置的 `release_delay_min` 生效。

### 10. N 单下架当前实现结论
- 当前 `N 单下架` 与冷却期下架是两条独立链路：
  1. 冷却期下架：订单同步后执行 `reconcileOrderCooldownEntryByUser`。
  2. N 单下架：订单同步后执行 `reconcileOrder3OffBlacklistByUser`。
- 当前 N 单计数规则：
  1. 自然日模式：按业务日窗口统计订单数。
  2. 24 小时模式：按滚动 24 小时窗口统计订单数。
  3. 计数口径当前包含：
     - `order_status IN ('租赁中', '出租中')`
     - 或 `rec_amount > 0`
- 现状修正：
  1. 已将 `结算中` 纳入有效订单计数。
  2. 当前口径应理解为：
     - `order_status IN ('租赁中', '出租中', '结算中')`
     - 或 `rec_amount > 0`
  3. 目的：避免订单从“租赁中”切到“结算中”，但实收金额尚未回填时，订单数短暂从 3 掉成 2，导致误恢复上架。
- 风险点：
  1. 两条规则虽然都在订单同步后执行，但没有统一编排入口。
  2. N 单下架没有复用冷却期“结束前 10 分钟扫描”的更早触发时机。

### 11. N 单下架与冷却期下架收口落地方案
- 目标：
  1. 统一订单类自动下架的判定入口。
  2. 让 N 单下架复用冷却期下架“结束前 10 分钟扫描”的触发时机。
  3. 降低第 3 单结束后才触发下架，导致第 4 单抢入的概率。
- 方案：
  1. 新增统一编排入口，例如 `reconcileOrderOffByUser(userId, options)`。
  2. 在该入口内按串行顺序依次执行：
     - 冷却期下架判定
     - N 单下架判定
  3. 两条规则继续复用现有黑名单 source 能力，不新增新的执行引擎。
- 执行时机：
  1. 仍由订单同步任务触发。
  2. 但 N 单下架将不再只依赖“订单同步末尾单独计数”这个时机，而是跟随统一入口，在冷却期扫描窗口内一并判定。
- 预期效果：
  1. 第 3 单进入结束前 10 分钟窗口时，若已满足 N 单阈值，可提前进入 `order_n_off`。
  2. 正常情况下，账号可在第 3 单结束前完成下架，降低出现第 4 单的概率。
- 边界说明：
  1. 若平台订单同步延迟，导致第 3 单在结束前 10 分钟窗口内仍未入库，则仍可能漏过提前命中。
  2. 因此后续如仍有漏单，再考虑补“上架前最终校验”作为第二道保险。

## 12. 订单拆库阶段一方案（先建订单领域网关，不先搬库）

### 12.1 阶段目标
- 本阶段不改动 `stats.db` 现有存储与统计刷新逻辑。
- 本阶段不迁移 `order` 及相关表到新库。
- 本阶段只做一件事：先把所有“别人直接查订单表/订单附属表”的行为收口到订单领域接口。
- 目标结果：
  1. 非订单模块不再直接访问 `order/order_detail/order_complaint/order_sync_state` 对应 SQL。
  2. 商品页、风控、流水线、统计读取订单事实时，统一走订单领域服务。
  3. 后续阶段二真正拆库时，只改订单领域内部实现，不大面积改业务调用方。

### 12.2 当前已识别的主要耦合面
- 商品页展示耦合：
  1. `h5/local_h5_server.js`
  2. 依赖订单事实：今日/近24h有效订单数、在租时间窗。
- 订单驱动下架规则耦合：
  1. `order/order.js`
  2. 依赖订单事实：N 单下架计数、订单同步后规则收敛。
- 冷却期进入/释放耦合：
  1. `order/order_cooldown.js`
  2. 依赖订单事实：当前租赁中订单、订单状态、结束时间。
- 商品风控守卫耦合：
  1. `product/prod_status_guard.js`
  2. 依赖订单事实：最近结束订单、当前活跃订单。
- 用户总流水线耦合：
  1. `pipeline/user_pipeline.js`
  2. 依赖订单规则收敛结果。
- 统计聚合耦合：
  1. `stats/order_stats.js`
  2. 当前仍直接从 `order` 表按日聚合事实。
- 订单附属数据耦合：
  1. `database/order_detail_db.js`
  2. `database/order_complaint_db.js`
  3. `database/order_sync_db.js`

### 12.3 阶段边界
- 保持不变：
  1. `stats.db` 表结构与统计快照逻辑。
  2. 订单主表与附属表仍保存在当前数据库中。
  3. 黑名单存储结构与商品存储结构。
- 本阶段允许改动：
  1. 订单相关服务边界。
  2. 调用方 import 关系。
  3. 非订单模块读取订单事实的入口。

### 12.4 订单领域网关设计

#### 12.4.1 OrderQueryService
- 职责：
  1. 对外提供稳定的“订单事实读取能力”。
  2. 屏蔽底层 SQL 与表结构。
- 建议接口：
  1. `listOrdersForUser(userId, options)`
  2. `listPaidCountByAccounts(userId, accounts, { mode })`
  3. `listRentingWindowByAccounts(userId, accounts)`
  4. `listActiveOrderSnapshotByAccounts(userId, accounts)`
  5. `listLatestEndedOrderSnapshotByAccounts(userId, accounts)`
  6. `listActiveRentingOrdersByUser(userId)`
  7. `getOrderStatusByOrderNo(userId, orderNo, channel)`
  8. `getOrderEndTimeByOrderNo(userId, orderNo, channel)`
- 规则：
  1. “有效订单计数”口径只允许在订单领域内部维护。
  2. 调用方不能自己拼 `rec_amount > 0 / 租赁中 / 结算中` 这类 SQL 口径。

#### 12.4.2 OrderCommandService
- 职责：
  1. 对外提供订单写入与同步状态写入。
- 建议接口：
  1. `upsertOrders(rows, options)`
  2. `upsertOrderDetail(row, options)`
  3. `upsertOrderComplaint(row, options)`
  4. `getLastSyncTimestamp(userId, channel)`
  5. `setLastSyncTimestamp(userId, channel, ts, desc)`

#### 12.4.3 OrderRuleService
- 职责：
  1. 承接“订单事实 -> 商品规则动作”的编排。
- 建议接口：
  1. `reconcileOrderOffByUser(user, options)`
  2. `reconcileOrderCooldownEntryByUser(userId, options)`
  3. `releaseOrderCooldownBlacklistByUser(userId, options)`
  4. `reconcileOrderNOffByUser(user, options)`
- 规则：
  1. 调用方不再自己拼“查订单 + 算规则 + 写黑名单”链路。
  2. 规则收敛统一经由订单规则服务完成。

### 12.5 目录与职责建议
- 建议新增：
  1. `order/service/order_query_service.js`
  2. `order/service/order_command_service.js`
  3. `order/service/order_rule_service.js`
- 现有文件角色调整建议：
  1. `database/order_db.js` 继续作为底层 DAO。
  2. `database/order_detail_db.js` 继续作为底层 DAO。
  3. `database/order_complaint_db.js` 继续作为底层 DAO。
  4. `database/order_sync_db.js` 继续作为底层 DAO。
  5. `order/order.js` 逐步退化为同步编排与渠道拉单入口。
  6. `order/order_cooldown.js` 内部优先改为依赖 `OrderQueryService`，减少直接查表。

### 12.6 推荐改造顺序

#### 第一步：先收口读取接口
- 目标：
  1. 先把分散在商品页、风控、统计里的订单读取逻辑集中。
- 优先替换的调用方：
  1. `h5/local_h5_server.js`
  2. `product/prod_status_guard.js`
  3. `order/order_cooldown.js`
- 优先收口的方法：
  1. `listTodayPaidOrderCountByAccounts`
  2. `listRolling24hPaidOrderCountByAccounts`
  3. `listRentingOrderWindowByAccounts`
  4. `listOrders`
  5. `listActiveRentingOrdersByUser`
  6. `listLatestEndedOrderSnapshotByUser`
  7. `listActiveOrderSnapshotByUser`
  8. `getOrderStatusByOrderNo`
  9. `getOrderEndTimeByOrderNo`

#### 第二步：再收口规则入口
- 目标：
  1. 统一订单驱动规则的调用方式。
- 优先替换的调用方：
  1. `pipeline/user_pipeline.js`
  2. `product/product.js`
  3. `order/order.js`
- 收口内容：
  1. N 单下架
  2. 冷却期进入
  3. 冷却期释放

#### 第三步：最后收口写接口
- 目标：
  1. 为阶段二拆库做写路径准备。
- 收口内容：
  1. 订单主数据写入
  2. 订单详情写入
  3. 订单投诉写入
  4. 同步游标写入

### 12.7 阶段一建议改动范围

#### 新增文件
- `order/service/order_query_service.js`
- `order/service/order_command_service.js`
- `order/service/order_rule_service.js`

#### 一定会改的文件
- `order/order.js`
- `order/order_cooldown.js`
- `h5/local_h5_server.js`
- `product/prod_status_guard.js`
- `pipeline/user_pipeline.js`

#### 大概率会改的文件
- `database/order_db.js`
- `database/order_detail_db.js`
- `database/order_complaint_db.js`
- `database/order_sync_db.js`
- `stats/order_stats.js`

### 12.8 阶段一验收方案

#### 验收目标
- 确保“非订单模块不再非法直接访问订单域数据库”。
- 确保后续拆库时改动面被稳定锁在订单领域边界内。

#### 第一层：静态扫描验收
- 非订单模块中，不应再出现以下直接 SQL 访问：
  1. `FROM "order"` / `FROM order`
  2. `JOIN "order"` / `JOIN order`
  3. `order_detail`
  4. `order_complaint`
  5. `order_sync_state`
- 非订单模块中，不应再出现直接调用底层订单 DAO：
  1. `database/order_db.js`
  2. `database/order_detail_db.js`
  3. `database/order_complaint_db.js`
  4. `database/order_sync_db.js`

#### 第二层：订单域访问白名单验收
- 定义允许直接访问订单域数据库/DAO 的白名单，仅限：
  1. `database/order_db.js`
  2. `database/order_detail_db.js`
  3. `database/order_complaint_db.js`
  4. `database/order_sync_db.js`
  5. `order/service/*`
  6. `order/order.js`
  7. `order/order_cooldown.js`
- 白名单外文件如果仍直接访问订单域 SQL，视为阶段一未完成。

#### 第三层：运行时来源验收
- 对订单域 SQL 增加临时 trace，记录访问来源文件或调用栈。
- 至少覆盖以下核心链路：
  1. 商品页打开
  2. 订单页打开
  3. 统计页打开
  4. 商品同步
  5. 订单同步
  6. 风控守卫执行
- 验收标准：
  1. 订单域 SQL 来源应只落在白名单模块内。

#### 第四层：反向封禁验收
- 在阶段一后半段，可临时增加保护：
  1. 非白名单调用方若直接访问订单域 SQL，则直接报警或抛错。
- 目的：
  1. 用一次核心链路回归，暴露所有漏网之鱼。

### 12.9 阶段一完成标准
- 达成以下条件时，视为阶段一完成：
  1. 非订单模块不再直接写 `order/order_detail/order_complaint/order_sync_state` 相关 SQL。
  2. 非订单模块不再直接引用 `database/order*.js`。
  3. 商品页、订单页、风控守卫、冷却期、订单同步功能保持现状可用。
  4. 订单读取、写入、规则接口已经稳定存在，后续阶段二拆库只需要替换其内部实现。
