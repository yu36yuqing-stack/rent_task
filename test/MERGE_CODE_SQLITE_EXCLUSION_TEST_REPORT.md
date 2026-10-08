# 发布同步SQLite临时文件保护测试

日期：2026-10-08。

## 范围与原因

上次发布的第一步rsync退出码24，生产订单库WAL在扫描时消失。原脚本仅排除db文件及runtime前缀文件，未保护其他数据库的WAL/SHM/journal；`--delete`可能把接收端独有的临时文件当作多余文件。

本次仅给 `scripts/merge_code.sh` 的上传同步增加 `*.db-wal`、`*.db-shm`、`*.db-journal` 三个排除规则。数据库上传、Git排除、迁移、重启、代码对齐与数据库/日志回拉流程不变，没有改现有凭据或新增凭据。发布检查清单同步增加临时文件保护检查。

## 执行与结果

执行 `node test/merge_code_sqlite_exclusion_test.js`，退出码0。测试从实际脚本中提取排除参数，使用本机真实rsync在两个临时目录执行 `--delete`，不访问生产、不运行发布脚本。

- 主库、订单库、定价库、runtime库、统计库及嵌套自定义库：db/wal/shm/journal内容全部保持生产fixture不变。
- 接收端独有wal/shm/journal不删除，发送端独有wal/shm/journal不上传。
- coverage、log、敏感配置与runtime历史文件继续保护。
- 总计32个受保护文件内容不变；业务代码正常更新，接收端多余代码正常删除。
- `bash -n scripts/merge_code.sh`语法检查通过，`git diff --check`通过。

首次测试失败是fixture新旧代码长度及秒级mtime相同，触发rsync快速跳过。修正fixture让代码长度不同后完整重跑通过，没有因此改动rsync发布语义。

三个新增过滤规则均由发送端及接收端场景验证；Shell脚本未通过c8计算整文件覆盖率，不把该功能测试宣称为发布脚本90%代码覆盖率。原定价改动沿用此前完整回归与覆盖率通过结果，业务代码未发生新修改。

## 生产只读前置核验

生产系统sqlite3 CLI仍报部分WAL数据库无法打开；进一步使用项目Node.js的sqlite3驱动，以OPEN_READONLY执行quick_check，六个生产db均返回ok。该结果证明检查时数据库结构完整，不能据此证明上次同步期间没有丢失历史事务。

本次修复不手工删除、补写、恢复或迁移生产数据。发布仍由唯一入口 `scripts/merge_code.sh` 执行，最终提交、迁移、服务与同步状态以本次发布后的核验为准。
