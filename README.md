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

## 黑名单数据库接口（给 OpenClaw 调用）

```bash
cd rent_task

# 文件改动后同步到数据库（会先写历史，再落 current 表）
node api/blacklist_api.js sync-file --source openclaw_telegram --operator openclaw

# 新增/更新黑名单（写库后自动回写 blacklist.json）
node api/blacklist_api.js upsert --account 123456 --remark "示例账号" --reason "触发人脸识别" --create_time "2026-02-12 11:30" --action off --source openclaw_telegram --operator openclaw

# 删除黑名单（软删除，写历史，自动回写 blacklist.json）
node api/blacklist_api.js remove --account 123456 --source openclaw_telegram --operator openclaw

# 查看当前黑名单（来自数据库）
node api/blacklist_api.js list
```

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
