# A01 分渠道模型控制与原生调用归因（修补第 2 次，待独立验收）

## Attempt2：独立 review 两项 FAIL 的集中修补

Attempt1 功能独立 FAIL：F1 的 async generator 包装没有透传消费者 throw/return，F2 的 prepared one-shot 拒绝覆盖旧成功记录。原 attempt1 补丁、freeze、日志和旧 A01 FAIL 均保留；attempt2 开始前的全部 12 文件字节保存在 `.local/evidence/a01-controls-attempt2/originals/`。

1. **链路**：只修 `a01-native-host.mjs` 的 observer iterator/attempt、`a01-contract.mjs` 的调用与尝试区分、相关纯内存回归；策略与产品 Writer 实现不变。
2. **机制**：直接代理底层 next/throw/return，把全部参数和正确 receiver 传回原方法，返回原同步 result 或 native Promise；异常保持原同步/异步边界。恢复性 throw、return 中的 done:false 和终态 return value 均保留，不给缺少 throw 的 iterator 增加方法，不擅自触发 return 清理。自定义 thenable 等到消费者读取 then 才调用。每次 prepared.stream 有独立记录；原函数成功返回后才标 dispatched=true，同步拒绝为 `recordType:attempt`，第二次尝试关联 preparedCallId，不能覆盖已成功调用。
3. **爆炸半径**：仅隔离 A01 harness 观测/证据结构；无 prompt、options、signal、模型参数、评分数学、30 场景或产品生命周期变更。contract 保留拒绝 attempt 为独立 blocker，实际 dispatched 调用仍全部验真。
4. **取舍**：采用协议方法代理与独立 attempt；继续使用 async generator 包装虽短，但会重建 result 并改变 throw/return 语义；只忽略二次拒绝会丢失败证据，均不采用。
5. **生效**：需新 runner/隔离宿主进程读取本 harness；没有重启真实服务。
6. **验证**：`test-a01-observer-protocol.mjs` 10 组纯内存回归覆盖全部 F1/F2，包括冻结的真实 async generator、Promise/result identity、显式借用 receiver、缺 throw、同步原始异常、延迟 iterator 错误、prepare 失败及成功记录深等值稳定；controls 11 组、self-check 18 项和 native smoke exit0。audit108/108、regressions16/16。日志位于 attempt2 目录；未变 Writer23/semantic-host18/role10/策略落库4 的 attempt1 证据复用，未冒称本次重跑。
7. **回滚与残余**：`attempt2-delta.patch` 可对 attempt1 源码应用；`full-applicable.patch` 可对 8f078a1 基线应用；新 freeze 与前后 hash 同目录。独立验收仍待 review，无真实模型/平台/设备/部署；原在线模型版本、usage、宿主作者轨迹的 unknown 保持。

```text
Attempt2 发布交接：仅 observer协议/attempt记录/contract证据分流及回归、case；建议patch，harness证据新增recordType/stage/preparedCallId，生产策略接口保持。
验证：audit108/108、regressions16、纯内存protocol10、controls11、self-check18、隔离native exit0；Writer23/host18/role10/策略落库4复用未变attempt1证据。
失败：首次/再次prepared同步拒绝为独立非dispatch attempt，保留native error；成功记录不变；延迟iterator失败仍是实际模型调用。既有code/error/hint路径保持。
制品：.local/evidence/a01-controls-attempt2/full-applicable.patch、attempt2-delta.patch、implementation-input.patch、freeze.json、before-hashes.json、after-hashes.json、originals/及日志。
未验证：独立acceptance/新真实120/盲评/在线provider版本与usage；没有部署、提交、版本bump、tag或push；历史FAIL保留。
```

## Attempt1 实施与原证据（保留）

任务 `/root/a01_controls`，基线 `8f078a125588b03de4e6c32fe582eaa1510f0496`。执行树为 `.local/worktrees/a01-controls-20261104`；本单元没有提交、部署、真实模型请求或平台/设备操作。历史 T6 attempt3、A01 原 FAIL、旧 120 次与评分不变。本文是实现交接，不代表独立 ACCEPTED 或新 A01 通过。

现象：旧 A01 40 项有标题/Writer 参数集合差异，另有无 usage 的早停调用无法可信归因。根因：宿主标题生成器独立调用、Writer 固定 3200/.2/off 与 45 秒总时限，Pet 原版硬 700，旧 observer 只记录 prepared 的准备参数，缺少最终 options 与可信生产者。

## 完整逻辑

1. **链路**：factory 在每个独有 trial 的 profile 启动前写 `session-title-llm.disabled=true`、`llm-deepseek.streamIdleTimeoutMs=60000/reasoningEffort=off`、Pet `.2/off` 及默认模型 off；原版 59ec3066 源码不改。独立 `agent/request` 中间件在 `await next()` 后应用 QQ 显式控制，原生 agent 自己 prepare/dispatch。候选 host 通过 `configureSemanticWriterModelPolicy` 注入现有 Writer，保留原 tokenBudget，不重建协调器。Writer 由可信 binding.platform 取 qq/pet 策略，真实 JSON 校验、提案提交和消费不变。消费者：harness 的 factory/host/contract；产品 Writer 由 `host.js` 构造，index.js 无变更。
2. **机制**：非秘密 policy 冻结 route、渠道、controls 和 SHA256；QQ 为 3200、Pet 为 700，两者 `.2/off`，期望真实 resolved context=1048576、adapter idle=60000、模型附加 total=null。策略由 queue 保存到 job，变更时撤销旧 job/队列，已有前台 lease 保留。Writer 对同一原生 prepared.config/context 验真，再通过该 prepared.stream 发原 options 对象；未知/不符不 dispatch、不提交。显式 null 才不安装额外 Writer 总 timer，生产默认仍 45000ms/3200/.2/off。预算、角色、前台、来源、撤权、关闭守卫保留。
   Observer 只读透传 options、receiver、configure callback、信号与 chunk，不改模型文本或工具；记录 requested、preparedConfig/context、resolvedConfig/context、finalStreamControls。Agent 来源为真实 `isAgentLoopRequest` 与 `agent/request` 的 session/turn/step；Writer 来源为同模块 WeakMap 的原 options→冻结 task/platform/hash；Pet 仅包实际 `.chat` 的 scope，Writer registry 优先。同步拒绝、无 usage 和取消也保留来源；标题若出现完整记录并拒绝新批次。contract 增加所有真实调用（含 history/startup 的已 dispatch 调用）的来源/控制/timeout 完整性检查，评分数学、30 场景、24/30 门槛没有变。
3. **爆炸半径**：新增控制只用于隔离 harness 与显式注入的候选 Writer；默认生产调用参数不变。生效涉及隔离 DSH 插件进程及 runner；不写真实 DSH_HOME、账号、凭据、端点或平台连接。原有 Writer 状态界面能看到 lastError 的 code/error/hint；平台未知、策略变化、context/config 不符与截断均有拒绝分支。harness 失败通过控制 HTTP 的结构化拒绝返回，原始失败不丢弃。
4. **取舍**：采用分渠道策略：收益是保留 QQ/Pet 原生流程和仍启用的 Writer，成本是一个冻结策略模块和可选 Writer 接口；风险是 Pet Writer 700 可能截断，按原校验拒绝，不减 episodes、不挑重试。备选全渠道 3200+有限总deadline需要改冻结原版 Pet 或宿主主循环，不满足此次边界；不采用 observer 偷改参数。回滚为撤去本单元独立补丁及新 profile，不触碰旧证据。
5. **生效与重启**：仅新隔离 profile/新进程读取；运行中的真实 DSH/桥接/桌宠未重启。现有 `sceneTimeoutMs` 实际控制每次 invoke/quietUntil 的外层等待，factory attestation 如实单记 `outer-per-input-wait` 与数值，不能称为整场 scene 或模型 total deadline。模型 timer 与 adapter idle 分别记录和验证。
6. **验证**：见下表与 `.local/evidence/a01-controls-attempt1`。native smoke 先清凭据环境、重定向全部 home、强制写入限独有目录，禁止 fetch/net/tls/http/https/dgram/http2 与子进程；只读已装 ASAR。真实 native compose 合并 base/web/产品/profile，Loader 加载实际模型/主 loop/标题依赖闭包及真实 DeepSeek adapter 配置，保留 session-title 服务、禁用生成器；没有加载完整 web/平台/设备树。策略注册在实际独立 plugin context，真实 native selector 尝试错 route 后，原生主 step 仍得到正确 request/header 和最终 stream；反例 middleware 顺序不对会拒绝。原版与候选实际 Pet `.chat` 都经过相同 native service，均 700/.2/resolved off。实际 DeepSeek `generate` 的 idleWatchdog 在虚拟 60000ms 抛 TIMEOUT；假 transport 不进行 auth/network。Writer 默认 45000ms 和显式 null 超过 90000ms 后仍可由前台/策略变更取消，分别用虚拟时间证明。
7. **回滚与残余**：完整适用补丁、原始文件字节、前后 SHA256、冻结输入与测试日志在 evidence 目录；只移除该补丁即可回滚。新真实 120 次、盲评、完整应用启动和在线 provider 实际模型版本/usage/费用未验证。精确 route 来自只读旧 seed 的 deepseek-official/deepseek-flash；旧 seed.reasoningEffort=max 原样保留，新 factory 要求新 seed=off，冻结模板单独交接。运行前必须准备新 seed 并让真实 ready 检查实际 resolved catalogue=1048576；未知不通过。旧 FAIL 不能由这些离线检查抵消。

| 检查 | 实际结果 | 日志 |
| --- | --- | --- |
| `npm run test:audit` | 108/108 | `audit-final.log` |
| `npm run test:regressions` | 16/16 | `regressions.log` |
| `node plugins/surfcore/scripts/test-semantic-writer.mjs` | 23/23；真实隔离 SQLCipher，模型为合成 | `semantic-writer.log` |
| `node scripts/test-local-capabilities-semantic-host.mjs` | 18/18 | `semantic-host.log` |
| `node scripts/test-local-capabilities-semantic-role.mjs` | 10/10；真实 wrapper/HTTP/SQLCipher | `semantic-role.log` |
| `node scripts/test-a01-model-controls.mjs` | 11 组；含虚拟 timer、透传和未知来源反例 | `model-controls.log` |
| `node scripts/test-a01-writer-policy.mjs` | 4 项；两渠道真实 JSON 提案落库/截断/context拒绝 | `writer-policy.log` |
| `node scripts/a01-self-check.mjs` | 18/18；fake CLI/隔离平台 recorder | `self-check-final.log` |
| 已装 Electron `scripts/test-a01-native-controls.cjs` | exit 0；外网尝试 0、子进程尝试 0、无凭据 | `native-controls-stdout.log`、`native-controls-stderr.log` |

第一次 audit 106/108 及 self-check 的环境红灯保留：独立 worktree 没有 config.json，CRLF 使 preset 逐字节比较与冻结 fixture SHA 不符。已备份后创建无秘密合成 config，仅在执行树做 LF 规范化；未改生成内容、fixture 事实或任何测试标准。这些环境字节不在实现补丁中。

native 命令（PowerShell）：

```powershell
$env:ELECTRON_RUN_AS_NODE='1'
Start-Process -FilePath 'D:/DSH/DeepSeek Harness.exe' -ArgumentList 'scripts/test-a01-native-controls.cjs' -WindowStyle Hidden -Wait
Remove-Item Env:ELECTRON_RUN_AS_NODE
```

功能实现的文件/补丁/执行日志可审；宿主逐编辑 native tool 作者轨迹、后端实际 provider/usage/费用不可读取，仍标 unknown，不能以角色名、文件哈希或此文本冒充。

## 可转发发布交接块

```text
范围：a01-dsh-factory/native-host/contract/model-policy/self-check 与对应三份回归脚本；产品仅 semantic-writer.js、host.js、新 model-call-registry.js；本 case。
结果：audit108/108、regressions16/16、Writer23/23、semantic-host18/18、semantic-role10/10、新控制11组、新策略落库4项、self-check18/18、隔离native exit0（零外网/零子进程）。建议 patch；可选接口向后兼容，默认生产参数保持。
完整逻辑/爆炸半径：docs/cases/2026-11-04-a01-model-controls.md 七步。
失败路径：模型/上下文/平台/策略不符、截断、缺来源或timeout证据拒绝；Writer状态和harness结构化响应带code/error/hint；有反例。
制品：.local/evidence/a01-controls-attempt1/full-applicable.patch、freeze.json、before-hashes.json、after-hashes.json、model-policy-freeze.json、originals/与各测试日志。
未验证：独立acceptance、新真实120/盲评、完整应用启动、在线实际模型version/usage/费用；需新off seed并预检真实catalog。旧A01 FAIL/T6历史保持。
没有提交/部署/版本bump/tag/push；发布会话仍需独立审核与自己的发布关卡。
```
