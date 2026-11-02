# T6-R：reserved2 连续 QQ 回合与安全代次交接

任务 `/root/tools_ui`，attempt1。工作区 `D:/luyao_companion_v0_1/surfcore-luyao`；修补基线为当前 T3-H 冻结版本（两个共享文件字节与 `.local/evidence/t3-host-attempt1/freeze-sha256.json` 匹配），覆盖前副本及逐文件散列在 `.local/evidence/t6-r/attempt1/baseline`、`baseline.json`。不回退 T3、语义或 T5 改动。

## 现象与根因

原真实 QQ 第二条消息延迟约356秒。已有安全诊断 `.local/evidence/qq-continuous-private-diagnosis.json` 确认：新入站已成功写入，旧长回合的 wait 因 memory_epoch 变化被成功响应末尾的 validateOrigin 拒绝；pendingWakeKey 却一直等待旧 turn/end。模型随后进入 mark_read 的沉睡前观察要求，直到错误保护终止旧回合才重开。私聊 trigger 直接为 private，并非唤醒概率问题。

修补前原生 loopback 红灯：auto_write=false 时新消息后旧 origin 仍有效；正常写入时旧 session/pendingWakeKey 不释放。另一个真实 SQLCipher 红灯表明两条同时入站会在 context→ingest 间相互推进全局 epoch，第二条收到 STALE_CONTEXT。红灯日志保留，未降低断言。

## 完整逻辑

1. **链路**：可信 OneBot 入站 → LocalChannelBridge 的短输入事务队列 → 原本机宿主 channel/SQLCipher → 成功入站后同步吊销旧 origin/token → 退役旧 DSH 工作与 Writer lease → 原 reserved2 合批/优先级唤醒 → 全新 qq-chat-v2 session → 原生 send/wait/分条/close。保留同一个 QQ 会话 key；切换的是模型 session/代次，不是 chat 模式。没有向已有模型历史追加提示。
2. **机制**：即使自动写入关闭、epoch 没变，同 subject 的旧 record 也立即撤销。只有尚未尝试发送的原请求 ID 会与新请求合并；新代次通过原 sources/validate/refine 再读取当前正文，纠错/删除仍生效。已发送、在途或 unknown 不重排旧候选；投递交接信息只带计数/unknown，无正文副本。明确 close/mark_read/wake_config 经当前 origin 校验成功后才清旧请求。没有有效来源的待处理唤醒不能变成主动发言。平台重复事件不再创建新 unread 或唤醒。
3. **影响面**：memory_epoch 是 character 全局值，跨受众新入站可能令其它旧回合失效；仅撤销旧 origin，并按它自己的未答 source ID 重查，绝不把新群消息搬进旧私聊。只串行 context→ingest 等短输入步骤，不串行模型或长 wait。每个 wait 和 pending wake 用对象身份做归属 CAS；旧响应/旧 turn/end/旧提示完成不能清新代次。旧 wait 轮询及时检查原令牌，旧分条 typing gap 以原发送 guard 可中断；正常间隔及模型选择的自然分条不变。
4. **取舍**：路线 A 在同一 DSH 长回合中更新上下文，必须新增可证明“只有可信 append、没有纠错/删除”的后端变更凭证；当前全局 epoch 无法证明，直接刷新会放宽旧输出。root 批准路线 B，复用既有 fresh-session 策略，当前输入到达即交接新的 reserved2 代次。恢复本地 prompt 的 reply 短静默、messages 等下文、自然 close 与潜水观察边界；不强制字数/分句，不关闭观察，也不放宽发送或工具权限。
5. **生效与失败**：部署需正常重启桥接。成功写入才交接；原输入存储/绑定失败保持 fail closed。发送最后一次异步校验后、deliver 前同步复核原 record 仍在当前 sessions 且 backend 仍 local；旧成功 RPC 不能复活已撤销代次。DSH stop/archive 使用既有正常接口，失败保留日志，旧令牌/映射仍已撤销，不能因停止失败改用备用发送。队列超过既有20个来源上限明确报错，不静默裁掉未答请求。
6. **验证**：专属 `node --test scripts/test-reserved2-continuity.mjs` 使用实际 bridge 函数、原 HTTP handler、真实 SQLCipher/本机 channel，模型和 QQ 仅为隔离记录器。覆盖 auto-off、三轮 native 分条/短等待/close、300秒 wait 被新入站及时打断、未答补充、sent/unknown 不重放、部分发送、旧 typing gap、旧 wait/prompt/turn-end CAS、跨 scope、纠错/删除、重复/角色/权限/backend撤销、异步 validate 晚回成功、并发入站。现有渠道18、wait12、T3 fixed-tool host29及桥接 audit/regression 继续复验；最终实际结果见 `checks.json` 与日志，不把夹具称为真实 QQ/模型验收。
7. **回滚与残余**：仅有界源码/专属测试/case 和最小 harness 元数据暴露（activeWaits/pendingWakeKeys/pendingWakeOwners）。完整 diff 与相对 T3 冻结的窄补丁、hash、红/绿日志在 `.local/evidence/t6-r/attempt1/`。T5 的12新文件、A01 harness/固定 fixture/original版本均未改。当前部署模式与凭据不改；真实 reserved2 平台连续回合/模型耗时由 root 后续验收。本次无 QQ/Bili、付费模型或设备调用，不改版本/tag/release/共享账本。

T3-H 独立审查另发现的晚 claim/prepare 生命周期竞态由 root 集中派发；本 T6 末端身份检查与该风险重叠，但不以此声称整个 T3 关键路径已验收。
