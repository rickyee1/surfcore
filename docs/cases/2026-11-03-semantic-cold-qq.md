# QQ 首次语义检索：冷启动有界等待与取消

**独立验收结果：FAIL，未部署。** 反例F1在会话替换释放旧记录的await窗口紧停后仍提交新模型；F2认证耗时未扣掉ready原8秒总预算。见 `.local/evidence/semantic-host-attempt3/independent-review.md`。本单第3次额度耗尽，后续修补等待明确授权。下面是尝试实现与定向检查记录，不能覆盖独立失败。10个共享JS/测试文件已按hash备份并恢复9f，新测试移至 `.local/backups/unaccepted-semantic3-t1extra4-20261103-0217/`，没有重启服务；后续需在隔离修补树恢复完整补丁。

## 现象、根因与范围

基线 `9f456d24b3165773b805879a5d59912a1e6af1e2`：首次真实 QQ 私聊已入站，但八秒后语义准备超时，模型提示尚未投递，QQ 没有收到回复。之后同一 CPU 模型显式重建约 37 秒成功。原始证据在忽略提交的 `.local/evidence/full-integration/qq-chat-post-warm-status.json`，只引用路径，不复制账号或私聊正文。

语义服务本来允许 lazy CPU worker 在 120 秒内加载、计算；宿主却给所有检索统一八秒，外层桥接 HTTP 又固定十五秒。普通 QQ 错误路径只有日志。延长其中一层无法解决整条链。

本任务为 **semantic-host 原第 3 次、最后一次有界修补**，不另起计数。保留 strict、原角色/受众/来源/epoch 和原模型权限，不加入词法降级、自动重试或预热。T1 主动活动与发送守卫由另一执行者独立处理，不归本 case。

## 完整逻辑

1. **链路**：原生 QQ `api.sessions.prompt` 包装器 → `LocalChannelBridge.prepare/request` → 受认证 `channel.js` → `facade.refineContext` → `semantic-context.js` → 原 Python 语义 job。模型提示只在原准备成功、会话仍有效后提交。
2. **机制**：从原请求时钟计时，初次状态只选一次期限。`unloaded/loading/unavailable` 允许同一次原任务总计最多 120 秒；已就绪路径仍为八秒。状态、排队、加载、分页与校验共用原截止时间，失败不会再延长。Python 返回失败立即失败，不创建第二个 job、不刷新 epoch、不声称 recent 是语义成功。
3. **影响面**：一个隔离 DSH 与一个 QQ 桥接进程；新增的是有界等待和固定系统提示，没有平台账号配置、设备、原版 A01、固定模型或用户记忆正文修改。索引仍由既有 Python 服务维护；没有新数据库/常驻 worker/模型后台轮询。
4. **两条路线**：只预热成本低，但首次请求可能早于就绪，重启后仍可能漏答；显式词法降级需要新的数据使用策略，不符合本次 strict 契约。采用同任务冷预算加取消传播，改动覆盖实际十五秒外层限制，回滚可按窄 patch 恢复；代价是首次等待可能较长，因而必须向 QQ 显示进度。
5. **生效与重启**：源码在后续独立验收后由主会话正常部署、重启隔离 DSH 与 QQ 桥接。执行者未重启生产、未改生产配置，也未向真实 QQ 发消息；当前观察/A01 证据保持。
6. **验证**：下列测试经过实际 native prompt 包装器、真实 HTTP、隔离 SQLCipher 权威和真实 SDK 消息链到 loopback OneBot 接收器。语义 worker 时序/结果与 DSH 模型为明确标注的合成夹具；另有真实墙钟 16.05 秒等待证明外层十五秒限制解除。这些不冒充生产模型/账号端到端复测。
7. **回滚与交接**：备份 `.local/backups/semantic-host-attempt3/`，冻结包 `.local/evidence/semantic-host-attempt3/`。共享两 bridge 文件含并行 T1 贡献，必须只回滚本包 `semantic-only.diff` 的语义 hunk，不能整文件覆盖。部署后的冷启动实机复测交主会话；若本次独立验收仍发现阻塞，停止自动实现修补并报告，不重置次数。

## 有界协议与用户可见性

`context.refine` 仍是同一认证请求、同一 opaque context。可选 `stream:true` 只把响应变为 NDJSON：一条安全 `progress:{state:'loading',budget_ms:120000}`，随后原 `{ok,result}` 或结构化错误；不增权限、不提交新的检索任务。普通非流式调用保持 JSON。桥接设置最大 120 秒的外层 deadline 与 AbortSignal，覆盖认证等待、fetch 及响应正文；宿主也按请求起点裁定原截止时间，不能由客户端延长。

冷加载时 QQ 显示固定“正在准备本机记忆”提示；语义超时/失败且原权威仍有效时显示固定终态指引。提示不包含检索命中、用户原话、凭据或内部异常，不写记忆、不消费待答请求。它使用原上下文的独立被动通知 origin，经既有 QQ 接收人、角色、epoch、最终发送检查和 SDK 发送，不作为模型候选或主动意图。

请求断连、调用方 AbortSignal、native `stopSessionWork`、准备失效等会取消外层请求；宿主通过 `req.aborted/res.close` 将中止传给 refine，取消原 job。晚返回的 start ID 也只会被取消，不能进入模型。角色、权限变化仍拒绝旧内容；权威已经失效时不会为了通知而绕过守卫。没有用户可见“成功”来掩盖失败，也没有替换模型或回放原消息。

## 验证与证据

```powershell
node scripts/test-local-capabilities-semantic-host.mjs
node scripts/test-semantic-cold-native.mjs
node scripts/test-local-capabilities-semantic-role.mjs
node scripts/test-local-capabilities-channels.mjs
npm run test:regressions
npm run test:audit
```

- 冷启动原八秒反例先红；宿主/UI 21 项通过，包括冷 37 秒、原 120 秒跨分页期限、ready 八秒、失败不重试、原 epoch 不变和旧取消反例。
- native 链 11 项通过：cold 成功、真实 >15 秒 HTTP、120 秒终态通知、ready 八秒终态、停止/外部取消/认证 await、晚 start、角色/权限/全局失效、权限退役取消。被撤销支路模型调用与晚发送为零；通知只到 loopback。
- 管理角色预期 10、渠道 18、regressions 16 项通过；`test:audit` 108/108。
- 原始红日志、各定向日志、共享来源说明、窄/整合 diff 和哈希都保存在上述忽略提交的冻结包。

## 发布交接块

semantic-host attempt3，基线 `9f456d2`。只改语义准备、同请求安全进度与取消传播，保留 strict/来源/epoch/最终守卫；无提交、真实账号消息、生产配置、重启或 A01 操作。独立验收通过后由主会话集中部署复测。共享 bridge 同时包含 T1 attempt4 的独立修改，按冻结包归属核对，不能用整文件回滚互相覆盖。
