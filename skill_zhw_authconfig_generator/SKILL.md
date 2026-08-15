# skill_zhw_authconfig_generator

Use this skill when the user provides a Zuhaowang/Yuanbao `phoneLogin` request/response capture and asks to generate or update the `zuhaowang` channel authorization config for a user.

## Goal

Generate a production-safe command that writes `user_platform_auth.platform = 'zuhaowang'` for a target `uid`, using the project's canonical `auth_payload.yuanbao` structure.

The generated config must preserve the request package and version headers from the capture. Do not default to `com.duodian.merchant` when the request header contains another `packagename`, because Zuhaowang can return `code=30004 desc=账号登录失效` when `token/deviceId` and `packagename` do not match.

## Required Inputs

Ask for any missing required input before generating the final command:

- Target `uid`.
- Full `phoneLogin` response JSON.
- The `phoneLogin` request headers or full curl command.

Useful request headers:

- `packagename`
- `x-versioncode`
- `x-versionnumber`
- `x-channel`
- `User-Agent`
- `mainversion`
- `appversion`, if present
- `content-type`, if present

Useful response fields:

- `code`
- `desc`
- `timestamp`
- `data.userId`
- `data.nickName`
- `data.token`
- `data.deviceId`

## Field Mapping

Store only the top-level `yuanbao` node in `auth_payload`.

```json
{
  "yuanbao": {
    "code": "0",
    "desc": "ok",
    "timestamp": 0,
    "data": {},
    "token": "response.data.token",
    "deviceId": "response.data.deviceId",
    "package_name": "request header packagename",
    "app_version": "request header appversion or x-versioncode",
    "main_version": "request header mainversion or x-versioncode",
    "x_versioncode": "request header x-versioncode",
    "x_versionnumber": "request header x-versionnumber",
    "x_channel": "request header x-channel",
    "user_agent": "request header User-Agent",
    "content_type": "application/json; charset=UTF-8"
  }
}
```

Rules:

- `yuanbao.token` must come from `response.data.token`.
- `yuanbao.deviceId` must come from `response.data.deviceId`.
- `yuanbao.package_name` must come from request header `packagename`.
- If `packagename` is absent, warn before defaulting to `com.duodian.merchant`.
- For captures from `com.duodian.freehire`, store `package_name = 'com.duodian.freehire'`.
- Keep `auth_type = 'token'`, `auth_status = 'valid'`, `channel_enabled = 1`, `expire_at = ''`.
- Do not write legacy top-level keys such as `token_get`, `token_post`, `device_id`, or `package_name`.
- Do not write `auth_payload.zuhaowang`.

## Preferred Production Update Command

Prefer using the project database API instead of hand-written SQL so payload normalization remains compatible with the codebase.

Template:

```bash
cd /Users/mac/.openclaw/workspace/rent_task && /usr/local/bin/node <<'NODE'
const { upsertUserPlatformAuth, listUserPlatformAuth } = require('./database/user_platform_auth_db');

(async () => {
  const uid = TARGET_UID;

  const payload = {
    yuanbao: {
      code: 'RESPONSE_CODE',
      desc: 'RESPONSE_DESC',
      timestamp: RESPONSE_TIMESTAMP,
      data: RESPONSE_DATA_OBJECT,
      token: 'RESPONSE_DATA_TOKEN',
      deviceId: 'RESPONSE_DATA_DEVICE_ID',
      package_name: 'REQUEST_HEADER_PACKAGENAME',
      app_version: 'REQUEST_HEADER_APPVERSION_OR_X_VERSIONCODE',
      main_version: 'REQUEST_HEADER_MAINVERSION_OR_X_VERSIONCODE',
      x_versioncode: 'REQUEST_HEADER_X_VERSIONCODE',
      x_versionnumber: 'REQUEST_HEADER_X_VERSIONNUMBER',
      x_channel: 'REQUEST_HEADER_X_CHANNEL',
      user_agent: 'REQUEST_HEADER_USER_AGENT',
      content_type: 'application/json; charset=UTF-8'
    }
  };

  const updated = await upsertUserPlatformAuth({
    user_id: uid,
    platform: 'zuhaowang',
    auth_type: 'token',
    auth_payload: payload,
    auth_status: 'valid',
    channel_enabled: true,
    expire_at: '',
    desc: 'update zuhaowang auth from phoneLogin capture'
  });

  const rows = await listUserPlatformAuth(uid, { with_payload: false });
  console.log(JSON.stringify({ ok: true, updated, platforms: rows }, null, 2));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
NODE
```

## Direct Patch Command For Existing Config

If the user only needs to fix package/version headers for an existing `zuhaowang` row, generate a small Node command that reads the current payload, updates the `yuanbao` header fields, and writes it back.

Template:

```bash
cd /Users/mac/.openclaw/workspace/rent_task && /usr/local/bin/node <<'NODE'
const { openDatabase } = require('./database/sqlite_client');

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => db.run(sql, params, function onRun(err) {
    if (err) return reject(err);
    resolve(this);
  }));
}

function nowText() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

(async () => {
  const uid = TARGET_UID;
  const db = openDatabase();
  try {
    const row = await get(db, "SELECT id, auth_payload FROM user_platform_auth WHERE user_id = ? AND platform = 'zuhaowang' AND is_deleted = 0 LIMIT 1", [uid]);
    if (!row) throw new Error('zuhaowang auth not found for uid=' + uid);

    const payload = JSON.parse(row.auth_payload || '{}');
    payload.yuanbao = payload.yuanbao && typeof payload.yuanbao === 'object' ? payload.yuanbao : {};
    payload.yuanbao.package_name = 'REQUEST_HEADER_PACKAGENAME';
    payload.yuanbao.app_version = 'REQUEST_HEADER_APPVERSION_OR_X_VERSIONCODE';
    payload.yuanbao.main_version = 'REQUEST_HEADER_MAINVERSION_OR_X_VERSIONCODE';
    payload.yuanbao.x_versioncode = 'REQUEST_HEADER_X_VERSIONCODE';
    payload.yuanbao.x_versionnumber = 'REQUEST_HEADER_X_VERSIONNUMBER';
    payload.yuanbao.x_channel = 'REQUEST_HEADER_X_CHANNEL';
    payload.yuanbao.user_agent = 'REQUEST_HEADER_USER_AGENT';
    payload.yuanbao.content_type = 'application/json; charset=UTF-8';

    await run(db, "UPDATE user_platform_auth SET auth_payload = ?, auth_status = 'valid', channel_enabled = 1, modify_date = ?, desc = ? WHERE id = ?", [
      JSON.stringify(payload),
      nowText(),
      'fix zuhaowang package/version headers from verified capture',
      row.id
    ]);

    const updated = await get(db, "SELECT id,user_id,platform,auth_status,channel_enabled,modify_date,desc,json_extract(auth_payload,'$.yuanbao.package_name') AS package_name,json_extract(auth_payload,'$.yuanbao.x_versionnumber') AS x_versionnumber,json_extract(auth_payload,'$.yuanbao.x_channel') AS x_channel FROM user_platform_auth WHERE id = ?", [row.id]);
    console.log(JSON.stringify({ ok: true, updated }, null, 2));
  } finally {
    db.close();
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
NODE
```

## Validation Command

After updating production config, always validate both product and order channels using the stored production payload.

Template:

```bash
cd /Users/mac/.openclaw/workspace/rent_task && /usr/local/bin/node <<'NODE'
const { listUserPlatformAuth } = require('./database/user_platform_auth_db');
const { getGoodsListByEncryptedPayload, getOrderListByEncryptedPayload } = require('./zuhaowang/zuhaowang_api');

function mapZhwAuth(payload = {}, uid = 0) {
  const y = payload.yuanbao || {};
  const data = y.data || {};
  return {
    token: y.token || data.token,
    token_yuanbao: y.token || data.token,
    token_get: y.token || data.token,
    token_post: y.token || data.token,
    device_id: y.deviceId || data.deviceId,
    package_name: y.package_name,
    app_version: y.app_version,
    main_version: y.main_version,
    x_versioncode: y.x_versioncode,
    x_versionnumber: y.x_versionnumber,
    x_channel: y.x_channel,
    user_agent: y.user_agent,
    content_type: y.content_type || 'application/json; charset=UTF-8',
    user_id: uid
  };
}

(async () => {
  const uid = TARGET_UID;
  const rows = await listUserPlatformAuth(uid, { with_payload: true });
  const hit = rows.find((row) => row.platform === 'zuhaowang');
  if (!hit) throw new Error('missing zuhaowang auth for uid=' + uid);

  const auth = mapZhwAuth(hit.auth_payload || {}, uid);
  console.log('auth_header=', JSON.stringify({
    package_name: auth.package_name,
    x_versionnumber: auth.x_versionnumber,
    x_channel: auth.x_channel,
    device_id: auth.device_id
  }));

  const goods = await getGoodsListByEncryptedPayload({ biz_params: {} }, auth, {
    user_id: uid,
    trace_id: 'manual-check-goods-uid' + uid
  });
  console.log('goods_ok=', JSON.stringify({
    total: goods.total_count,
    list_len: Array.isArray(goods.goods_list) ? goods.goods_list.length : 0,
    status_count: goods.status_count || {}
  }));

  const now = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const day = now.getFullYear() + '-' + p(now.getMonth() + 1) + '-' + p(now.getDate());
  const orders = await getOrderListByEncryptedPayload({
    biz_params: {
      pageNum: 0,
      pageSize: 15,
      queryType: 0,
      sortType: 1,
      fromDate: day,
      toDate: day
    }
  }, auth, {
    user_id: uid,
    trace_id: 'manual-check-orders-uid' + uid
  });
  console.log('orders_ok=', JSON.stringify({
    total: orders.total_count,
    list_len: Array.isArray(orders.order_list) ? orders.order_list.length : 0
  }));
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
NODE
```

## Standalone Curl Smoke Test

If the user wants to test before changing production config, generate a `getAccountList` curl using `zuhaowang/toEncryptBody.js` to produce the encrypted `ak/data`. Do not invent static `ak/data`; generate it locally from the project.

Local generator:

```bash
node <<'NODE'
const { buildEncryptedBody } = require('./zuhaowang/toEncryptBody');
const body = buildEncryptedBody({});
const token = 'RESPONSE_DATA_TOKEN';
const deviceId = 'RESPONSE_DATA_DEVICE_ID';
const cmd = [
  "curl -sS -X POST 'https://api-game.duodian.cn/api/ybzs/accountManage/getAccountList'",
  "-H 'token: " + token + "'",
  "-H 'deviceid: " + deviceId + "'",
  "-H 'packagename: REQUEST_HEADER_PACKAGENAME'",
  "-H 'source: android'",
  "-H 'appversion: REQUEST_HEADER_APPVERSION_OR_X_VERSIONCODE'",
  "-H 'mainversion: REQUEST_HEADER_MAINVERSION_OR_X_VERSIONCODE'",
  "-H 'x-versioncode: REQUEST_HEADER_X_VERSIONCODE'",
  "-H 'x-versionnumber: REQUEST_HEADER_X_VERSIONNUMBER'",
  "-H 'x-channel: REQUEST_HEADER_X_CHANNEL'",
  "-H 'User-Agent: REQUEST_HEADER_USER_AGENT'",
  "-H 'content-type: application/json; charset=UTF-8'",
  "-d '" + JSON.stringify(body) + "'",
  "--compressed --http2"
].join(' \\\\\n+  ');
console.log(cmd);
NODE
```

Expected success:

```json
{"code":"0","desc":"ok","data":[...]}
```

Known failure:

```json
{"code":"30004","desc":"账号登录失效"}
```

When `phoneLogin` succeeds but `getAccountList` returns `30004`, first verify that `packagename`, `deviceid`, `token`, `x-versionnumber`, and `x-channel` match the same capture.

## Output Checklist

When using this skill, provide:

1. The production update command.
2. The validation command.
3. A brief note identifying the stored `package_name`.
4. A warning if any request header was missing and defaulted.

