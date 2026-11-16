# 腾讯退出租客登录 / 悠悠平台重新授权独立执行测试报告

## 变更与范围

用户已确认两个接口业务独立，并明确要求退出登录不因其他在租订单延后。实现沿用现有消费者：移除跨任务冲突、退出链路的商品授权暂停和在租查询，改用按操作分域的账号锁；订单终态后直接按正常异步消费节奏退出，不额外等下线或20分钟冷却。原冷却流程与其他业务的商品暂停/在租规则不变。

- 新增 `common/uuzuhao_operation_lock.js`：操作类型＋用户＋游戏＋账号摘要分锁，owner校验释放；不同操作可并行，同操作互斥。
- `order/auth_revoke_task_service.js`：移除商品授权暂停、在租查询和跨恢复任务检查；同类锁忙使用waiting_operation_lock。保留领取、合并、人工计数、近期成功复用及failed重试。旧waiting_authorization/waiting_reauthorization/waiting_active_order显示待执行，并自然续消费。
- `product/uuzuhao_reauthorize_service.js`、`database/uuzuhao_reauthorize_db.js`：删除跨退出任务冲突查询与共用锁；恢复自身资格、90秒/3次查询、创建未知人工和版本清标保持原样。
- `uuzuhao/uuzuhao_api.js`仅校正业务注释，接口路径、参数、签名和返回未改；更新PRD、测试及覆盖率命令。没有H5页面变更、表结构迁移或任务数据清洗。

## 环境与隔离

macOS本地，Node v24.13.0、npm 11.6.2，Asia/Shanghai。测试使用临时SQLite MAIN/RUNTIME/ORDER/STATS/PRICE库、fetch stub/fixture及仅允许localhost的HTTP保护，外部真实HTTP请求会导致套件失败。嵌套子进程继承隔离环境。没有调用生产接口，也没有改写生产配置或任务。

本地8080 H5已重启为隔离预览：使用业务库本地副本、单独Runtime库，关闭自动恢复/风控消费者并阻断外部HTTP；`GET /api/ping`返回200及`ok=true`。原业务库四文件校验一致，用户原LaunchAgent plist未修改；当前服务以一次性预览环境运行，后续按原plist重新加载时恢复原配置。预览副本位于 `/tmp/rent-authorization-implementation/local-preview/`，不是生产验证环境。

## 执行结果

|检查|结果|
|---|---|
|`npm run coverage:uuzuhao-reauthorize`|通过；6个顶层入口，含恢复、操作锁、API、在线授权与商品暂停嵌套回归|
|在线授权子套件|13/13通过|
|商品暂停子套件|12/12通过（在两个入口中重复执行，非24个独立测试）|
|`node test/run_order_game_info_refresh_tests.js`|25个隔离入口通过，覆盖资料刷新及共享订单链路|
|核心JS `node --check`、`git diff --check`|通过|
|独立只读代码复核|未发现需要修复的新增缺陷|
|本地H5 `/api/ping`|HTTP 200、ok=true；隔离预览|

未发现失败项。最终覆盖率是在所有实现及格式变更完成后重新生成的；未将前一版行号映射当作最终结果。

## 核心用例证据

- 正常：同账号恢复create挂起时退出接口仍发出；退出请求挂起时恢复接口仍发出。Promise屏障在两者均未返回时断言同时在途，使用真实API封装及SQLite锁，不只断言最终“都被调用”。
- 防重/边界：相同操作同账号重复领取不重复发送；锁owner错误不能释放；不同用户/游戏/账号隔离；同类锁繁忙延后、释放后原任务继续；前单终态且另一单仍在租时仍退出，不等待下线/冷却。
- 异常：退出接口失败不阻止恢复成功；创建恢复异常不影响退出成功；结果不互相完成或覆盖，退出成功不清平台授权异常；执行函数抛错后锁正确释放。
- 历史兼容：三类旧等待pending保留ID、触发与计数，自然推进；恢复queued复用、pending/running/failed退出任务不再阻断恢复；原manual_required保持原处理，不批量重试。
- 保留规则：failed下轮重试、并发合并新订单/人工请求、近期成功复用；恢复90秒间隔、3次上限、创建未知转人工、重启、新异常版本/商品快照保护；在线/禁玩/黑名单等原商品暂停继续有效。

## 覆盖率

范围为下列4个新增或实质修改的完整核心业务文件。要求为行覆盖率超过90%；同时如实报告分支和函数覆盖率。这不是全仓覆盖率，未排除难测核心行或降低门槛。

|文件|行|分支|函数|
|---|---:|---:|---:|
|common/uuzuhao_operation_lock.js|100.00%|100.00%|100.00%|
|database/uuzuhao_reauthorize_db.js|100.00%|92.00%|100.00%|
|product/uuzuhao_reauthorize_service.js|100.00%|95.23%|100.00%|
|order/auth_revoke_task_service.js|94.54%|51.07%|94.44%|

新增/变更可执行行覆盖率亦为100%。既有覆盖率命令额外验证未实质修改的API与授权状态UI完整文件分别为行97.41%、100%；未把未改H5胶水的“变更行100%”当作其完整文件覆盖率。

退出Service分支覆盖率仍为51.07%，函数94.44%；未实跑真实 `startAuthRevokeTaskWorker` 子进程派生，以及所有既有参数/容错分支。本轮不对真实平台或真实后台进程写操作做覆盖率采样，不能用行达标代替这些风险说明。

覆盖率HTML：`coverage/uuzuhao-reauthorize/index.html`；机器结果：`coverage/uuzuhao-reauthorize/scope-coverage.json` 与 `coverage-final.json`。这些为本地生成产物，通常不纳入Git提交。

## 未覆盖与发布限制

1. 未发布生产。此前观察到的18个排队恢复任务及对应退出任务未被手动修改，生产推进要在正式发布后只读验收；本地通过不等于这些账号已恢复。
2. 平台真实成功率、验证码、网络超时及先前的业务码500没有在线重试验证。退出的原失败重试策略保留，不能声称解耦会修好500或高重试次数。
3. 锁命名空间变化，发布时须通过项目唯一流程停止旧H5和退出Worker，避免新旧消费者混跑；不能用外部反向操作回滚已发生的退出/授权结果。
4. 工作区原 `database/rent_robot.db` 变更已保留，不属于本次实现；没有提交、覆盖或回滚它。生产发布仍需用户另行明确授权。

完整原始测试日志：`/tmp/rent-authorization-implementation/coverage-final.log`、`/tmp/rent-authorization-implementation/order-refresh-regression.log`。临时路径可能被系统清理；本报告保存稳定结论，覆盖率数值源于本次实际执行。

报告生成：2026-11-16T22:49:23.931125+08:00
