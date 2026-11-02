# 普通 QQ 活动与自主联系并发守卫（T1 attempt4）

**独立验收结果：FAIL，未部署。** 桥接进程重新连接后activity revision可重回1，原宿主仍持有的旧目的因此与新连接撞值；真实LocalChannelBridge隔离反例出现1次发送，应为0。见 `.local/evidence/t1-attempt4/independent-review.md`。用户只追加的这一次已耗尽，继续修补等待次数上限授权，不能把下面执行者的定向全绿当成接受。10个共享JS/测试文件已按hash备份并恢复9f，新测试移至 `.local/backups/unaccepted-semantic3-t1extra4-20261103-0217/`；未重启服务。后续须在隔离修补树恢复补丁，不直接重放到运行目录。

2026-11-03，Asia/Shanghai。基线 `9f456d24b3165773b805879a5d59912a1e6af1e2`，工作区 `D:\luyao_companion_v0_1\surfcore-luyao`。本次为用户明确追加的一次修补：`attempt=4, user_authorized_extra=1`；原三次不清零，失败不得自动开始第五次。只解决可信活动、foreground、发送代次和取消固定空闲等待，不包含原版目的机制多来源接线的扩展，也不是独立验收通过报告。

## 完整逻辑

1. **链路**：QQ 原生事件 → `src/bridge.js:handleIncoming` → `LocalChannelBridge.beginIncoming` → 原解析/可信入库/模型链。自主宿主 `autonomous-companion.js` 通过原 `/api/companion/readiness` 固定活动快照；签发的 `active()` 在 claim/validate/attention 路径持续复核。bridge `withIntent` 在 claim 前固定同一活动；`sendFetch` 的末次同步守卫紧邻实际 HTTP transport。
2. **机制**：旧 readiness 读取 `socialV2.lastIncomingAt/lastAiReplyAt`，普通 chat 不更新；旧 native 入站还先 await 解析和入库，`auto_write=false`、空正文及失败不会改变记忆 epoch，因此旧候选可能在有新消息后继续发送。本次在身份/白名单/deny/事件去重后、首个 await 前按机器人 account+owner peer 记录本机接收时间及单调 revision，立即撤销已有主动记录；finally 释放入站处理票据。单个当前绑定保存最多10000条事件标识，不保存正文，不引入无界 Map。
3. **爆炸半径**：一个 bridge 进程和一个插件宿主，影响普通 QQ 入站到主动主人私聊的准入。普通聊天原解析/入库/投递继续使用原链；原 quiet、focus、额度、60分钟浏览间隔和90分钟冷却保留。工具结果仍走原受控投递，并单独允许其所依附的 foreground；不能把主动候选混同工具结果。实际模型配置、媒体、A01、后端 authority、生产配置与发送许可均未改变。
4. **取舍**：仅补 chat 时间戳改动小，但无法处理解析等待、数据库失败及关闭自动写入，也不能消除 claim 后竞态。选择独立可信活动 revision+foreground 票据和末次同步检查，增加少量桥接状态与显式响应字段，能用真实 adapter 的反例直接验证；撤销代码即可回滚，不迁移用户数据。
5. **行为与生效**：自主协调器固定 `idleThresholdMs=0`，不再继承旧30分钟空闲门槛；有值得分享的新想法且上一段对话已结束即可联系。解析/入库处理中、未结束的普通模型回合、挂起问题或既有 busy 状态阻止主动联系。新入站即使正文为空、未入库或入库失败，也永久使原轮次失效，不在对话结束后恢复旧正文。只有平台明确成功回执更新活动 lastSent；failed/unknown 不伪装成功，unknown 仍不得重试。部署需由主会话正常重启 bridge 与隔离 DSH；本执行未重启、未部署、未触碰真实 QQ 发送或运行中的 A01/2h观察。
6. **验证**：`node scripts/test-companion-activity.mjs` 的22项走真实 `handleIncoming`、原 channel HTTP 和隔离 SQLCipher服务；仅公开资料、无工具模型和 OneBot transport 使用固定夹具。逐一注入解析/入库/生成/签发/claim/末次RPC窗口的空正文和非空文本，均 transport=0；覆盖 auto_write=false、入库失败、duplicate、跨账号、deny/allow、当前身份、foreground 与 confirmed/failed/unknown。普通原生对话处理中拒绝；显式结束后即刻允许，尽管旧 purpose 配置仍写30min。原 Companion32项继续覆盖TTL、source、binding、privacy、quiet/focus及unknown不重发；页面12项确认新行为说明。实测 audit 109/109（内含先冻结的native16项）、regressions16项、channels18项均通过；补充的6项非空文本窗口在最终native22项独立命令中通过，未改实现源码，无需重复全仓审计。详细命令与实际退出码见本次 evidence/checks.json 和日志。
7. **回滚与残余**：先正常停止自主任务，再恢复已冻结的 T1 窄 patch 前源码并由主会话重启两个读取进程；保留记忆库、配置、状态、ACL 与备份。本修补没有验证生产平台外发，不消耗夜间单条测试许可。原版“为什么找主人”的多来源、pending/goals/drives完整接线差距由主会话另行审查，不借本次调度修补宣称解决或重置T1次数。

## 失败可见性

`COMPANION_ACTIVITY_CHANGED` / `COMPANION_FOREGROUND` / `BINDING_INVALID` 等沿用自主陪伴卡现有错误展示，返回 code/error/hint。提示等待当前对话结束、核对身份或开始新轮；旧正文不会自动补发。原失败/未知回执仍显示失败或待核对。定向断言检查 code 与 hint，不新增外部通知。

## 证据与交接

证据目录 `.local/evidence/t1-attempt4/`。`attempt.json` 记用户追加授权和尝试次数；`checks.json` 记录命令及真实退出结果；`freeze.json` 固定源文件SHA256；`t1-only.patch` 是本执行的可应用完整差异，`combined-worktree.patch` 含并行语义任务的组合工作区，只用于核对集成而不冒领其作者。共享文件中 prompt通知/request取消/preparations/semanticNotice 属另一执行者，本次只持有活动、companion守卫、withIntent及确认回执记账hunk。

发布交接块：

```text
改动：bridge普通QQ可信活动、LocalChannelBridge主动代次/foreground/末次同步守卫、coordinator idle0与每阶段活动核查、Companion卡说明、原生22项及原32/UI12项回归、audit注册和case。
验证：以 .local/evidence/t1-attempt4/checks.json 与日志实际结果为准；不以本记录代替独立验收。
建议：patch；未改版本、未提交、未发布、未部署、未发送真实QQ。
接口：readiness兼容新增activity；内部withIntent新增可选syncGuard。无activity可信快照默认拒绝主动联系。
完整逻辑/爆炸半径/回滚：docs/cases/2026-11-03-companion-activity.md。
失败：卡片显示code/error/hint，提示等待当前对话结束或核对身份后发起新轮；failed/unknown不补发。
未验证：独立验收、生产部署与受控真实主动发送；原版完整目的接线不属于本次修补。
```
