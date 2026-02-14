# rent_task

租号机器人独立项目目录。当前目录已包含运行所需的 Node 依赖与脚本。

## 目录结构

- `rent_robot_main.js`: 主流程
- `report/report_rent_status.js`: 汇报生成
- `zuhaowang/`: 租号王平台逻辑
- `uhaozu/`: U号租平台逻辑
- `uuzuhao/`: 悠悠租号平台逻辑
- `config/blacklist.json`: 黑名单配置
- `config/codex_rule.md`: Codex 开发规则

## 开发规则（数据库）

后续按照阿里和字节的规范执行数据库建表。每次新建表都要包含必要公共字段，至少包括：

- `id`（主键）
- `create_date`（创建时间）
- `modify_date`（修改时间）
- `is_deleted`（逻辑删除标记）
- `desc`（备注/说明）

编码前请先阅读：`config/codex_rule.md`

## 本地运行

本机 Node 版本：`v24.13.0`

```bash
cd rent_task
npm install
node rent_robot_main.js --run
node report/report_rent_status.js
```

## H5 本地联调

已提供本地 H5 页面（登录 + 商品列表 + 黑名单进出）：

```bash
cd rent_task
npm run h5:local
```

打开：`http://127.0.0.1:8080`

本地 API：
- `POST /api/login`
- `GET /api/products?page=1&page_size=20`
- `POST /api/blacklist/add`
- `POST /api/blacklist/remove`

## 生产触发（本机）

脚本入口在：

```bash
/Users/mac/.openclaw/scripts/trigger_rent_smart.sh
```

立即执行一轮全流程：

```bash
bash /Users/mac/.openclaw/scripts/trigger_rent_smart.sh --now
```

## 远程开发建议

- 建议把 `rent_task/` 作为 GitHub 仓库根目录（或子模块）维护。
- 不要提交 `node_modules/`、运行日志和状态缓存；用 `npm install`/`npm ci` 还原依赖。
- 线上机器部署建议流程：
  1. `git pull`
  2. `cd rent_task && npm ci`
  3. `bash /Users/mac/.openclaw/scripts/trigger_rent_smart.sh --now` 验证
  4. 保持 LaunchAgent 持续调度

### 密码模式一键同步（已打通）

适用于当前远端：
- 主机：`mac@139.196.84.63`
- 端口：`3333`
- 目录：`/Users/mac/.openclaw/workspace/rent_task/`

仓库内已提供脚本：`scripts/sync_remote_password.sh`

执行方式（覆盖同步 + 关键文件哈希校验）：

```bash
cd /Users/rs/Downloads/Code/rent_task
REMOTE_SSH_PASS='你的SSH密码' bash scripts/sync_remote_password.sh
```

脚本行为：
- 使用 `rsync --delete` 覆盖远端目录（排除 `.git`、`node_modules`、`.DS_Store`）。
- 同步后自动对比以下文件的本地/远端 `shasum`：
  - `database/user_blacklist_db.js`
  - `report/report_rent_status.js`
  - `rent_robot_main.js`
- 输出 `[OK] 哈希一致，远端已与本地同步` 即表示同步成功。

安全建议：
- 不要把明文密码写入仓库；仅通过环境变量 `REMOTE_SSH_PASS` 临时传入。
- 长期建议改为 SSH Key 免密登录，减少密码链路维护成本。

### TODO（准确性 vs 风控）

- 当前主流程已暂时关闭“执行上下架后立即二次全量拉取”的逻辑，以降低请求频次和风控风险。
- 后续待设计并实现：在不明显增加调用次数的前提下，提升通知状态准确性（例如仅对成功动作做增量校验、延迟抽样复核、失败动作不触发回拉）。
