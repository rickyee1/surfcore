# 稳定事件的工具提案重放标记

2026-11-02，`/root/capability_service`，root批准的T3-H S1兼容接缝，独立于T4。

1. 链路：可信host用稳定event hash调用tool.propose，Python按原role/subject/tool/key
   查询持久执行。原返回无法区分新请求与重启后命中的旧succeeded请求。
2. 机制：旧执行的execute本来不重放，但host可能把旧提案当新turn继续模型/发送。
3. 影响：返回duplicate布尔，并给既有history增加精确idempotency_key过滤；不变主体、
   异参冲突和执行事务。无filter时旧history兼容；filter不含arguments/result正文。
4. 取舍：重建新幂等表或host猜状态都多余；复用现有查重分支：新建false，旧同参true。
   host提案模型前先查当前role+resolved subject的精确key，limit1命中即quiet结束，
   无新模型/外发；并发查询的竞态仍由propose duplicate兜底。管理身份也不能扩大筛选。
5. 生效：重启能力服务加载，T3_API.md说明host遇duplicate不得新发模型/消息；无DB迁移。
6. 验证：tools测试新/旧标记、同subject服务重启重新binding、auto_write=false；旧执行ID
   与行数保持，原幂等/隔离测试保留；另测跨subject/角色为空、错key为空、时间结果
   不读取body、同subject重绑与重启可见。日志 `.local/evidence/t3h-duplicate/attempt1/`；
   原duplicate-only冻结保留在intermediate-duplicate-only，最终包覆盖整个S1接缝。
7. 回滚：恢复该目录记录的窄补丁或
   `.local/backups/t3h-duplicate-attempt1-bc8c7b7cae2d4b83914f92026613f371`；不回滚DB。

发布交接：本单只兼容字段+断言，不是媒体或T5业务；host接线由channel负责。
错误仍沿既有code/error/hint；没有外部发送、用户数据、版本或git写操作。
