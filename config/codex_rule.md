# Codex Rule

## Rule 1 - Database Table Standard

后续按照阿里和字节的规范执行数据库建表。每次新建表，必须包含必要公共字段，至少包括：

- `id`：主键
- `modify_date`：修改时间
- `is_deleted`：逻辑删除标记
- `desc`：备注/说明

如无特殊说明，后续所有数据库表设计默认遵循本规则。

