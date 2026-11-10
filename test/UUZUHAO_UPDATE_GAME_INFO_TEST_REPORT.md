# 悠悠更新账号信息接口对接与测试报告

## 结果

- 日期：2026-11-09，北京时间。环境：本地 macOS、Node.js v24.13.0。
- 代码对接完成，新增 `updateProductGameInfo(productId, { auth })`，业务参数只有字符串 `productId`；复用统一签名、秒级时间戳、15秒默认超时与错误处理。
- 离线验证通过：5个测试入口，新接口39个用例，离线失败项0。
- 真实联通未成功：uid=8 的单商品更新请求仅发送1次，正式平台返回 HTTP 404、业务码84004、`Not Found`；未重试。
- 未发布生产服务。没有数据库迁移，没有把新接口挂入定时同步，也没有回写本地商品快照。

## 实际改动

| 文件 | 行为 |
| --- | --- |
| `uuzuhao/uuzuhao_api.js` | 新增路径常量、方法及导出；校验字符串ID、保留 `data/raw` 原始类型与未知字段；无自动重试及响应日志 |
| `test/uuzuhao_update_game_info_api_test.js` | 新增39个用例，包含本次实际遇到的404/84004错误回归 |
| `test/run_uuzuhao_update_game_info_tests.js` | 统一运行新接口及既有回归，五库临时路径隔离，阻断未被夹具替换的真实HTTP |
| `package.json` | 新增定向测试及完整客户端覆盖率命令 |
| `uuzuhao/youyouzuhao_api.md` | 补充截图接口契约、调用方式、更新边界及本次联通结果；未改动其他接口 |

## 离线验证

```bash
npm run coverage:uuzuhao-update-game-info
```

最终退出码0，入口全部通过：

1. `uuzuhao_update_game_info_api_test.js`：39个用例。
2. `uuzuhao_modify_price_api_smoke_test.js`：既有签名、商品查询/状态映射、上下架、价格、禁玩及订单API回归。
3. `uuzuhao_auth_revoke_smoke_test.js`：授权解除签名、秒级时间戳及失败回归。
4. `uuzuhao_game_mapping_smoke_test.js`：既有游戏映射回归。
5. `uuzuhao_auth_abnormal_mapping_smoke_test.js`：授权异常商品映射回归。

新接口用例验证了：

- 路径、POST JSON及Content-Type正确，签名由测试独立MD5计算，与秒级时间戳一同校验。
- 18位商品ID保真；空字符串、非字符串、缺少授权在真实请求前失败。
- 业务data的对象、数组、字符串、false、0、null与缺失均保留，未知字段也不丢失；不将截图中的字符串强制改为列表。
- HTTP 401/404/503、非JSON、业务错误、网络错误、响应读取失败均如实抛出。
- Abort超时触发取消；上述成功、失败和超时均断言请求次数，没有自动重试。
- 成功及失败不输出授权、签名或账号信息值。

离线夹具只使用测试授权；MAIN/RUNTIME/ORDER/STATS/PRICE均指定临时目录。runner在测试进程阻断默认fetch及http/https客户端，真实平台调用不在自动测试中。

## 覆盖率

范围为**完整 `uuzuhao/uuzuhao_api.js` 文件**，不是全仓覆盖率，没有排除困难代码。

| 文件 | 行 | 分支 | 函数 |
| --- | ---: | ---: | ---: |
| `uuzuhao/uuzuhao_api.js` | 92.30%（612/663） | 71.64%（187/261） | 96.96%（32/33） |

新方法的正常与异常路径均有实际断言；尚未覆盖部分既有模糊商品定位、上下架失败和默认分支，不把行覆盖率视为全部分支已覆盖。

明细：`coverage/uuzuhao-update-game-info/coverage-final.json`、`coverage-summary.json`、`index.html`；逐入口日志位于其 `test-logs/`。

## 用户明确授权的单商品真实联通

- 号主：uid=8。
- 商品：呆熊宝，QQ `983394885`，`productId="202601141000819243"`，游戏ID1。
- 本地授权及ID读取使用只读连接；未调用数据库初始化或迁移入口，未输出授权。
- 先于22:01:19查询正式商品列表，再于22:01:33调用前复查。两次只读查询均HTTP 200，精确确认商品归属及当前 `saleStatus=1000/productStatus=1000`，未显示出租中。
- 22:01:33发送唯一一次 `POST /api/youpin/rent-connector/product/v1/updateProductGameInfo`。
- 更新请求耗时43ms，HTTP 404，`code="84004"`，`msg="Not Found"`。
- 更新请求未重试、未换商品重复更新，也未试探其他更新路径。测试执行器在发送前写入私有的一次性尝试标记，避免误重复执行。
- 成功返回的业务字段结构与实际刷新效果尚未得到验证；不能凭失败返回声称商品已更新。

直接证据表明同一授权能调用正式商品列表，本次更新路径未联通。具体是路径、正式环境开放状态、网关或接口权限差异，现有证据无法确定，需悠悠平台确认；未将推断写为已确认根因。

私有脱敏测试证据和结果（不含授权或账号信息值）：

`/Users/rs/.codex/artifacts/rent_task/uuzuhao-update-game-info-20261109-1794232878902/`

其中 `preflight-result.json`、`once-result.json` 记录结果摘要，`update-attempt.json` 记录唯一尝试。未保存完整平台响应或签名body。

## 本地服务及兼容性

- 本地H5已重启，单一8080监听PID12367，`GET /api/ping` 返回 `ok:true`。
- 保持原本本地预览的 `SHEEP_FIX_ENABLE=false`，不启动预览后台风控调用；生产服务未重启或发布。
- 页面及公共组件没有修改，无新增视觉组件范围。
- 工作区原有 `rent_robot.db`、`rent_robot_runtime.db` 运行态差异保留，未把它们作为源码提交。
- 回退时撤回本次独立API方法、测试及文档即可，无需数据库回滚；代码回退不代表撤销平台已处理过的动作。

## 后续边界

本次已完成代码实现、离线验证及获授权的一次真实联通测试。平台需确认截图接口在正式域名下的实际可用路径和开放状态，再安排后续真实验证；当前不自动重复调用。
