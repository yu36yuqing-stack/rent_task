# TEST_USER_PART1

## 1. 测试目标
本清单覆盖当前已实现的用户能力：
1. 用户创建、登录、鉴权、注销
2. 管理员权限控制
3. 平台授权写入与读取
4. 账号同步与账号列表查询
5. 关键安全字段存储校验（密码、refresh token、平台授权密文）

## 2. 前置条件
1. 在项目根目录执行（`rent_task/`）。
2. 已安装依赖（`npm install`）。
3. 允许访问外网（`accounts-sync` 需要访问三方平台接口）。

## 3. 测试思路
1. 先走一条完整主链路：`init-db -> create-user(admin) -> login -> me -> list-users`，确认基础能力可用。
2. 再测权限边界：普通用户调用管理员接口必须失败。
3. 再测授权与同步链路：`platform-auth-upsert -> platform-auth-list -> accounts-sync -> accounts-list`。
4. 再测会话链路：`logout` 后 token 会话应失效（至少同 refresh token 二次注销返回 false）。
5. 最后做数据安全检查：数据库内密码、refresh token、auth payload 不应明文存储。

## 4. 可执行命令清单（逐条复制）
```bash
cd /Users/rs/Downloads/Code/rent_task
```

```bash
export TEST_TS=$(date +%s)
export ADMIN_ACC="admin_${TEST_TS}"
export ADMIN_PWD="Admin#${TEST_TS}"
export USER_ACC="xuzhou2026"
export USER_PWD="Xz123456"
echo "ADMIN_ACC=$ADMIN_ACC USER_ACC=$USER_ACC"
```

```bash
node api/user_api.js init-db
```

```bash
node api/user_api.js create-user \
  --account "$ADMIN_ACC" \
  --password "$ADMIN_PWD" \
  --name "Test Admin" \
  --user_type admin \
  --status enabled \
  --notify_config '{"telegram":{"bot_token":"","chat_id":""}}' \
  --desc "test bootstrap admin"
```

```bash
export ADMIN_LOGIN_JSON="$(node api/user_api.js login --account "$ADMIN_ACC" --password "$ADMIN_PWD")"
echo "$ADMIN_LOGIN_JSON"
```

```bash
export ACCESS_ADMIN="$(echo "$ADMIN_LOGIN_JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);if(!j.ok)process.exit(1);process.stdout.write(j.access_token)})")"
export REFRESH_ADMIN="$(echo "$ADMIN_LOGIN_JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);if(!j.ok)process.exit(1);process.stdout.write(j.refresh_token)})")"
echo "ACCESS_ADMIN_LEN=${#ACCESS_ADMIN} REFRESH_ADMIN_LEN=${#REFRESH_ADMIN}"
```

```bash
node api/user_api.js me --access_token "$ACCESS_ADMIN"
```

```bash
node api/user_api.js create-user \
  --actor_access_token "$ACCESS_ADMIN" \
  --account "$USER_ACC" \
  --password "$USER_PWD" \
  --name "Test User" \
  --user_type external \
  --status enabled \
  --notify_config '{"telegram":{"bot_token":"8458250702:AAH6jSTgyZyTTQzQMdUhs2Rwv91Neen2AFU","chat_id":"6796486659"}}' \
  --desc "test normal user"
```

```bash
node api/user_api.js list-users --access_token "$ACCESS_ADMIN"
```

```bash
export USER_LOGIN_JSON="$(node api/user_api.js login --account "$USER_ACC" --password "$USER_PWD")"
echo "$USER_LOGIN_JSON"
```

```bash
export ACCESS_USER="$(echo "$USER_LOGIN_JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);if(!j.ok)process.exit(1);process.stdout.write(j.access_token)})")"
export REFRESH_USER="$(echo "$USER_LOGIN_JSON" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);if(!j.ok)process.exit(1);process.stdout.write(j.refresh_token)})")"
echo "ACCESS_USER_LEN=${#ACCESS_USER} REFRESH_USER_LEN=${#REFRESH_USER}"
```

```bash
node api/user_api.js list-users --access_token "$ACCESS_USER"
```

```bash
export UHAOZU_COOKIE="$(node -e "const fs=require('fs');const s=fs.readFileSync('uhaozu/uhaozu_api.js','utf8');const m=s.match(/const UHAOZU_COOKIE = process\\.env\\.UHAOZU_COOKIE \\|\\| '([^']+)'/);if(!m)process.exit(1);process.stdout.write(m[1]);")"
echo "UHAOZU_COOKIE_LEN=${#UHAOZU_COOKIE}"
```

```bash
export ZHW_TOKEN_GET="$(node -e "const fs=require('fs');const s=fs.readFileSync('zuhaowang/zuhaowang_api.js','utf8');const m=s.match(/const TOKEN_GET = '([^']+)'/);if(!m)process.exit(1);process.stdout.write(m[1]);")"
export ZHW_TOKEN_POST="$(node -e "const fs=require('fs');const s=fs.readFileSync('zuhaowang/zuhaowang_api.js','utf8');const m=s.match(/const TOKEN_POST = '([^']+)'/);if(!m)process.exit(1);process.stdout.write(m[1]);")"
export ZHW_DEVICE_ID="$(node -e "const fs=require('fs');const s=fs.readFileSync('zuhaowang/zuhaowang_api.js','utf8');const m=s.match(/const DEVICE_ID = '([^']+)'/);if(!m)process.exit(1);process.stdout.write(m[1]);")"
export ZHW_PACKAGE_NAME="$(node -e "const fs=require('fs');const s=fs.readFileSync('zuhaowang/zuhaowang_api.js','utf8');const m=s.match(/const PACKAGE_NAME = '([^']+)'/);if(!m)process.exit(1);process.stdout.write(m[1]);")"
echo "ZHW_TOKEN_GET_LEN=${#ZHW_TOKEN_GET} ZHW_TOKEN_POST_LEN=${#ZHW_TOKEN_POST}"
```

```bash
export UUZUHAO_APP_KEY="$(node -e "const fs=require('fs');const s=fs.readFileSync('uuzuhao/uuzuhao_api.js','utf8');const m=s.match(/const APP_KEY = '([^']+)'/);if(!m)process.exit(1);process.stdout.write(m[1]);")"
export UUZUHAO_APP_SECRET="$(node -e "const fs=require('fs');const s=fs.readFileSync('uuzuhao/uuzuhao_api.js','utf8');const m=s.match(/const APP_SECRET = '([^']+)'/);if(!m)process.exit(1);process.stdout.write(m[1]);")"
export UUZUHAO_API_BASE="$(node -e "const fs=require('fs');const s=fs.readFileSync('uuzuhao/uuzuhao_api.js','utf8');const m=s.match(/const API_BASE = process\\.env\\.[A-Za-z0-9_]+ \\|\\| '([^']+)'/);if(!m)process.exit(1);process.stdout.write(m[1]);")"
echo "UUZUHAO_APP_KEY_LEN=${#UUZUHAO_APP_KEY} UUZUHAO_APP_SECRET_LEN=${#UUZUHAO_APP_SECRET}"
```

```bash
node api/user_api.js platform-auth-upsert \
  --access_token "$ACCESS_USER" \
  --platform uhaozu \
  --auth_type cookie \
  --auth_payload "{\"cookie\":\"$UHAOZU_COOKIE\"}" \
  --auth_status valid \
  --desc "test uhaozu auth"
```

```bash
node api/user_api.js platform-auth-upsert \
  --access_token "$ACCESS_USER" \
  --platform zuhaowang \
  --auth_type token \
  --auth_payload "{\"token_get\":\"$ZHW_TOKEN_GET\",\"token_post\":\"$ZHW_TOKEN_POST\",\"device_id\":\"$ZHW_DEVICE_ID\",\"package_name\":\"$ZHW_PACKAGE_NAME\",\"source\":\"android\"}" \
  --auth_status valid \
  --desc "test zuhaowang auth"
```

```bash
node api/user_api.js platform-auth-upsert \
  --access_token "$ACCESS_USER" \
  --platform uuzuhao \
  --auth_type token \
  --auth_payload "{\"app_key\":\"$UUZUHAO_APP_KEY\",\"app_secret\":\"$UUZUHAO_APP_SECRET\",\"api_base\":\"$UUZUHAO_API_BASE\"}" \
  --auth_status valid \
  --desc "test uuzuhao auth"
```

```bash
node api/user_api.js platform-auth-list --access_token "$ACCESS_USER"
```

```bash
node api/user_api.js platform-auth-list --access_token "$ACCESS_USER" --with_payload true
```

```bash
node api/user_api.js accounts-sync --access_token "$ACCESS_USER"
```

```bash
node api/user_api.js accounts-list --access_token "$ACCESS_USER" --page 1 --page_size 20
```

```bash
node api/user_api.js logout --refresh_token "$REFRESH_USER"
```

```bash
node api/user_api.js logout --refresh_token "$REFRESH_USER"
```

```bash
node api/user_api.js login --account "$USER_ACC" --password "wrong_password"
```

```bash
node -e "const s=require('sqlite3').verbose();const db=new s.Database('database/rent_robot.db');db.run(\"UPDATE user SET status='disabled' WHERE account=? AND is_deleted=0\", [process.env.USER_ACC], function(e){if(e)throw e;console.log('disabled_rows=',this.changes);db.close();});"
```

```bash
node api/user_api.js login --account "$USER_ACC" --password "$USER_PWD"
```

```bash
node -e "const s=require('sqlite3').verbose();const db=new s.Database('database/rent_robot.db');db.all(\"SELECT account,password,status,last_login_at FROM user WHERE account IN (?,?) ORDER BY id\", [process.env.ADMIN_ACC, process.env.USER_ACC], (e,r)=>{if(e)throw e;console.log(JSON.stringify(r,null,2));db.close();});"
```

```bash
node -e "const s=require('sqlite3').verbose();const db=new s.Database('database/rent_robot.db');db.all(\"SELECT user_id,substr(refresh_token_hash,1,16)||'...' AS refresh_token_hash,expire_at,is_deleted FROM user_session ORDER BY id DESC LIMIT 5\", (e,r)=>{if(e)throw e;console.log(JSON.stringify(r,null,2));db.close();});"
```

```bash
node -e "const s=require('sqlite3').verbose();const db=new s.Database('database/rent_robot.db');db.all(\"SELECT user_id,platform,auth_type,substr(auth_payload,1,24)||'...' AS auth_payload_prefix,auth_status FROM user_platform_auth ORDER BY id DESC LIMIT 10\", (e,r)=>{if(e)throw e;console.log(JSON.stringify(r,null,2));db.close();});"
```

## 5. 结果判定参考
1. `list-users --access_token "$ACCESS_USER"` 报错 `当前操作需要管理员权限`，说明权限控制正常。
2. `logout` 第一次应 `revoked=true`，第二次通常 `revoked=false`，说明 refresh token 已失效。
3. 禁用用户后再登录，返回 `账号已禁用`。
4. 数据库查询中：
   - `user.password` 应是 `pbkdf2$...` 格式，不是明文。
   - `user_session.refresh_token_hash` 应是哈希值，不是原 token。
   - `user_platform_auth.auth_payload` 应是明文 JSON（如以 `{` 开头），便于排查与维护。

## 6. 备注
1. `accounts-sync` 会请求真实平台接口；如果授权无效或网络异常，返回里会带 `errors`，这是预期可观察现象之一。
2. 本文为 PART1，聚焦 CLI 与数据层。后续可补 PART2（通知分发、USER_MODE_ENABLED 路由与回退测试）。
