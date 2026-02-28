# Codex Rule

## Rule 1 - Database Table Standard

后续按照阿里和字节的规范执行数据库建表。每次新建表，必须包含必要公共字段，至少包括：

- `id`：主键
- `create_date`：创建时间
- `modify_date`：修改时间
- `is_deleted`：逻辑删除标记
- `desc`：备注/说明

如无特殊说明，后续所有数据库表设计默认遵循本规则。

## Rule 2 - H5 下拉刷新交互规范

后续 H5 页面若实现下拉刷新，统一遵循以下规则：

- 不使用“下拉刷新 / 松开刷新”等动态变化文案提示。
- 用户触发下拉刷新后，仅在下拉区域展示：
  - 旋转 loading 图标
  - 固定 loading 文案（如“加载中...”）
- loading 展示时长规则：
  - 最少展示约 `150ms` 后再还原。
  - 若请求耗时超过 `200ms`，以请求真实返回时间为准，不额外延长。

## Rule 3 - H5 BFF 分层规范

后续 H5 接口开发，统一遵循「BFF 只做展示编排，业务逻辑下沉 Service」原则：

- BFF 层职责（如 `h5/local_h5_server.js` 或后续 `h5_bff`）：
  - 路由分发、参数解析、鉴权、协议转换、统一响应格式。
  - 不承载核心业务规则、不直接耦合复杂状态机。
- Service 层职责（如 `stats/order_stats.js`）：
  - 承载业务规则、编排流程、并发控制策略、重试与幂等策略。
  - 向上返回稳定的领域结果（业务结果对象），不直接返回 HTTP 语义。
- 错误分层：
  - Service 抛业务错误码（如 `LOCK_BUSY`、`SYNC_PARTIAL_FAIL`）。
  - BFF 统一把业务错误映射为 HTTP 状态码和前端可读提示。
- 并发与锁：
  - 锁获取、等待、超时、轮询等并发控制逻辑默认下沉到 Service 或 lock 组件。
  - BFF 只透传必要策略参数（如 `timeout_ms`、`request_id`）。
- 可观测性：
  - 关键链路统一携带 `trace_id`，贯穿 H5 -> BFF -> Service -> DB。
  - 日志至少包含：`user_id`、`period/days`、`lock_wait_ms`、`sync_ok`、`error_code`。
- 读写分离：
  - `refresh`（写路径）与 `dashboard/calendar`（读路径）分离实现，读路径优先查快照表。
- 配置收口：
  - 锁和同步相关参数（如 `LOCK_KEY/LEASE/WAIT/POLL/maxPages`）集中在配置区，避免散落。

## Rule 4 - 发布宿主机触发规则

当用户明确提出“发布宿主机”时，默认执行以下流程：

- 执行 `scripts/merge_code.sh`（若用户口语提到 `merge_code.js`，按本项目实际脚本 `merge_code.sh` 执行）。
- 完成发布后，必须把宿主机的数据库与日志同步回本机：
  - `database/*.db`
  - `log/`

## Rule 5 - 本地 H5 自动重启规则

当完成任何代码改动并可本地预览时，默认执行以下流程（无需再次询问用户）：

- 自动重启本地 H5 服务（`h5/local_h5_server.js`）。
- 执行本地健康检查（`/api/ping`）并回传结果。

## Rule 6 - 单次请求 Token 控制规则

为避免单次请求上下文过大，默认执行以下约束：

- 每次发给模型的上下文规模目标控制在 `9k tokens` 以内。
- 若预计超过 `9k tokens`，必须拆分为多轮请求分批处理。
- 检索与输出遵循“最小必要”原则：按需读取片段，避免整文件或大段无关内容。

## Rule 7 - 前端组件复用规则

后续 H5 前端开发，必须优先复用现有组件类，不允许同义样式重复造轮子。

- 组件与规范文档基线：
  - `h5/public/css/app.css`
  - `h5/COMPONENT_GUIDE.md`
- 开发顺序必须遵循：
  1. 优先复用已有组件类（如 `btn` / `orders-tabs` / `order-card` / `pager` / `sheet`）。
  2. 如确实无法满足，优先新增“变体类”，避免新增全新组件。
  3. 仅在必要时新增组件；新增后必须同步更新 `h5/COMPONENT_GUIDE.md`。
- 页面专属样式必须带页面锚点（如 `#riskView ...`），避免污染全局样式。

## Rule 8 - 通知研发规范

后续所有 Telegram / 钉钉等通知开发，统一遵循“模板与发送解耦”规范：

- 消息模板（文案拼装）统一放在 style 文件：
  - 钉钉：`report/dingding/ding_style.js`
  - Telegram：`report/telegram/*_style.js`
- 发送器只负责发送，不承载业务文案拼装：
  - 钉钉：`report/dingding/ding_notify.js`
- 业务模块（如 `order/*`、`product/*`、`report/*`）只能：
  1. 调用 style 方法生成消息文本；
  2. 调用 notify 方法发送消息。
- 禁止在业务文件内临时新增/散落通知模板函数，避免同类通知多份文案长期漂移。

## Rule 9 - 多游戏头部页签交互规范

后续在 H5 的统计页 / 商品页 / 订单页等需要做“按游戏切换”时，统一采用连续页签（浏览器标签）交互，不使用胶囊按钮样式。

- 样式与结构基线：
  - 容器：`#statsGameTabs.stats-game-tabs`
  - 页签：`.stats-game-tab`
  - 文案：`.stats-game-tab-text`
  - 图标：复用 `.game-avatar`
- 交互规则：
  - 页签横向连续拼接，标签间不留明显间距，仅保留细分隔线。
  - 当前激活项使用白底并与内容区视觉连通；未激活项使用浅灰底。
  - 支持移动端横向滚动，不换行。
  - 页签内容统一为“游戏图标 + 游戏中文名”。
- 复用规则：
  - 新页面优先复用上述现有类名与视觉语义；如做页面级差异，只允许加页面锚点变体，不重造一套同义组件。
