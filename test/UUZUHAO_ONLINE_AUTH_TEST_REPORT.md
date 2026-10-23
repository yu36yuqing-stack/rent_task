# 悠悠在线授权与商品缺失暂停测试报告

## 环境与范围

- 日期：2026-10-23，北京时间；在 2026-10-22 授权暂停能力上增量支持商品缺失。
- 本机 macOS，Node.js v24.13.0，SQLite 临时数据库，Chrome 无头浏览器。
- Node 测试使用独立 MAIN/RUNTIME/ORDER/STATS/PRICE 五库，外部平台请求均以 fixture/stub 拦截；浏览器使用真实应用 HTML/CSS/JS 和请求处理代码，所有请求均由测试夹具响应。
- 本次实现和自动化测试没有调用真实渠道接口或执行生产写操作，没有在生产打标、停止任务、执行迁移或发布。前置排查只同步业务库和日志，未回拉 Runtime 库。

## 实现清单

| 范围 | 文件与行为 |
| --- | --- |
| 错误分类与提示 | 修改 `common/uuzuhao_auth_state.js`：在线错误 `12101001` 返回原因“悠悠商品不存在”，暂停错误按保存的错误码区分提示；原 QQ 错误识别不变 |
| 持久化与后台 | 复用已有 `user_game_account.uuzuhao_auth_state` 和 Service、探测缓存、风控、黑名单守卫；本次不改数据库层、后台入口或迁移文件，不新增字段 |
| 商品卡片 | 修改 `h5/public/js/ui/uuzuhao_auth_status.js`，增加 `messageFor(item)`；`menu_products.js` 的渠道标签原因和持久 Toast 共用此方法，其他展示和状态不变 |
| 组件与静态资源 | 更新 `h5/public/index.html` 的两项 JS 版本、`h5/COMPONENT_GUIDE.md`、`product/PROD_GUARD_PRD.md`；不新增 CSS、内联样式或卡片组件 |
| 回归测试 | 修改原有 6 个授权测试文件及运行器；探测、风控和 H5 接口测试各增加一组 `12101001` 参数执行，不放宽原有断言 |

组件复用：商品页四游戏全部沿用 `UuzuhaoAuthStatus`、`.chip`、`.plat.plat-abnormal`、`ChannelPriceSummary`、卡片操作和持久 Toast；只有提示内容随错误原因变化，没有新页面或游戏分叉。旧 `message` 常量保留兼容，商品卡片改用 `messageFor(item)`。

## 测试结果

执行命令：`npm run coverage:uuzuhao-online-auth`，最终退出码 0。

- Node 入口组 11/11 通过，19 个不同测试文件共执行 22 次，包括原 19 次执行，以及探测、风控和 H5 接口各一组商品缺失参数执行。
- Chrome 96/96 布局组合通过：320/375/390/430/768/1280px，王者/和平精英/CFM/CS2，普通与维护状态，两种错误原因；另有 390/1280px 两组商品缺失 Toast 完整显示检查。
- 浏览器额外验证 QQ 错误和商品缺失首次失败即时打标、手工恢复且禁玩查询失败、关闭在线风控开关时仍可手工验证授权、切换用户后旧响应及旧清理逻辑不污染新用户。共 12 个夹具 API 请求，页面 JS 错误 0，浏览器启动重试 0。
- `git diff --check` 通过。
- 补充执行 `npm run test:identity-regression`、`npm run test:schema-migration`、`npm run test:product-channel-price`，全部通过；包含旧库全迁移幂等、游戏身份、手工开关及渠道价格 API 回归。这些补充命令未混入下表覆盖率采样批次。
- 发布前按用户确认增加 Runtime 回拉排除项，并执行 `node test/merge_code_sqlite_exclusion_test.js`：真实 rsync 验证 32 项上传保护、5 个业务库文件正常回拉、8 类 Runtime 文件和 5 类非数据库文件不回拉；同时覆盖本地无 Runtime、本地已有 Runtime 两种情形。`bash -n scripts/merge_code.sh` 通过。该运维脚本验证为独立功能测试，未将其描述为 Shell 行覆盖率；前四个发布阶段不变。

| 类别 | 验证内容 | 结果 |
| --- | --- | --- |
| 精准识别 | 在线映射码 201010027、原始 -50000 与 QQ 鉴权失败、12101001 商品不存在均打标；85004 超时、仅有错误文字而无码、其他错误及禁玩查询/设置同码不误标 | 通过 |
| 暂停 | 首次失败保存；连续后台调用零上游请求；旧在线缓存不能绕过；普通巡检、风险新建及已有任务均受控 | 通过 |
| 安全 | 风控等待不消耗重试次数，任务和风险事件保持开放，黑名单不误释放，失败不伪造离线 | 通过 |
| 恢复 | 手工失败保留；真实在线或离线查询成功清除；缓存、禁玩结果、不支持游戏的跳过结果不清除 | 通过 |
| 隔离与并发 | 不同用户/游戏独立；旧失败晚于手工成功到达不能重新打标；旧成功不能清除新失败；跨用户迟到响应不更新卡片或 Loading | 通过 |
| 兼容 | 旧库补字段、迁移幂等、列重建保留标记、商品同步和模块重载保留标记 | 通过 |
| 展示 | 顶部需重新授权；原维护原因不被挤压；悠悠异常为红色；档位及时租不丢失且不使用目标档位；其他渠道不变；前后端商品缺失提示一致，不误显示 QQ 鉴权失败 | 通过 |

## 覆盖率

Node V8 覆盖率与 Chrome 精确覆盖率合并。没有排除困难代码或增加覆盖率忽略指令。

本次实际修改的两个核心文件均达到行/分支/函数 100%；下表为完整核心回归范围，行覆盖率门槛 >=90%，全部达到：

| 文件 | 行 | 分支 | 函数 |
| --- | ---: | ---: | ---: |
| `common/uuzuhao_auth_state.js` | 100% | 100% | 100% |
| `database/uuzuhao_auth_state_db.js` | 100% | 94% | 100% |
| `database/migrations/20261022_021_uuzuhao_online_auth_state.js` | 100% | 100% | 100% |
| `product/uuzuhao_online_auth_service.js` | 100% | 100% | 100% |
| `product/prod_probe_cache_service.js` | 97.47% | 57.05% | 100% |
| `h5/public/js/ui/uuzuhao_auth_status.js` | 100% | 100% | 100% |

旧文件接入部分本次只有商品页两处提示调用变更，变更行覆盖率 2/2，即 100%。账号数据层、风控、H5 服务和请求工具本次没有改动，不将其 0/0 变更统计描述为完整文件覆盖率。

旧完整文件在本次定向测试中的覆盖率如下，未达到 90% 的结果不隐藏：

| 旧文件 | 完整行 | 完整分支 | 完整函数 |
| --- | ---: | ---: | ---: |
| `database/user_game_account_db.js` | 53.65% | 41.14% | 65.21% |
| `product/prod_status_guard.js` | 65.31% | 39.27% | 77.14% |
| `h5/local_h5_server.js` | 32.17% | 45.23% | 26.73% |
| `h5/public/js/menu_products.js` | 43.27% | 94.10% | 44.82% |
| `h5/public/js/app_core.js` | 50.22% | 38.96% | 31.34% |

本次纳入的 11 个文件合计行 47.86%、分支 60.92%、函数 47.25%；这是包含大量旧代码的定向范围，不能描述为全仓覆盖率，也不能描述为这些旧文件完整覆盖率已达 90%。

报告产物：

- `coverage/uuzuhao-online-auth/combined/index.html`：完整合并覆盖率。
- `coverage/uuzuhao-online-auth/combined/core-coverage.json`：逐核心文件及旧接入变更行明细。
- `coverage/uuzuhao-online-auth/visual-results.json`：96 组布局、2 组 Toast、12 个夹具请求和页面错误检查结果。
- `coverage/uuzuhao-online-auth/auth-product-missing-390-maintenance.png`、`auth-product-missing-1280.png`：已查看手机/桌面截图确认标签及渠道价格完整；保留原 QQ 提示截图。
- `coverage/uuzuhao-online-auth/auth-product-missing-toast-390.png`、`auth-product-missing-toast-1280.png`：商品缺失原因及恢复指引截图。

## 本地运行与生产边界

- 本地 H5 已重启并加载最终代码，访问 `http://127.0.0.1:8080/?menu=products`，`/api/ping` 返回 `ok:true`。
- 本次没有新增迁移；旧数据未按历史日志批量打标，发布后首次真实匹配错误才打标。
- 为避免本地已有生产快照风控任务触发真实渠道动作，继续使用临时 LaunchAgent 配置：`SHEEP_FIX_ENABLE=0`、`ACTION_ENABLE=0`；服务仍由原标签 `com.renttask.h5.local` 托管。
- 昨日拉回的本地 Runtime 副本已有完整性异常，本次未修复、删除或再次回拉它。预览通过环境变量 `RUNTIME_DB_FILE_PATH` 使用独立 `/tmp/rent-task-auth-backup.jGZxkM/local-preview-runtime-20261023.db`，完整性检查 `ok`；旧本地会话不迁入临时库，必要时需重新登录。
- 临时启动文件：`/tmp/rent-task-auth-backup.jGZxkM/com.renttask.h5.preview-20261023.plist`。原 `~/Library/LaunchAgents/com.renttask.h5.local.plist` 和仓库启动配置均未修改；这些本机预览环境覆盖不会进入生产发布。
- 本次没有修改用户/账号手工开关，也没有修改生产环境。生产发布须另外授权，并使用既有 `scripts/merge_code.sh`。

## 剩余风险与回滚

- 尚未在生产执行真实“恢复商品后重新查询”的完整验证；当前 `12101001` 对应商品不存在已经过生产只读日志核对，平台改码后需要更新分类器。
- 标记不会自动过期，号主必须在悠悠恢复商品或处理授权后手动“状态查询”；商品不存在不等于 QQ 鉴权失败，单纯重新授权不一定能修复被删除的商品。仅保存主渠道授权、同步商品或禁玩成功均不会清除。
- 缺少数据库记录或数据库不可用时不能承诺持久化成功；错误会向上抛出，后台读取标记失败时不会继续请求在线接口。
- 旧模块的未覆盖分支仍以完整报告为准，没有将接入行覆盖率包装成旧模块完整覆盖率。
- 本次失败项为 0，完整命令退出码 0；测试运行器只允许浏览器进程启动阶段最多 3 次重试，业务断言不重试、不忽略，最终启动重试为 0。
- 回滚到昨日版本无需回滚数据库结构，已有 `required=true` 标记仍会停查；但新发生的 `12101001` 不再打标，且旧版固定 QQ 提示会错误描述已有商品缺失标记。生产发布与回滚均须另行授权。
