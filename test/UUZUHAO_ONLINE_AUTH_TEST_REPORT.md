# 悠悠在线鉴权暂停测试报告

## 环境与范围

- 日期：2026-10-22，北京时间。
- 本机 macOS，Node.js v24.13.0，SQLite 临时数据库，Chrome 无头浏览器。
- Node 测试使用独立 MAIN/RUNTIME/ORDER/STATS/PRICE 五库，外部平台请求均以 fixture/stub 拦截；浏览器使用真实应用 HTML/CSS/JS 和请求处理代码，所有请求均由测试夹具响应。
- 实现及测试没有连接或修改生产环境，没有在生产打标、停止任务、执行迁移或发布。

## 实现清单

| 范围 | 文件与行为 |
| --- | --- |
| 错误分类与状态 | `common/uuzuhao_auth_state.js`、`product/uuzuhao_online_auth_service.js`：仅在线接口指定错误打标，手工真实成功清除，返回结构化授权状态 |
| 持久化 | `database/uuzuhao_auth_state_db.js`、`database/user_game_account_db.js`、迁移 `20261022_021_uuzuhao_online_auth_state.js`：新增 JSON 字段，严格用户/游戏/账号身份，事务与响应时序保护 |
| 后台入口 | `product/prod_probe_cache_service.js`、`product/prod_status_guard.js`：请求前拦截，失败后落标，现有任务等待授权，不消耗重试次数，不误解决风险或释放黑名单 |
| H5/API | `h5/local_h5_server.js`、`h5/public/js/app_core.js`、`h5/public/js/menu_products.js`、`h5/public/js/ui/uuzuhao_auth_status.js`：透传标记和结构化失败，按完整游戏身份查询，跨用户迟到响应隔离 |
| 展示及文档 | `h5/public/index.html`、`h5/public/css/app.css`、`h5/COMPONENT_GUIDE.md`、`product/PROD_GUARD_PRD.md`：复用标签、按钮与 Toast，保留渠道价格，版本化静态资源 |

## 测试结果

执行命令：`npm run coverage:uuzuhao-online-auth`，最终退出码 0。

- Node 入口组 8/8 通过，实际运行 19 个测试文件，包括新增 5 个定向测试、原授权暂停 12 个回归、渠道价格前端及游戏身份回归。
- Chrome 48/48 布局组合通过：320/375/390/430/768/1280px，王者/和平精英/CFM/CS2，普通与维护状态。
- 浏览器额外验证首次失败即时打标、手工恢复且禁玩查询失败、关闭在线风控开关时仍可手工验证授权、切换用户后旧响应及旧清理逻辑不污染新用户。共 8 个夹具 API 请求，页面 JS 错误 0。
- `git diff --check` 通过。
- 补充执行 `npm run test:identity-regression`、`npm run test:schema-migration`、`npm run test:product-channel-price`，全部通过；包含旧库全迁移幂等、游戏身份、手工开关及渠道价格 API 回归。这些补充命令未混入下表覆盖率采样批次。

| 类别 | 验证内容 | 结果 |
| --- | --- | --- |
| 精准识别 | 映射码 201010027、原始 -50000 与 QQ 鉴权失败；85004 超时、12101001 商品不存在、其他错误及禁玩接口同码不误标 | 通过 |
| 暂停 | 首次失败保存；连续后台调用零上游请求；旧在线缓存不能绕过；普通巡检、风险新建及已有任务均受控 | 通过 |
| 安全 | 风控等待不消耗重试次数，任务和风险事件保持开放，黑名单不误释放，失败不伪造离线 | 通过 |
| 恢复 | 手工失败保留；真实在线或离线查询成功清除；缓存、禁玩结果、不支持游戏的跳过结果不清除 | 通过 |
| 隔离与并发 | 不同用户/游戏独立；旧失败晚于手工成功到达不能重新打标；旧成功不能清除新失败；跨用户迟到响应不更新卡片或 Loading | 通过 |
| 兼容 | 旧库补字段、迁移幂等、列重建保留标记、商品同步和模块重载保留标记 | 通过 |
| 展示 | 顶部需重新授权；原维护原因不被挤压；悠悠异常为红色；档位及时租不丢失且不使用目标档位；其他渠道不变 | 通过 |

## 覆盖率

Node V8 覆盖率与 Chrome 精确覆盖率合并。没有排除困难代码或增加覆盖率忽略指令。

完整核心文件门槛为行覆盖率 >=90%，本次全部达到：

| 文件 | 行 | 分支 | 函数 |
| --- | ---: | ---: | ---: |
| `common/uuzuhao_auth_state.js` | 100% | 100% | 100% |
| `database/uuzuhao_auth_state_db.js` | 100% | 94% | 100% |
| `database/migrations/20261022_021_uuzuhao_online_auth_state.js` | 100% | 100% | 100% |
| `product/uuzuhao_online_auth_service.js` | 100% | 100% | 100% |
| `product/prod_probe_cache_service.js` | 97.47% | 56.49% | 100% |
| `h5/public/js/ui/uuzuhao_auth_status.js` | 100% | 100% | 100% |

旧文件接入部分逐文件检查本次变更行覆盖率：账号数据层 7/7、风控 16/16、H5 服务 14/14、商品页 38/38、请求工具 1/1，合计 76/76，即 100%。这不是这些旧文件的完整文件覆盖率。

旧完整文件在本次定向测试中的覆盖率如下，未达到 90% 的结果不隐藏：

| 旧文件 | 完整行 | 完整分支 | 完整函数 |
| --- | ---: | ---: | ---: |
| `database/user_game_account_db.js` | 53.65% | 41.14% | 65.21% |
| `product/prod_status_guard.js` | 65.31% | 38.77% | 77.14% |
| `h5/local_h5_server.js` | 32.17% | 45.35% | 26.73% |
| `h5/public/js/menu_products.js` | 43.27% | 94.10% | 44.82% |
| `h5/public/js/app_core.js` | 50.22% | 38.96% | 31.34% |

本次纳入的 11 个文件合计行 47.78%、分支 60.60%、函数 47.10%；这是包含大量旧代码的定向范围，不能描述为全仓覆盖率，也不能描述为这些旧文件完整覆盖率已达 90%。

报告产物：

- `coverage/uuzuhao-online-auth/combined/index.html`：完整合并覆盖率。
- `coverage/uuzuhao-online-auth/combined/core-coverage.json`：逐核心文件及旧接入变更行明细。
- `coverage/uuzuhao-online-auth/visual-results.json`：48 组布局、8 个夹具请求和页面错误检查结果。
- `coverage/uuzuhao-online-auth/auth-390.png`、`auth-390-maintenance.png`、`auth-1280.png`、`auth-1280-maintenance.png`：已人工查看手机截图确认标签完整；另有桌面产物。

## 本地运行与生产边界

- 本地库迁移前备份：`/tmp/rent-task-auth-backup.jGZxkM/rent_robot.db`。
- 本地 H5 已重启并加载最终代码，访问 `http://127.0.0.1:8080/?menu=products`，`/api/ping` 返回 `ok:true`。
- 本地数据库确认迁移 `20261022_021` 已应用；旧数据未按历史日志批量打标，后续首次真实匹配错误才打标。
- 为避免本地已有生产快照风控任务触发真实渠道动作，本次使用临时 LaunchAgent 启动配置：`SHEEP_FIX_ENABLE=0`、`ACTION_ENABLE=0`；服务仍由原标签 `com.renttask.h5.local` 托管。
- 临时启动文件：`/tmp/rent-task-auth-backup.jGZxkM/com.renttask.h5.local.plist`。原 `~/Library/LaunchAgents/com.renttask.h5.local.plist` 未修改；后续从原文件重新加载时仍按原配置启用任务。
- 本次没有修改用户/账号手工开关，也没有修改生产环境。生产发布须另外授权，并使用既有 `scripts/merge_code.sh`。

## 剩余风险与回滚

- 尚未在生产执行真实“重新授权后恢复”的完整验证；当前平台错误码对应关系以用户已确认的映射为依据，平台改码后需要更新分类器。
- 标记不会自动过期，号主必须在悠悠处理授权后手动“状态查询”；仅保存主渠道授权、同步商品或禁玩成功均不会清除。
- 缺少数据库记录或数据库不可用时不能承诺持久化成功；错误会向上抛出，后台读取标记失败时不会继续请求在线接口。
- 旧模块的未覆盖分支仍以完整报告为准，没有将接入行覆盖率包装成旧模块完整覆盖率。
- 过程中出现过 Chrome 进程启动失败，未涉及业务断言；已关闭测试进程的崩溃上报，并仅对进程创建阶段设置最多 3 次重试，业务断言不重试、不忽略。最终完整命令退出码 0，48 组浏览器检查通过，最后一次运行启动重试为 0；启动失败明细会记录在视觉结果中。
- 代码回滚可保留新增字段与标记，不删除业务数据；旧版本不识别此标记，会恢复原来的查询行为。
