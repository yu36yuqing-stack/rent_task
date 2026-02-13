# DESIGN - USER 模块技术方案

## 1. 文档目标
基于 `user/PRD_USER.md`，给出可直接实施的 USER 模块技术落地方案，覆盖：
- 多用户登录与鉴权
- 用户级平台授权管理
- 账号归属与状态存储（单账号单行 + `channel_status` JSON）
- 扫描结果按用户路由通知
- 与现有单机流程兼容迁移

## 2. 设计原则
- 渐进式改造：不阻断当前 `rent_robot_main.js` 主流程。
- 用户隔离优先：所有账号与授权读取必须带 `user_id` 上下文。
- 兼容优先：`USER_MODE_ENABLED=false` 时维持当前全局行为。
- 数据规范：所有新增表遵循公共字段：`id`、`modify_date`、`is_deleted`、`desc`。

## 3. 总体架构

### 3.1 模块划分
- `api/user_api.js`
  - 提供登录、用户创建、账号同步、授权写入与查询接口。
- `api/auth_middleware.js`
  - 解析 Access Token，注入 `ctx.user`。
- `database/user_db.js`
  - 保留用户基础能力，补充 `status`、`last_login_at`、refresh token 相关能力。
- `database/user_game_account_db.js`（新增）
  - 账号归属表 CRUD、按用户查询、按账号 upsert。
- `database/user_platform_auth_db.js`（新增）
  - 用户平台授权存取、失效标记。
- `product/product.js`（商品模块，原 `account_sync_service.js`）
  - 按用户授权调用三平台抓取，写入 `user_game_account`。
- `product/notify_router_service.js`（新增）
  - 按 `user_id` 聚合扫描结果并读取 `notify_config` 发送通知。

### 3.2 运行模式
- `USER_MODE_ENABLED=false`：
  - 走当前逻辑（全局凭据 + 全局通知）。
- `USER_MODE_ENABLED=true`：
  - 扫描前加载用户授权；
  - 扫描后结果按账号归属映射到用户；
  - 通知按用户配置分发。

## 4. 数据库设计

## 4.1 表：`user`（新增）
当前 `rent_robot.db` 未落 `user` 表，本阶段直接新建。

建表 SQL（SQLite）：
```sql
CREATE TABLE IF NOT EXISTS user (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account TEXT NOT NULL,
    password TEXT NOT NULL,
    name TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    notify_config TEXT DEFAULT '{}',
    user_type TEXT DEFAULT '外部',
    status TEXT NOT NULL DEFAULT 'enabled',
    last_login_at TEXT DEFAULT '',
    modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    desc TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_account_alive
ON user(account, is_deleted);
CREATE INDEX IF NOT EXISTS idx_user_status
ON user(status, is_deleted);
```

说明：
- 现有 `password` 继续使用 PBKDF2；后续可升级 Argon2。
- `notify_config` 保持 JSON 文本（兼容当前 sqlite 使用方式）。

## 4.2 表：`user_game_account`（新增）
用途：用户账号归属与平台状态聚合（单账号单行）。

```sql
CREATE TABLE IF NOT EXISTS user_game_account (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    game_account TEXT NOT NULL,
    game_name TEXT NOT NULL DEFAULT 'WZRY',
    channel_status TEXT NOT NULL DEFAULT '{}',
    modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    desc TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_game_account_alive
ON user_game_account(user_id, game_name, game_account, is_deleted);
CREATE INDEX IF NOT EXISTS idx_user_game_account_user
ON user_game_account(user_id, is_deleted);
```

`channel_status` JSON 结构约定：
```json
{
  "zuhaowang": "上架",
  "uhaozu": "审核失败",
  "uuzuhao": "下架"
}
```

说明：
- 同一用户下，同一 `game_name`、同一 `game_account` 只保留一行。
- 多平台状态通过 `channel_status` 维护，不再拆分多个 `*_status` 列。
- 平台存在性通过 `channel_status` 的 key 表达（存在 key 表示该平台有该账号记录）。

## 4.3 表：`user_platform_auth`（新增）
```sql
CREATE TABLE IF NOT EXISTS user_platform_auth (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    platform TEXT NOT NULL,
    auth_type TEXT NOT NULL,                -- 凭据类型（按平台约束）
    auth_payload TEXT NOT NULL,             -- 凭据内容(JSON 字符串，明文存储)
    auth_status TEXT NOT NULL DEFAULT 'valid', -- 授权状态：valid/expired/revoked
    expire_at TEXT DEFAULT '',
    modify_date TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_deleted INTEGER NOT NULL DEFAULT 0,
    desc TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_platform_auth_alive
ON user_platform_auth(user_id, platform, is_deleted);
CREATE INDEX IF NOT EXISTS idx_user_platform_auth_status
ON user_platform_auth(user_id, auth_status, is_deleted);
```

说明：
- `auth_payload` 存明文 JSON（便于初期排障与维护）。
- `platform` 固定值：`zuhaowang` / `uhaozu` / `uuzuhao`。
- `auth_type` 表示当前平台凭据形态，决定调用时如何组装请求头；当前约束：
  - `zuhaowang`：`auth_type=token`，且 `auth_payload` 至少包含 `token_get`、`token_post`、`device_id`、`package_name`
  - `uhaozu`：`auth_type=cookie`，且 `auth_payload` 至少包含 `cookie`
  - `uuzuhao`：`auth_type=token`，且 `auth_payload` 至少包含 `app_key`、`app_secret`
- `auth_payload` 为实际登录态/令牌内容，按 `auth_type` 解析。
- `auth_status` 用于运行时快速判断凭据可用性（`valid` 可用，`expired` 过期，`revoked` 人工撤销）。

## 4.4 表：`scan_result`（可选）
本阶段可不落表；若开启留痕，结构按 PRD：
- `run_id`, `user_id`, `game_account`, `snapshot`, `action_summary` + 公共字段。

## 5. 接口设计

## 5.1 认证类
1. `POST /api/user/login`
- 入参：`account`, `password`
- 出参：`access_token`, `refresh_token`, `user`
- 行为：校验账号状态，成功后更新 `last_login_at`。

2. `POST /api/user/logout`
- 入参：`refresh_token`
- 行为：refresh token 作废。

3. `GET /api/user/me`
- Header：`Authorization: Bearer <access_token>`
- 出参：当前用户信息。

## 5.2 用户管理类
1. `POST /api/user/create`（管理员）
- 入参：`account`, `password`, `name`, `phone`, `user_type`, `notify_config`
- 约束：仅 `admin` 可调用。

## 5.3 账号归属类
1. `POST /api/user/accounts/sync`
- 行为：按当前用户在 `user_platform_auth` 中的有效授权拉取账号并 upsert。
- 同步规则：
  - 以 `user_id + game_name + game_account` 作为唯一键。
  - `channel_status` 合并更新（本次平台覆盖对应 key）。

2. `GET /api/user/accounts`
- 支持分页：`page`, `page_size`
- 返回当前用户账号列表。

## 5.4 授权类
1. `POST /api/user/platform-auth/upsert`
- 入参：`platform`, `auth_type`, `auth_payload`, `expire_at`
- 行为：保存或更新用户平台授权。

2. `GET /api/user/platform-auth/list`
- 返回当前用户三平台授权状态。

## 6. 关键流程

## 6.1 登录流程
1. 校验账号密码。
2. 校验 `status=enabled`。
3. 签发 access/refresh token。
4. 写入 `last_login_at`。

## 6.2 账号同步流程
1. 读取当前用户有效授权列表。
2. 分平台调用现有抓取函数（`zuhaowang_api.js` / `uhaozu_api.js` / `uuzuhao_api.js`）。
3. 标准化字段：`game_account`, 平台状态（平台存在性由 `channel_status` key 表达）。
4. 按 `user_id + game_name + game_account` upsert `user_game_account`。

## 6.3 扫描与通知路由流程
1. 扫描产出 `snapshot.accounts`。
2. 通过 `game_account -> user_id` 映射分组。
3. 每个用户加载 `notify_config`。
4. 调用 `report/dingding` 和 `report/telegram` 发送用户维度消息。
5. 某用户通知失败仅记录错误，不影响其他用户。

## 7. 代码改造点（与现有文件映射）
- `rent_robot_main.js`
  - 增加 `USER_MODE_ENABLED` 判断。
  - 在冲突检测后增加“归属映射 + 分组通知”。
- `report/report_rent_status.js`
  - 新增按用户构建 payload 的函数，例如 `buildReportPayloadByUser(userId)`。
- `database/user_db.js`
  - 增加 `status`、`last_login_at` 字段支持。
  - 增加 refresh token 持久化或黑名单能力。
- `database/init_sqlite.js`
  - 扩展为统一初始化入口，包含 user 相关新表初始化。

## 8. 配置与密钥
新增环境变量：
- `USER_MODE_ENABLED=true|false`
- `JWT_ACCESS_SECRET`
- `JWT_REFRESH_SECRET`
- `ACCESS_TOKEN_TTL_SEC`（默认 1800）
- `REFRESH_TOKEN_TTL_SEC`（默认 2592000）

## 9. 安全设计
- 密码：PBKDF2 继续沿用，参数最小 120000 轮。
- 授权凭据：`auth_payload` 以明文 JSON 入库（访问控制与日志脱敏仍需保留）。
- 日志：禁止输出 cookie、token、auth_payload 明文。
- 鉴权失败、授权失效需写审计日志（可先写文件，后续入表）。

## 10. 实施计划

### Phase 1（本期）
- 表结构迁移：`user` 补强 + 新建 `user_game_account`、`user_platform_auth`
- 完成登录接口、用户创建接口
- 完成 `accounts/sync` 与 `accounts/list`
- 扫描后按用户路由通知（先通知，不改自动上下架执行策略）

### Phase 2
- 平台授权入口完整化（start/callback）
- 全量替换全局硬编码凭据为用户级凭据
- 授权过期阻断对应平台逻辑并通知用户钉钉群

### Phase 3
- 扫描执行按用户限流并发
- 增加 `scan_result` 留痕与审计查询能力

## 11. 测试与验收
- 单元测试：
  - `user_db` 登录、禁用用户、密码校验
  - `user_game_account` upsert 与 JSON 合并
  - `user_platform_auth` 失效标记
- 集成测试：
  - 用户授权 -> 账号同步 -> 扫描 -> 按用户通知闭环
- 回归测试：
  - `USER_MODE_ENABLED=false` 时主流程行为不变

验收口径：
1. 管理员可创建用户并登录。
2. 用户同步后只看到自己的账号。
3. 同一账号仅一行，平台状态写入 `channel_status`。
4. 授权失效时对应平台阻断并通知该用户群。
5. 关闭用户模式后系统回退单用户旧逻辑。

## 12. 回滚策略
- 数据回滚：保留新表，不删除；仅关闭 `USER_MODE_ENABLED`。
- 代码回滚：回退 `rent_robot_main.js` 与 `report` 相关改动。
- 风险控制：上线初期仅对白名单用户开启用户模式。
