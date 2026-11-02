# 固定本机工具接入原桌宠与主人 QQ 私聊

任务：T3-H attempt1。基线：`cc74268`（Writer attempt2 已独立通过）。本单元不实现新聊天框架，不开放 DSH 任意工具，也不修改 Python 或实际安装的桌宠。

## 现象与根因

工具 Broker 和本机管理页已有精确审批、作用域许可和逐结果外发协议，但原桌宠/QQ 聊天还不能提出并继续这些请求。仅让网页调通后台，无法证明正文不会进入普通历史、模型 fallback 或旧回合发送。

另外，SnowLuma SDK 的 `websocket-client.js:165` 在真正 `socket.send` 前等待 `connect()`。调用 SDK 之前通过守卫，不能约束这段重连等待。工具紧停若只更新 Python policy，也无法同步取消宿主已经生成的普通回复。

## 完整逻辑

1. **链路**：原可信 pet/QQ 入站建立宿主 opaque turn。只有明确的固定工具请求才进入 `tool-host.js`；普通聊天不额外调用提案模型。`fixed-model.js` 通过宿主真实 `llm.prepareCall` 固定当前模型，由 Python 固定 catalog 校验提案和执行权限。需确认时立即返回管理入口，有限后台 continuation 只继续原 execution，不阻塞新的普通入站。
2. **机制**：正文默认只在本机。时间公开结果可答复原会话；文件/便签结果必须先登记固定模型及原私聊双跳目标，再在本机工具页逐结果核对正文、用途与过往不明交付。host 只消费一次许可，模型只接收原请求与本次批准结果，无 history/tools；生成后再次校验原 binding、epoch、模型配置、policy 和 TTL，才交原私域一次。`callBridge` 的真实 `{ok,status,data}` 包装由共享 helper 解读，不能把 HTTP envelope 当收据。
3. **影响面**：涉及宿主、桥接和已有桌宠 HTTP/event 三段；会使用现有模型额度，工具动作可能按具体批准创建便签或打开目录。模型不能选择身份、权限、账号、pin 或发送对象。宿主队列最多 8 个 pending，原 turn 默认 120 秒，逐结果许可仍是后端原定 60 秒；轮询只处理已登记请求，不空库打模型。结果与派生回答不进入 pet/DSH 历史、Writer、活动日志或默认 TTS。聊天问题本身仍按原记忆政策处理。
4. **取舍**：路线 A 把完整 DSH tools/agent 放进聊天，接线省事但权限、历史与 fallback 边界过大；路线 B 在原回合旁保留有限的审批 continuation，复用固定 Broker 与原发送器。采用 B；代价是多几个回合/交付守卫，收益是不会引入第二套人格、任意 shell/文件工具或新的跨平台出口。local SDK 发送改用既有受控 HTTP seam，legacy 继续原 SDK 行为。
5. **生效与重启**：宿主加载新模块，QQ 桥接加载新输入和发送 seam，故部署由主会话正常重启 DSH/桥接。重启先保持 host closed，读取持久紧停状态后才接收新回合；stop 同步升代、abort 并清掉旧事件/队列，随后持久 stop。ignored `LOCAL_ROOT/tool-host-state.json` 只保存版本和 closed 意图，无身份/正文；文件 fsync 后原子 rename，损坏、未知内容或读取失败均闭锁。reset 一直保留 closed，直到 Python reset/status 确认及最终持久 open 成功才同步开放；并发 stop 使旧 reset 失效。持久化故障要求修复存储并重启，不能在同进程 reset 伪装恢复；正常 dispose 不写 closed。reset 只允许新回合，不复活旧许可。实际 Surfpet 的两个消费端补丁见下节，尚未由实现者应用。
6. **验证**：使用临时 SQLCipher、合成锁屏观察、mock DSH `prepareCall` 与平台记录器。测试跑原 pet HTTP/event 及 bridge `handleIncoming`/内部 console/最终发送函数，没有调用真实模型、QQ 或用户文件。定向覆盖精确动作审批、许可复用但不等于 body 外发、双跳、未知消费不重放、配置/角色/新入站/TTL/撤权/紧停失效、普通生成与分条延迟等边界。实际模型和客户端由主会话验收。
7. **回滚与残余**：正常停止相关进程后，恢复本单元文件备份 `.local/backups/t3-host-attempt1/` 或经审查的基线实现，保留用户数据库、未知执行与收据。不要重放旧 execution/export，不要恢复宽权限，也不要删除工具结果来掩盖 unknown。实际安装客户端的备份/回滚由部署主会话负责。

## 用户入口与数据边界

在原文字聊天可明确询问“现在几点”、创建/列出/读取便签、读取/列出登记目录中的文件或打开登记目录。文件与具体便签 ID 必须由本次用户原话提供，不让模型猜测路径或标识。谈论过去、询问工具能力和明确否定动作不会触发工具提案；明确“只本机/不要复述”及本机打开目录停在 local_only，不准备正文外发。缺参数会要求补充，超长请求会结构化拒绝，不截半段执行。桌宠工具输入上限 1200 字符；QQ 本地入站上限 16000 字符。QQ 结果沿当前已验证的 chat 模式回原私聊；其它模式不 fallback，reserved2 长回合不因本单元宣称已修复。

本机工具页仍是 `/dsh-surfcore/local-capabilities/tools`。第一次动作可逐请求确认，也可保存受众/工具/目录/次数/期限一致的许可；这不授权结果进入模型或私聊。结果外发永远另行逐次确认。没有群、B站、陌生人发送，也没有新公开发布按钮。

`fixed-model.js` 目前只支持已核验的 `deepseek-official` 路由：从 `listConfigurableProviders` 找唯一 namespace，使用 `settings.describe({redactSecrets:true})` 的允许字段、配置 revision 和 launch environment 的单个 baseURL 项计算非秘密摘要。没有读取/哈希 API key。按实际适配器归一化 `/v1/messages` 地址；监听 loader/settings/adapter/credential 变化立即取消旧目标。不支持的配置明确报错，不换 provider，不重选模型或重试。

只接受正常 `finish.reason.kind === 'stop'`；截断、工具 finish、无 finish、结束后又输出、超长或超时不交付。原有 `other` 预算在模型正文出站前核验，等待预算后还核原 epoch/turn；不刷新 epoch。状态 `status.toolHost` 只含 `closed/policyVerified/generation/pending/lastError/jobs` 元数据，错误始终有 `code/error/hint`。

同渠道新消息即使关闭自动记忆，也使旧工具/生成回合失效。为保留正常 burst，`sources.validate` 只核已登记且后端明确 `stored:false,skipped:true` 的原 opaque context：核原角色、绑定、epoch 和全局 stop 代次，允许随后同渠道输入序号变化。它只返回 boolean，不能用于发送/模型或一般 context；删除、切角、紧停仍拒绝。正常发送继续完整代次复核。

内部 channel 只新增受认证桥接可用的 `tool.handle`、`tool.delivery.claim/finish` 和上述来源核查。宿主通过 `/api/tools/deliver` 只交一次 opaque deliveryId；桥接拒绝 Origin、agent header、任意正文/目标。claim 单次消费；账号/好友等待结束后再查原许可并立即进入受控 HTTP。平台明确拒绝是 failed，丢回执/无法确定则 unknown，不换渠道、不重试。`/api/tools/invalidate` 只取消队列和旧会话，不发送内容。

本单元依赖 S1 的窄协议扩展：`tool.propose` 返回 `duplicate`；`tool.history` 可按 `idempotency_key` 精确查询同角色和原 resolved subject 的元数据。宿主用可信角色/原渠道/event 的稳定哈希先查旧记录：已有记录 quiet duplicate，零提案模型、零结果模型、零通知；查询到 propose 之间的竞争由服务原幂等键和 duplicate 标记再挡。并发双方在旧记录尚不存在时可能各做一次有限提案，但只产生一个执行/私聊效果，不把它冒充全局零模型费用。该扩展不新增正文、身份或跨 scope 读取；Python 实现归 S1，冻结证据 `.local/evidence/t3h-duplicate/attempt1/`（full.diff SHA256 `3da8e2e37bf59bed0952cadd27f71b1cc6f01ce04a5c87729ff299f676fc6408`），42 服务工具检查通过。旧方案重建后会多调一次提案模型的反例保存在 `t3-host-replay-before-filter.log`，不是用新同意重新执行旧事件。

## Surfpet 实际消费端部署待办（NOT_VERIFIED）

只读检查的代码：`.local/apps/surfpet/v0.2.3-prep-1a4cdf9b/dist/main.js`，SHA256：
`aeaa73450400753f411416734141c07da74515df20cf93ad6c218ba94b5fdad2`。

`remember`（540 行）把消息加入内存 `messages`；`historyPayload`（623 行）在离线时把该数组当历史返回。没有发现聊天 userdata 写入、dialog/bubble localStorage 或自行合成 TTS；`onEvent`（562 行）会丢弃 reply metadata 并默认 remember。插件排除历史不等于这个消费端已满足同一约束。

主会话部署前须备份安装目录，核对哈希后幂等应用两个精确补丁；实现者没有改安装目录：

```js
// 在 remember(message) 的既有 if (!message?.id) 前新增：
if (message?.memory_write === false || message?.suppressHistory === true) return message;

// 在 onEvent 的 reply 构造对象（audio: event.audio 附近）保留：
memory_write: event.memory_write,
suppressHistory: event.suppressHistory,
suppressTts: event.suppressTts,
```

插件已在工具 reply 事件与同步状态 reply 上提供上述标记，且不附 audio。补丁后仍须实测当前显示可见、重新打开历史/离线历史不含工具正文及派生回答。真实 Surfpet/DeepSeek/QQ、Windows 锁屏/Explorer 和未知网络状态均不能由本次 fixture 宣称通过。

## 验证与交接

证据均在 ignored `.local/evidence/`，不含用户账号、凭据或用户文件正文：

| 命令 | 已执行结果 | 日志 |
| --- | --- | --- |
| `node plugins/surfcore/scripts/test-tool-host.mjs` | 29 组定向检查 | `t3-host-attempt1-module.log` |
| `node plugins/surfcore/scripts/test-semantic-writer.mjs` | 23 组通过 | `t3-host-writer-regression.log` |
| `node scripts/test-local-capabilities-channels.mjs` | 18 组通过 | `t3-host-final-channel.log` |
| `node scripts/test-local-capabilities-integration-pet.mjs` | 16 组通过 | `t3-host-final-pet.log` |
| `node plugins/surfcore/scripts/test-autonomous-companion.mjs` | 32 组通过 | `t3-host-companion-regression.log` |
| `npm --prefix plugins/surfcore test` | 退出码 0，已注册并包含本单元 29 组 | `t3-host-final-plugin.log` |
| `npm run test:regressions` | 16 组通过 | `t3-host-regressions.log` |
| `npm run test:audit` | 106/108，失败见下 | `t3-host-audit.log` |

全审计失败是 `test-release-manifest` 的清单/HEAD blob 不一致，以及 `test-voice-pack-import` 在“pyvenv 缺失”用例读取旧 `config.toml` 时 ENOENT；已交主会话协调，没有修改版本、清单或语音实现掩盖失败。最终冻结包保留本轮实际结果，不称全审计已通过。

来源：冻结任务包 `t3-host-task.md`、独立源码契约复核 `t3-host-contract-review.md`、`services/local-capabilities/T3_API.md`。JS 固定模型/continuation 和本单元接线为新实现；Python Broker/精确 export 协议、管理 UI、语义 context 为其他执行者已交付或并行交付，完整共享文件 diff 明确注明归属。本单元不覆盖 Writer 已验收主体。

```text
发布交接：T3-H attempt1，基线cc74268，无版本/提交/部署操作。
新增：fixed-model.js、tool-host.js、专属native/SQLCipher测试；原pet/主人QQ固定工具与全局代次接线。
约束：无任意DSH工具；原私域固定双跳；memory_write=false；未知不重放；stop/reset不复活旧回合。
检查：定向29、Writer23、channel18、pet16、Companion32、regressions16、完整plugin通过；audit106/108有已报告非本单元失败。
部署待办：主会话备份并应用Surfpet两处metadata/history补丁，再正常重启DSH、桥接和自有pet，核验真实模型/主人私聊及客户端历史排除。
回滚：停止相关进程，恢复本单元备份，保留所有用户库、执行和未知收据；不得重放旧任务。
```

## T3-H attempt2：固定端点环境快照修复

独立联合验收 F3 发现：已有 launchEnvironment 快照缺少端点变量时，宿主错误读取 ambient process.env，批准摘要可能不等于实际 SDK 路由。已按本机 SDK launchEnvironmentOf64–67 和 DeepSeek resolver441 对齐：只有整个快照不存在才继承 process 环境；变量缺失回官方默认，空字符串/字面 undefined 仍明确失败，不读凭据。两条路线中选择直接修正优先级；另造配置或刷新审批会扩大路由风险且无法修复原批准对象。

先红 `test-fixed-model-environment.mjs` 在 empty snapshot 的实际适配器目标摘要断言失败；修后9个环境矩阵通过，原工具宿主29项通过。证据 `.local/evidence/t3-host-attempt2-environment-{before,after}.log`、`t3-host-attempt2-module.log`。没有部署或调用真实模型；主会话负责联合 F1/F2 修复及最终验收。此修补仅涉及 fixed-model.js、专属测试和本段；T4 新文件不属于此补丁。

发布交接：T3-H attempt2/F3，启动DSH插件后生效；保留旧freeze和先红证据。回滚恢复fixed-model单文件备份只用于调查，不可带已知摘要错配版本恢复工具外发。联合验收尚未通过前不宣称完整T3通过。


## T3-H attempt2 F1 — 共享 QQ 桥接生命周期修补

作者 `/root/tools_ui`，按 root 集中包 `.local/evidence/full-integration/joint-review-attempt1.md` F1 修补。以 T6-R attempt1 冻结的 `src/local-capabilities-bridge.js` SHA256 `ea0ae5a3eb4669ab18967effbeecf72e9b44a77535b1b507b5106e8c2cb538e6` 为基线；T6 原快照/manifest 不覆盖。本节不更改上文原作者实现与 F3 归属。

1. **链路与红灯**：实际 bridgeHarness.sendToQQ → 本机 HTTP 记录器，在冻结 T3 上阻塞 ordinary 最后 validate、tool 第二次 validate、companion 最后 attention.check，真实 invalidate/retire 后释放旧成功响应，三条均得到 sessions=0、sends=1。红灯日志 `frozen-t3-send-red.log`；T6 的末端同步原 record 检查已覆盖这三条，不重复实现。T6 基线仍可在迟到 claim/prepare 后重新登记旧 scope，另有 `frozen-t6-red.log`。
2. **机制**：进程内单调 generation 在 invalidate 开始即递增，标记已有 record 撤销并清理 cached channel。prepare、claim、tool ack 和排队输入捕获开始时的 generation/原 channel；最后异步步骤后、登记或交出正文前核验，不能将当前代次赋给旧响应。record 的发送末端再同步检查原对象身份和原 generation。
3. **范围**：只改 shared local-capabilities-bridge.js、新 F1 专属测试及本节。未改 bridge.js、T6 专属测试/harness、Python/T5、semantic 或 fixed-model/F3。重复旧平台事件不能在 reset 后恢复清空的 identity；只有新的可信入站重新建立渠道。
4. **取舍**：拒绝旧回调并保留原核验上下文，不刷新旧 epoch、不重新 claim 或重放请求。清理使用对象归属 CAS，旧 finally 不能删除其它新记录。已 claim 但未调用 transport 的取消用原 claim context 结算 failed；已经尝试的未知投递保持 unknown。metadata 结算可以使用捕获的旧 context，不重新开放正文/发送权限。
5. **生效与失败**：正常重启桥接加载。失败返回现有结构化错误及 hint，Native claim ID 保持一次性消费；无法确认的网络结果不走备用路径。generation 是进程内生命周期边界，无 schema/授权迁移，旧异步回调不能跨进程存活。
6. **验证**：`node --test scripts/test-local-capabilities-bridge-lifecycle.mjs` 11项通过，实际 SQLCipher/channel、真实 host issue/claim/finish、真实 bridge sendToQQ/HTTP 计数，只有 DSH/QQ 是隔离记录器。覆盖三条晚成功 RPC 的零 bytes、迟到 tool/companion claim、reset 后相同 revision 的迟到 prepare、新旧 account scope、排队 turn.begin、旧重复事件及真实 failed/unknown 不重放。T6 17项、渠道18项、固定工具宿主29项、Companion32项、pet16项回归通过；最终检查/哈希记录在 `.local/evidence/t3-h-f1/attempt2/checks.json` 和 `manifest.json`。
7. **回滚与残余**：覆盖前副本与 T6 SHA 在 `baseline/`、`baseline.json`；本单 full/narrow diff 分列保存，不覆盖 T6 freeze。不替换用户库/凭据，不调用真实 QQ/模型/设备，不改版本/tag/release。独立验收和真实部署仍由 root 完成；全量 release-manifest 在根整合阶段统一校验，本单不据既有清单失败修改打包资料。
