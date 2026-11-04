# A01 普通提醒重建时接续未答来源

实现工作区为 `.local/worktrees/channel-resume-20261103`，任务 `/root/channel_resume_v2`。本单元接在 semantic-host attempt5 的冻结实现之后，独立补丁与证据放在 `.local/evidence/a01-pending-inputs`。旧 A01 120 次、两项漏答及参数阻塞记录全部保留。本地确定性检查不能替代新冻结版本的完整 A01 实测。

## 1. 链路

QQ 可信入站经过 `src/bridge.js` 的 `handleIncoming`，交给 `LocalChannelBridge.incoming` 登记来源。`ensureSession` 建立下一代 DSH 会话，`prepare` 从已鉴权宿主的 `sources` 与 `validate` 获取当前文本，模型通过原 token 和 private/group 工具 key 发送。宿主仍由 `plugins/surfcore/lib/local-capabilities/channel.js` 持有原生上下文和 Writer 租约。

本单元改动 `src/local-capabilities-bridge.js`、必要的 `src/bridge.js` 生命周期及 close 接缝。新测试为 `scripts/test-a01-pending-inputs.mjs`，并登记到 `scripts/test-audit.mjs`。关联测试 `scripts/test-reserved2-continuity.mjs` 补合成机器人身份及真实晚安入站，保留合法自然收尾的正向契约。

## 2. 机制

旧诊断中的首发失败分别涉及 wrong bridge key 和误抄 token。工具 key 需要 `private:` 或 `group:`，原 prompt 只展示 `qq-private` 或 `qq-group` 受众，容易混用。prompt 现在分别展示工具会话 key、受众类型和受众标识。凭据仍逐字核验。

prepare 将排队来源转交给 record 持有。普通提醒触发 `ensureSession` 退役时，旧实现没有把未答来源交回队列，下一代成为 proactive，随后被关闭的主动联系开关拒绝。普通 mark-read/wake-config 的成功响应也曾清空 record.inputs。

新契约区分三种终结事实。

- 有可靠发送回执后，结清当前 record 已展示输入。部分成功、已经尝试但未知或失败的传输均禁止重放。
- 本次原生 close 经身份、原上下文、`planClose`、`closeGate` 和安全水位检查，产生新的 `closedAt` 后，可结清该 record。`blocked`、`ALREADY_CLOSED`、无动作响应以及失败不能确认输入。当前来源按原顺序投影给既有收尾判据，真实未答“给我几个名字”仍被拒绝，真实“晚安，不聊了”可以结束。
- 用户显式 stop 或外层 abort 取消该代次已持有的输入。它不会清除后来新入站或另一代次的输入。

普通已读、唤醒配置和准备成功均不能表示已答。只有 `TURN_REBUILD` 的正常 reserved2 重建可以接续。会话仍须属于当前角色、bridge 代次和原 kind/account/peer/principal。接续排除 transportAttempted、uncertain、inFlight、intent、toolDelivery 和已取消来源，按 source event ID 去重。下一代再次读取 native sources 和 validate。删除来源失败关闭，纠正来源使用新文本。auto_write=false 的 neverPersisted 输入必须通过原 source context 核验，原生代次变化后不能使用缓存正文。

内部退休调用已捕获的原 stop 方法，避免把普通重建再解释为用户显式停止。旧回调仍受原代次守卫约束。

## 3. 爆炸半径

主要行为在桥接 Node 进程，涉及输入准备、发送确认和合法收尾三个读者。保守估计为 1 × 3 × 3。宿主原生来源校验保持原权限。测试使用合成身份、临时 SQLCipher 数据目录、合成 DSH 与 loopback 发送记录器。真实配置、账号数据、Python 和模型协议均未修改。

## 4. 取舍

方案一仅增强 prompt，代码成本低，可减轻错误 key，但无法恢复提醒前已遗失的未答来源。

方案二在原 record/queue 间交接来源 ID，再由原生来源核验当前文本。它覆盖已复现的恢复失败，增加少量生命周期规则，主要风险是重复投递和误复活，使用传输标记、明确取消原因及原生终结事实约束。采用方案二并同时分离 prompt 中的 key 与受众类型。回滚使用本单元独立补丁，保留前置租约单元。

## 5. 生效与重启

bridge 源码由桥接 Node 进程加载。未来部署须与前置请求级取消协议配套，并在已批准的发布流程中重启相应 bridge/plugin 进程。本轮只有隔离测试子进程，生产服务尚未部署或重启。

## 6. 验证

- `node --test --test-timeout=60000 scripts/test-a01-pending-inputs.mjs scripts/test-reserved2-continuity.mjs scripts/test-local-capabilities-bridge-lifecycle.mjs`，65 项通过。覆盖 wrong key、误抄 token、普通提醒、原生 close/已读/唤醒配置区别、删除、纠正、角色、受众、账号、显式 stop、外层 abort、新入站及准备并发。
- `npm.cmd run test:audit` 和 `npm.cmd run test:regressions` 的最终结果在同目录 `verification.json`，日志包含前置运行及收尾契约明确后的一次最终全量运行。
- semantic-host 原始三项泄漏反例、原 releaseRecord 微任务取消和八秒期限检查保存在前置单元。T1 bridge-instance epoch 追加反例继续参加 audit。

初次继承的测试夹具缺少合成 self identity，先在入站门失败，保留 `red-pending.log`。修正夹具后 `red-pending-identity-fixed.log` 复现 acknowledgement 丢失来源，`red-rebuild.log` 复现下一代错误成为 proactive。所有 red、diagnostic 和后继日志保留。

## 7. 回滚与残余

`repair-only.patch` 从前置 semantic snapshot 到本单元最终源码，可独立审阅。`full-from-8f.patch` 是完整候选版本，`freeze.json`、`seal.json` 和 `patch-reconstruction.json` 记录文件及证据哈希与机械重建结果。适用基线为 `8f078a125588b03de4e6c32fe582eaa1510f0496`，不要直接覆盖其他工作树改动。

真实 A01 重跑、真实 QQ/B站/模型/设备、生产部署和独立验收仍待完成。该单元保留主动联系关闭，未自动修正任何 token。

## 发布交接块

```text
任务 /root/channel_resume_v2，A01未答来源接续独立单元
基线 8f078a125588b03de4e6c32fe582eaa1510f0496，前置 semantic-host attempt5
实现与证据 .local/worktrees/channel-resume-20261103/.local/evidence/a01-pending-inputs
补丁 repair-only.patch、full-from-8f.patch，文件版本见 freeze.json
测试 verification.json、regression-final.log、audit-final-v2.log、regressions-final.log
case docs/cases/2026-11-04-channel-pending-inputs.md
失败表现 SOURCE_UNAVAILABLE/REQUEST_CANCELLED/原鉴权错误及close的code/error/hint
生效 bridge/plugin配套加载，本轮尚未部署或重启生产服务
回滚 逆向本单元patch并保留前置租约修复，须先核对目标哈希
未验 真实A01完整批次、外部平台/模型/设备、长期运行与独立验收
交付状态 READY_FOR_REVIEW，发布版本由发布会话决定
```
