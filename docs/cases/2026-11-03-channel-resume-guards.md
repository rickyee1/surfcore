# 渠道原请求取消、原预算与 bridge 实例活动代次

## 现象

semantic-host attempt3 的两个独立反例仍在停止后提交一次模型请求、认证等待约9秒后启动ready查询；T1 attempt4在仅重启桥接并接收主人新消息后，因为revision仍为1而发送旧意图。三项历史FAIL保留，本轮分别为semantic-host attempt4、T1 activity attempt5；用户已明确豁免本任务修补次数上限。本文是实现交接，独立验收尚未进行。

## 环境与范围

- 隔离树：`D:/luyao_companion_v0_1/surfcore-luyao/.local/worktrees/channel-resume-20261103`，分支`repair/channel-resume-20261103`，基线`8f078a125588b03de4e6c32fe582eaa1510f0496`。
- 从`.local/backups/unaccepted-semantic3-t1extra4-20261103-0217`恢复10个跟踪文件和2个新增测试；逐字节SHA256匹配，10个跟踪文件的9f/8f Git blob一致。归档内容来自前轮执行者，不归属本轮原创。
- Windows / Node v24.16.0；只读复用依赖junction。仅临时SQLCipher、合成模型与loopback HTTP。实际服务仍为9f，不重启、不部署、不commit/push。
- 本轮源码仅涉及bridge、local-capabilities bridge/channel/semantic-context、companion；保留原client的取消idle说明与原测试接线。不改Python/P1、purpose纯引擎、模型账户配置、部署脚本或A01。主控追加授权仅修复`test-local-capabilities-bridge-lifecycle.mjs`的正向夹具，并以原Git LF预设字节及无账号模型的合成config补齐隔离audit环境。
- 证据根：`.local/evidence/channel-resume-attempt4-5`。`failed-base/`保存恢复后的失败基底；`red-*.log`为本轮复现，`green-*.log`是相同独立脚本的首次修复重跑。所有中间失败保留。

## 根因

`prepare()`在refine后检查取消，但`releaseRecord(old)`的await之后只检查角色/入站版本；原模型提交旁也无原准备取消检查。新record能绕过已经发生的停止。另一个收尾窗口中writerReleased标志早于HTTP结算，第二个释放调用不能等待前一个完成。

桥接对所有refine先等120秒，宿主收到HTTP后才开始8秒计时。认证和传输时间不计入原ready预算。

活动版本只含account/peer/revision。新bridge的计数从0开始，首次入站重新得到1；auto_write=false和空正文都不能依靠数据库epoch来防止这种碰撞。旧测试覆盖同实例活动变化，未覆盖仅桥接重启。

## 完整逻辑（七步）

1. **链路**：真实QQ adapter在可信入站首await前调用`beginIncoming`；普通prompt经`prepare → authenticated channel HTTP → refineSemanticContext → originalSessionPrompt`。主动路径为`coordinator.ready → issueIntent(active闭包) → bridge.withIntent → attention/validate → assertRecord → transport`。`rg`核对读者包括原生prompt/stop wrapper、事件回调发送、主动readiness和最终send guard、semantic host/UI测试；Python只提供原有绑定/lease/epoch权威。
2. **机制**：prepare的原combined signal和inputRevision保存在record的检查闭包中，停止也能取消已完成prepare但尚未提交的record；每个后续await后、登记之前及originalSessionPrompt紧邻处都检查。释放同一writer复用同一个Promise，不能重新建立lease；同sid并发prepare被拒绝，旧catch只能清理其原对象，不能覆盖或删除另一准备的取消句柄。桥接最初request产生ready/cold两个绝对期限，默认timer为8秒；同一认证HTTP响应首次可信cold进度才选择原起点120秒，迟到进度不能复活已超时请求。宿主只向更早期限收紧，validate、首次状态、队列、分页均不换起点。每个bridge构造生成不持久化的随机epoch；宿主首次ready保存epoch+account+peer+revision，active闭包永久保留，bridge的withIntent则保留claim前自身快照直到最后同步检查。两侧均不得刷新旧快照来批准旧正文。
3. **爆炸半径**：修改发生在桥接/插件宿主两个进程，覆盖普通提示、主动投递、语义准备三个消费者；按静默风险权重估算`2×3×3=18`。取消错误原可导致多余模型开销或旧正文发送，因此模型提交及实际transport均以零次计数验证。实现不改用户数据结构、密钥或额度配置；测试只使用随机临时库。
4. **取舍**：方案A保留原信号/原期限/原活动快照，增加实例nonce与共享release Promise，收益是直接堵住已复现窗口，变更和回滚范围小。方案B引入新调度/持久代次或重做intent协议，可统一框架但涉及更多生产接口、迁移和测试，成本与回滚风险高。本轮选A；真实coordinator原active闭包的证明足够，不改变通用`issueIntent(active)`语义。
5. **生效与重启**：未来授权部署时桥接和插件宿主须配套更新并正常重启，UI描述刷新即可。旧宿主活动响应缺epoch时新coordinator拒绝旧轮；混装版本不能作为本轮预算与代次契约的验收版本。本轮没有操作实际服务，也没有消费真实主动消息许可。
6. **验证**：先在失败基底上复现三个独立反例，再跑相同脚本变绿。正式native测试覆盖真实ensureSession退役/后继、已writerReleased的微任务窗口、仍在途turn.end、未释放writer、prepare返回后的最终提交、外层abort、9秒真实认证等待、原HTTP起点及16.05秒真实冷启动HTTP。断言零新可发送record、零新prompt、writer foreground回到0且不复活；NDJSON同一次refine响应含progress和terminal。companion覆盖空/非空且auto_write=false的新实例rev1、claim返回/末次validate/最后RPC响应窗口、旧adapter显式invalidate及新轮合法发送；quiet/focus/额度/90分钟冷却与foreground原守卫保留，idleThresholdMs仍为0。空文本直接入库的既有INVALID_REQUEST被夹具明确核对，其可信活动仍会推进；真实adapter空输入另由activity测试覆盖。
7. **回滚与残余**：未提交阶段可从冻结完整patch恢复到8f；审阅本轮原创只看`repair-only.patch`，原待审叠层另由归档保留。不要在运行目录覆盖撤销用户变更。本轮不宣称生产冷启动、真实QQ/B站/模型/设备、长期观察、原purpose补全、A01或独立验收通过。没有清零旧失败和历史分母。

## 修法与失败可见性

新增取消守卫失败返回`REQUEST_CANCELLED`，超时为`SEMANTIC_CONTEXT_TIMEOUT`，活动失效为`COMPANION_ACTIVITY_CHANGED`，保留非空hint。语义加载/失败经原固定系统通知发送，不混入私域检索正文；失败不自动retry、fallback或预热。自主错误由原状态页暴露，提示等待当前对话结束后形成新想法，不补发旧候选。

## 验证结果

实际结果：native 20、companion 37、semantic host/UI 23、真实活动22、companion UI12、Writer23、channel18、生命周期11、semantic role10、native role11以及regressions16均通过。`npm.cmd run test:audit`原始为107/109（exit1）；两个环境失败分别是缺config和预设CRLF差异，经授权补齐隔离环境后仅重跑失败两项：stickers71项、preset契约均exit0。不是声称重新跑出一次109/109的全套日志。

全部命令、exit code及日志见证据根`commands.log`与`verification.json`。日志包含早期证据生成脚本的manifest/编码设置错误（非产品反例），以及新增writer结算断言暴露的释放等待问题、空入库夹具误期望，未删除或将其计为通过。旧生命周期测试在缺可信活动、未结束前台时等待claim而悬挂，明确终止隔离测试及直属临时Python；保留原部分日志。正向夹具改为真实beginIncoming/finish并在issue之前endSession，原安全断言未改。`environment-adjustments.json`保存两preset字节转换与新建忽略config的前后hash，均不是产品源码变更。

## 遗留与发布交接块

仅供独立评审，不批准发布。主状态文档、case索引、ROADMAP、HANDOFF按本任务写集限制由主控处理。

```text
文件：完整full-from-8f.patch及snapshot/；原创修复repair-only.patch，归档恢复来源见restore-verification.json。
测试：commands.log、verification.json与各*.log；仅临时SQLCipher/mock模型/loopback，独立评审待做。
版本建议：如未来获准发布，属于patch；本轮不改版本、不commit/push/deploy。
case：docs/cases/2026-11-03-channel-resume-guards.md。
层级：实现层取消/预算/实例代次；内部HTTP补充原始期限，活动响应新增epoch，桥接与宿主应配套部署。
逻辑/爆炸半径：见本文七步；两个进程的原生提示和主动发送最后关卡。
失败路径：取消/超时/活动变化有结构化code+hint，固定准备失败通知和自主状态页；无自动补发/降级。
未验：生产服务、真实账号/模型/设备、A01、长期运行、原purpose剩余工作、独立验收。
```

## 2026-11-04 semantic-host attempt5 补充

任务 `/root/channel_resume_v2` 接手既有实现，旧十四文件及 `full-from-8f.patch` 已逐哈希核对并备份。旧补丁 SHA256 为 `ff100fd3eaf765ced77954334a8f690d4b78582542f2db9b69326bdbfb284340`。此前实现由前一执行者提供，本次原创差异见 `.local/evidence/channel-resume-attempt5/repair-only.patch`。semantic-host 累计 attempt5，T1 保持 attempt5，历史失败和用户取消修补上限的授权继续有效。

### 1. 链路

真实 QQ prompt wrapper 调用 `LocalChannelBridge.request(turn.begin)`，通过已鉴权 loopback HTTP 到 `createChannelHandler`，再 await `capabilities.beginTurn/context`。成功后句柄进入 preparation/session，`turn.end` 释放原 Writer 租约。请求错误、断连和插件卸载同样需要终结原租约。

### 2. 机制

独立评审保存了三个反例。宿主已取得租约但仍等 context、宿主尚在等 beginTurn，以及完整 HTTP 响应已到客户端但尚未完成 JSON 解析时取消。旧客户端均无 prompt/session/preparation，宿主 foreground 仍为 1。

宿主现在在分配前建立原请求所有权，断连同步标取消并释放已取得租约。迟到 beginTurn 必须检查同一取消标记并释放它取得的 lease。响应 close 监听保留到 finish/close，失败不会提前转移所有权。共享 writerTurn 持有唯一 lease，释放先置空，使重复 end/cancel 不作用于新租约。

客户端为每次 begin 附带 bridge 实例、随机 requestId 和原始登记时间。发生取消、超时、解析错误、坏 envelope 或完整响应后的网络错误时，使用原 host、channel 和鉴权头发送幂等 turn.cancel。宿主按 canonical 渠道、bridge 实例和 requestId 隔离取消。先到取消形成有界 tombstone，原 begin 只在十五秒登记窗口内受理，tombstone 保留超过该窗口，在途 entry 不淘汰。旧 begin 一律禁止重放，存活新代次不受旧 cancel 影响。

成功 begin 返回原句柄后，责任交给 prepare/session，保持 foreground 到 end。插件 dispose 和桥接 SIGINT/SIGTERM 走原租约清理。清理失败保留原异常，并附明确 TURN_CLEANUP_FAILED 状态和建议。宿主不可达时不能保证远端释放，记录失败而不重放 begin。

### 3. 爆炸半径

桥接与插件宿主两个进程，涉及分配、响应、解析及退休四个读者，保守估计为 2 × 4 × 3。新增协议仅在现有本机渠道内开放，原渠道密钥、canonical 身份和上下文检查继续执行。Python、semantic-writer 和真实账号数据均未修改。

### 4. 取舍

仅观察迟到 JSON 并 turn.end，成本较低，但完整响应后的解析失败无法取得 handle。采用请求级取消登记，增加受限且有界的宿主表，能够对缺失 handle 的失败释放原租约。测试固定跨渠道/实例隔离、重复取消、迟到 lease 和新代次不被误释放。回滚通过本单元 patch，与 bridge/plugin 两端配套。

### 5. 生效与重启

`plugins/surfcore/lib/index.js` 仅增加既有 ctx dispose 钩子对 localChannel.dispose 的调用。bridge 退出钩子等待清理并报告失败。未来发布需要两端加载新协议，本轮没有生产重启、部署或外部操作。

### 6. 验证

原两份评审脚本适配为证据目录的 `repro-lease.mjs` 和 `repro-response.mjs`，保持原断言。`red-lease.log`、`red-response.log` 为三项失败，`green-lease-request-id.log`、`green-response-request-id.log` 为同脚本通过。正式 `scripts/test-semantic-cold-native.mjs` 有 37 项原生 QQ/HTTP/SQLCipher 检查，包括原微任务取消、八秒预算，以及新增所有权和故障边界。测试仅替换模型、平台和可控 worker 时序。

初次 dispose 测试发现宿主只取消工作却没有结束 HTTP，导致客户端超时，保留 `native-01.log`。修为返回结构化取消后通过。后继全 audit、regressions、插件及生命周期检查详见 `verification.json`。清理网络故障为明确注入的预期失败场景，断言原错误不被遮蔽且失败状态可见。

### 7. 回滚与残余

`input-hashes.json` 与 `before/` 保存接手字节，`semantic-snapshot/` 是本单元结果。`repair-only.patch` 适用于接手版本，`full-from-8f.patch` 包含此前已恢复实现。freeze/seal 与 patch-reconstruction 记录机械重建。真实模型、外部平台、生产进程及独立验收均待完成。A01 接续属于独立后继单元，其证据不能代替本单元原始 guard 验收。

### 本轮发布交接

```text
任务 /root/channel_resume_v2，semantic-host attempt5，T1保持attempt5
基线 8f078a125588b03de4e6c32fe582eaa1510f0496，接手十四文件hash已核
原创补丁 .local/evidence/channel-resume-attempt5/repair-only.patch
完整候选 full-from-8f.patch，semantic-snapshot/、freeze.json、seal.json
实际检查 verification.json 与所有red/green/native/plugin日志
接口 turn.begin请求级身份与turn.cancel，保持原渠道鉴权，不重放begin
部署 bridge/plugin必须配套，本轮未部署、未生产重启、未提交或推送
限制 宿主连接失败会报告TURN_CLEANUP_FAILED，独立验收与真实运行未验证
交付 READY_FOR_REVIEW，后继A01单元另见2026-11-04-channel-pending-inputs.md
```

## 2026-11-04 semantic-host attempt6 清理失败契约修复

上轮最终 E2 的独立功能结论为 FAIL。原冻结 `536f5797e3238f3fb8fbd32d355ad1d545c4889e4a9ac14c089b99ed00ce9eb6` 和完整补丁 `794de91a3bf0f8a952e4e54524addbdb05f7bc44221e6d21e34a1aea6dc225c0` 保留在 `.local/evidence/channel-resume-attempt6/attempt5-freeze/`。本次只修复 F1 清理责任及错误传播、F2 控制台重启遗漏清理。T1 activity5 与 A01 pending1 保持原计数和既有证据。

### 1. 链路

`LocalChannelBridge.request(turn.begin)` 登记一次 allocation，准备阶段与成功 session 共享同一个清理对象。`cancelSession/endSession/dispose` 等待原对象的清理结果。桥接 `api.stopSessionWork` 同时执行原 DSH 停止动作与本地租约清理，并把失败送回调用者。控制台 `/api/restart` 和信号退出复用受控停止入口。`/api/session/reset`、`/api/workspace/reset` 检查其直接调用的结构化失败。

### 2. 机制

独立复现有三项失败。已准备 session 的 turn.end 连接失败时，真实 stop 仍返回 removed=0。begin 成功而 sources 暂停时 dispose，旧实现删除 allocation，但 preparation 尚无可等待清理责任，失败后所有集合均空而 foreground=1。控制台重启另有直接 process.exit 路径，完全绕过 dispose。

新的 allocation 从发出 begin 起一直保留到宿主确认 released。它保存原请求身份、原渠道和鉴权、已取得的 handle、当前 owner 与 sessionId。prepare 到 session 的转交只改变 owner，清理对象不会消失。来源投影生成的 alias 仍指向同一宿主 Writer 租约。

释放进行中保持 pending，失败保持 failed 和原句柄，writerReleased 只在确认后变 true。stop/dispose/restart 的显式重试复用同一对象，仅重试幂等清理。并发重试共享同一 promise。即使宿主已经释放而回执丢失，下一次 end 仍可以确认完成，不会释放新代次或重放模型、输入、消息。

准备失败保留原 REQUEST_CANCELLED/STALE_CHARACTER 等错误，同时附 cleanup 状态，并将清理失败和下一步加入 hint。真实 stop 返回 TURN_CLEANUP_FAILED。重置入口返回 HTTP 503 并明确映射已重置、租约清理未确认。重启入口先等待清理，失败返回 HTTP 503，保持进程与未确认清理对象，恢复连接后可再次点击重启。清理成功后才报告重启成功并安排退出。退出等待期间及成功后拒绝新增本地工作，失败后恢复接受新的可信被动输入。

### 3. 爆炸半径

本次只修改 bridge 进程的清理登记、原停止包装器及三个控制台入口，宿主协议和 Writer 实现保持既有版本。两个进程间的清理确认决定是否退出，保守计为 2 × 4 × 3。测试使用临时库与 loopback，process.exit 仅由测试 VM 记录。SnowLuma、真实 QQ 被动服务和真实账号配置均未操作。

### 4. 取舍

仅让 stop 返回 releaseError 的成本较低，但 preparation 中间阶段仍会丢失句柄，也无法恢复重试。采用同一 allocation 贯穿所有权阶段，复用已有幂等 turn.end/turn.cancel，不增加宿主协议或恢复队列。代价是失败对象必须保留，收益是可以明确报告并安全重试。它与发送 unknown 的禁止重放规则分别处理。回滚为本轮 repair-only.patch 的逆向补丁，先核对接手版本哈希。

### 5. 生效与重启

本轮产品改动为 `src/local-capabilities-bridge.js`、`src/bridge.js` 和 `public/console.html` 的三个操作结果提示，需要未来经批准的 bridge 进程重新加载及控制台刷新。已有插件宿主协议可兼容。测试没有启动、停止或重启任何生产服务。

### 6. 验证

独立原脚本保存为 `review-cleanup-contracts.mjs`，`red-review.log` 中三项 pass=false，`green-review-01.log` 中三项 pass=true。正式新增 15 项失败/重试检查已通过，包括 allocation 与 preparation 两个交接窗口、丢失释放回执、并发重试、旧新租约隔离、重启失败不退出、两种 reset 的成功/失败/重试，以及无 session 的 begin 在认证和响应解析边界被 dispose 取消。

最终全套原生取消、A01、生命周期、audit、regressions 与插件结果统一写入本轮 `verification.json`，以其命令、exit code、日志哈希为准。历史失败与测试夹具失配日志均保留。中间测试修正包括超过角色 ID 长度上限的合成名称、模拟 session.list 的 value 包装，以及把“end 刚发出即 released”的旧断言改为“pending 未确认，成功回执后 released”。原微任务取消和零新 prompt 断言继续保留。

控制台原 restart 回调无条件显示“正在重启”，现在按 ok 展示成功或错误，并与 session/workspace reset 一并显示 code/error/hint。测试将真实 HTTP 结果交给从实际 HTML 提取的回调，在受控 DOM 中验证提示文本和错误样式。它验证实际界面代码的行为，本轮未做可视浏览器操作。补齐这项 F2 显示要求前的十八文件草稿另存 `draft-before-ui/`，最终版本包含十九个文件。

### 7. 回滚与残余

本轮唯一最终合并版本为 `.local/evidence/channel-resume-attempt6/freeze.json` 对应的同目录 `full-from-8f.patch`，包含既有 A01/T1 与本轮修复。`repair-only.patch` 从接手的 E2 十八文件版本开始，before/snapshot 与 patch-reconstruction 保存原始字节和机械重建结果。旧 attempt5 目录保持原封，不能把它的 freeze 与 attempt6 补丁混配。

宿主网络不可达时无法保证即时远端释放。本轮会返回失败并保留本地清理责任，连接恢复后显式重试。进程崩溃或操作系统强制终止仍不能依靠内存登记完成恢复。独立验收、真实平台/模型/设备、部署和新完整 A01 实测仍待完成。

### 本轮发布交接

```text
任务 /root/channel_resume_v2，semantic-host attempt6，T1 activity5，A01 pending1
唯一最终版本 .local/evidence/channel-resume-attempt6/freeze.json
完整补丁 同目录full-from-8f.patch，基线8f078a125588b03de4e6c32fe582eaa1510f0496
本轮原创差异 同目录repair-only.patch，从保存的attempt5最终E2开始
行为 清理责任保留至确认，stop/reset/restart返回失败，明确重试仅重试原租约清理
检查 verification.json、red-review.log、green-review-01.log与所有正式回归日志
生效 bridge需未来获准后加载，本轮未部署、未生产重启、未commit/push
限制 网络不可达时报告失败并保留原句柄，真实运行与独立验收未验证
状态 READY_FOR_REVIEW
```

## 2026-11-04 semantic-host attempt7 清理结果传播核对

attempt6 独立验收仍为 FAIL，剩余问题集中在 F1 结果传播。原十九文件冻结 `a64c12f11b77e477783efa58bdc5e695ffc6cda1a7bd55df693efed83684aaa2`、完整补丁 `38b3871e57d485bbff5281b75c387b771e365ea4d315efa6ec7a3e5c8e07fecd` 及 seal 已备份到 `.local/evidence/channel-resume-attempt7/attempt6-freeze/`，原目录保持不变。F2、原分配清理与安全重试的既有证据保留。计数为 semantic-host7、T1 activity5、A01 pending1。

### 1. 链路与直接消费者

本轮枚举 `releaseRecord/endSession/cancelSession/stopSessionWork/dispose/cancelAllocation` 及捕获别名的全部生产调用，区分直接请求、结果转发、后台任务、测试和不同对象。逐点核对表为 `consumer-audit.md`，原始搜索命中也保存在同一证据目录。

直接请求通过同一 `reportCleanup` 保留主异常并附 cleanup。后台失败沿用现有 allocations 作为状态来源，经管理端 `/api/status.localCleanup` 和控制台所有页面可见的告警展示。native turn/end、QQ reset/new 及原生后台 stop 还写入既有故障事件和活动界面。受限 agent status 不含清理状态，响应没有原句柄、令牌、正文或会话身份。

### 2. 机制

独立复现中，权限撤销导致 isCurrentSession=false，endSession 失败却只抛 TURN_SUPERSEDED。另一项在成功 ingest 后吞掉 finally 的 end 失败，incoming 返回值无法说明尚未确认清理。所有权与重试本身已有效，本轮保留该机制。

权限分支现在保留 TURN_SUPERSEDED，附 cleanup.code/error/hint，并将下一步写入主 hint，不额外向失去权限的平台受众发送通知。替换旧 record 时检查 release 结果，失败停止新 prompt。外层成功释放新 preparation 不会覆盖旧回合的清理失败，已返回错误也使用状态快照，后续重试不会改写历史响应。

成功 ingest 后立即登记该 source event 已接受。正常返回保留 accepted/eventId，清理失败另附 cleanup。后续处理失败时保留原错误并附 accepted/eventId、禁止重复发送的提示和 cleanup。相同平台事件不再写入一次，auto_write 等原生来源契约继续执行。

后台撤销、退休、invalidate 或 native turn/end 无直接 HTTP 调用者时，failed/pending 状态继续留在原 allocations，并由管理状态和实际 UI 告警消费。清理确认后告警自动消失。QQ /reset、/new 清理失败不会发送“已重置”的成功消息，返回结构化失败并显示管理端可执行提示，仍遵守平台白名单和 origin 限制。

### 3. 爆炸半径

产品改动仍限于 bridge 的两个文件和控制台显示，宿主协议、Writer、Python、角色与主动联系机制保持原版本。两个进程间的清理结果由桥接的直接与后台入口消费，保守计为 2 × 4 × 3。状态展示只含计数和固定错误建议，未扩大受众权限。

### 4. 取舍

仅补最新两个失败分支，成本较小，但重复的 finally/后台调用仍容易漏报。采用一次性调用点核对、统一错误附带 helper 和现有 allocation 状态投影，改动范围可控，能够覆盖没有返回通道的后台清理。没有新增重试队列、持久化框架或另一个租约所有者。

### 5. 生效

未来经批准后需重新加载 bridge，并刷新控制台。全页告警使用原有 status 轮询。插件宿主协议不需要本轮新增接线。没有生产部署、真实服务重启、外部平台消息、真实模型或设备操作。

### 6. 验证

原独立完整 driver 原样保存，`red-review.log` 复现两个 pass=false，`green-review-01.log` 记录同脚本两个 pass=true。新增十二项正常入口检查均通过，包含真实管理 HTTP 和实际 HTML 告警函数的失败/恢复显示。完整 native 检查扩为 64 项，A01/reserved2/生命周期 65 项通过。其余 required audit、regressions、关联插件及最终版本结果以 `verification.json` 和日志哈希为准。

原丢失 end 回执的后继隔离用例先通过实际 revokeRecord 退休旧模型记录，再创建后继，继续断言重复清理不会释放新租约。旧记录仍待替换的情况由新增用例明确要求失败可见、零新 prompt，避免原用例继续依赖吞掉 release 失败。全部旧测试和失败版本保存在 before 与前代冻结包，验收条件未放宽。

### 7. 回滚与残余

唯一最终合并版本位于 `.local/evidence/channel-resume-attempt7/freeze.json`，对应同目录 `full-from-8f.patch` 的十九文件。`repair-only.patch` 只包含本轮差异，基于保存的 attempt6 版本。前后字节、完整补丁输入、机械重建、消费点核对和 seal 均随本轮交付。

连接不可达时仍无法即时保证远端释放，管理状态会保留失败并指向显式清理重试。进程崩溃或操作系统强制终止的持久恢复不在本轮范围。实际浏览器可视操作、真实平台/模型/设备、完整新 A01 批次和本轮独立验收仍未完成。

### 本轮发布交接

```text
任务 /root/channel_resume_v2，semantic-host attempt7，T1 activity5，A01 pending1
唯一最终版本 .local/evidence/channel-resume-attempt7/freeze.json
完整补丁 同目录full-from-8f.patch，基线8f078a125588b03de4e6c32fe582eaa1510f0496
本轮差异 同目录repair-only.patch，从保存的attempt6最终十九文件开始
核对表 consumer-audit.md，覆盖直接、后台、测试与不适用的清理消费者
行为 保留主错误与接受事实，后台清理失败经管理status/UI可见，权限撤销不绕过平台限制
检查 verification.json、原独立driver红绿日志、native64和关联回归
生效 bridge重新加载及控制台刷新，本轮未部署、未生产重启、未commit/push
交付状态 READY_FOR_REVIEW，独立验收仍待完成
```
