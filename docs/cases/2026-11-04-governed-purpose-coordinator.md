# 一个治理目的协调器与实际送达收尾

## 用户已要求停止测试并收尾文字版

2026-11-04用户明确结束追加测试及语言、语音、音频工作，接受当前文字效果。此次交付采用冻结04的文字功能，加上已完成的迁移消费标记修补和Writer收尾夹具修订。未完成音频差异已隔离保留。

QQ、桌宠文字聊天、B站公开阅读与统一目的页面进入部署收尾。目的默认15分钟评估一次，公开B站默认60分钟读取一次，QQ为主要文字载体，每日4次、间隔90分钟，安静时段23:30–08:30。30分钟闲置门槛已移除。

后续完整对照、独立验收与两小时观察已按用户要求取消。40文件合并候选的追加全量验收未完成，历史结果各自对应原冻结版本。部署前备份在.local/backups/text-deploy-20261104-2347，采纳清单在.local/evidence/full-integration/text-candidate-adoption-20261104.json。下文为此前阶段记录。

2026-11-04，任务 `/root/purpose_coordinator`，完整实现 attempt2，等待独立验收。工作树为 `D:/luyao_companion_v0_1/surfcore-luyao/.local/worktrees/purpose-coordinator-20261104`，最终接受依赖基线为 `7208400ccaf5d998f6181e5cdd05c4add5b5b94d`。

最初独立 planner attempt1 的 CP1、CP2 均失败。完整source-freeze-01的独立来源frame审阅又实证缺失proof与子记录ABA两项失败，原27项测试未覆盖，03新增反例并收紧frame、纠正退役与backup同gate。旧 freeze、full.patch、独立报告和确定性红灯保留在 `.local/evidence/purpose-coordinator/` 与主仓 `.local/evidence/purpose-planner-independent/`。本次完整实现与最终测试、冻结文件另存 `attempt2/`，次数保持连续。

## 1. 链路与接口

插件 `index.js` 创建唯一 `autonomous-companion.js` 实例。`/purpose` 和兼容 `/companion` 路由共用它，PurposeTab 读取同一配置和状态。BiliTab 指向该入口。一个 timer 分别检查 `nextBrowseAt` 与 `nextPurposeAt`，Bili 无新视频或公开读取失败时仍能根据有效 QQ/Pet 经历、人格和待续目的思考。

`local-purpose-planner.js` 通过已验收材料适配器读取实际目的地普通受众的有界治理快照，复用原纯引擎的 persona、drives、goals、feedback、seeds 和 selection。原 `purpose-engine.js` 保持零 I/O。`prepare/validate/checkpoint/dispatchState/recordOutcome` 由真实协调器消费。每轮重建贡献，状态只保存来源引用、人格摘要、回执、终态身份与统计。

`local-purpose-model.js` 在选出真实目的后调用已核验 fixed-model，pin 一次 provider/model/config/endpoint。有限协议为 `{"decision":"skip"}` 或 `{"decision":"send","text":"…","pending":"none|continue|done"}`。无目的为0次主人模型，skip为正常0投递，异常、截断、额外目标字段均报错。

`local-purpose-public.js` 只向公开 reader/research提供公开视频字段。自动写入关闭时，真实本轮公开响应可在治理 ingest 校验且确认为从未存储的 missing 后形成有界 host ephemeral-public proof。proof 固定原公共 context、角色代次、内容hash、稳定BV/event、取消和120秒时效。已存来源使用当前有效修订，删除、停用、未知及隐藏祖先不能借 fresh 响应复活。host_observed_public 仅表示读取时刻。

Python `attention.status {}` 提供普通主人或本机管理页的窄只读账本状态。设置、每日计数、有效限额、冷却与安静时段均来自现有 attention 权威。协调器文件仅保留 reader、载体、选题窗口等非账本选项。旧配置迁移保持关闭，manual run 仍受最终 attention、focus、foreground 守卫。idle 固定0。部署时由主控通过唯一 attention 配置入口明确写入已批准的4次、5400秒、23:30–08:30，enabled先保持false。

QQ 使用原 host intent 与桥接末发送守卫。Pet 使用现有 native HTTP/event guard、同步守卫和真实回执，独立于 QQ 在线状态。只选一个载体，配置允许的 Pet 离线 fallback 仅在确定未尝试任何传输且尚未生成时选QQ，再捕获QQ实际受众和模型。unknown或已尝试不会切载体、重放。voice沿既有单输出授权provider，未授权状态带可操作错误。

普通QQ人格只提取当前 composePersonaLayers，覆盖 core、tone、daily、实际private/group scene、identity与v1/v2筛选。普通Pet与主动Pet同用当前Pet人格组合。人格原快照参与最后验证。普通chat不读取旧diary/history作为治理素材。

## 2. 来源、反馈、取消与不可重放

本轮实际用到的全部材料都绑定原proof集合，等待后核验原context、角色、来源、人格、活动和controller。生成后不取新epoch认可旧内容。attention.configure有真实非空变更时先同步调用唯一coordinator.cancelPending，status及兼容空patch读取不取消普通chat。

待续只保存引用并运行时从当前有效治理材料重建，默认14天TTL。超出普通窗口的原引用可在同一有界投影中准入，仍保留原接收时间。投影挤出、来源修订/删除或失去可见性会退出待续和驱动贡献。无来源legacy pending不导入。未知最近主人活动保持null，并抑制纯引擎默认24小时沉默推断。

反馈须绑定实际sent的目的和可信主人原话。显式reply对应真实deliveryId，或同boot、同原会话、无插入其他轮次的连续sequence证明，才交给对应目标。其他“好”、沉默、未知投递均无关系事实贡献。

CP1修复将不可重放终态身份与活动贡献分离。unknown、done及已消费的候选身份绑定所选相关来源修订或人格身份，独立于未选材料删除、有限历史和重启。相关源的新修订可以产生新目的。预派发目标hash与正文hash防止重启重放，状态上限到达时可见拒绝。

CP2修复把原prepare的signal/guard固定到plan同步checkpoint。model每次await后及validateTarget都复核它，后传空options不能覆盖。真实context.validate末次返回后多层microtask取消有确定性反例。

## 3. 普通助手实际输出收尾

`memory.assistant-output` 是新增受信私聊/Pet收尾入口。它要求原普通绑定的私有ingress token、固定confirmed_assistant_output身份、原memory_epoch及非空精确来源id/revision。管理、agent路由、普通ingest/propose和Writer均不能声明该身份。普通user与派生材料的original混用禁令保持。

QQ只收集原普通回合真正确认发送的气泡，保序在completed或通过原native close gate时一次提交。任何未确认、非文字、工具localOnly或禁止记忆输出使整轮保守跳过。输入与实际检索记录完整加入依赖。Pet在原生HTTP确认后提交原普通回复，工具与主动临时消息不走此入口。auto_writefalse不落输出正文。

提交发生在原Writer lease仍持有时，随后走既有cleanup。已送消息的记忆失败独立展示code/error/hint，清理失败保留原所有权及重试入口。重复收尾/cleanup重试不再次提交或平台重发。Pet等待回执与提交期间计入foreground，无回执45秒后保守unknown并清理，新入站或停止会取消原收尾。

元数据投影为assistant、confirmed_output、verbatim，保持服务首次接收该确认输出的时间。它不成为主人陈述或常驻用户事实。依赖闭包继续执行删除优先和修订检查，原事实纠正/删除后助手复述也退出purpose及后续检索。元数据frame同时绑定输出正文、完整依赖ID与精确revision集合，缺失proof降为unknown，原来源纠正时同事务退役后代metadata，旧读者改写不能恢复原话身份。

## M5 角色包防重放接线

source-freeze-03的独立实证发现新library只保留次数和UUID摘要，丢失同候选的terminal。unknown和sent均能以新UUID绕过旧事件摘要。原红脚本与stdout保留。修复将有界的purpose终态hash及正文hash作为platformState可选字段，沿原加密角色包迁移。

角色包默认从LocalCapabilities.stateFile同目录companion读取固定角色hash状态文件，与生产index的LOCAL_ROOT/companion一致。导出前后sourceFence包含实际purpose投影摘要，正文、账号、授权、排程和在途工作不入包。超限明确拒绝，终态不截断。旧包无字段按空合并。

导入在原恢复commit事务内单调合并到SQLCipher的purpose_replay，保留目标既有终态，保持默认关闭、暂停和主人复审。purpose.state是绑定原主人私聊/Pet与memory_epoch的窄只读入口，无目标选择器，管理/agent未开放。planner正常prepare读取导入终态，coordinator消费导入正文hash。已送待续只迁移消费hash，源机可以继续，目标不会恢复旧待续。普通同机恢复也不能清空已导入防重放状态。

新可信主人入站可形成新目的，已支持的公开材料current-revision通路可使用同ID的新revision。普通memory.correct得到revised/verbatimfalse，现有P2不会把修订后的相对时间文本当作新主人原话，继续保持该准入约束。

## 4. 影响面与取舍

影响桥接、插件、Python能力服务三个进程及其UI、渠道、素材和备份读者。真实私域正文只在既有加密治理库保存，引用状态没有私域正文。公开网络与主人模型边界分离。所有测试仅使用隔离SQLCipher、合成模型和回环native HTTP。

保留原算法加治理适配，每轮重建而非沿用旧聚合数值，成本为有界读取和复核，收益为来源纠正能同时撤销正文和数字贡献。恢复分离legacy loops会增加账本、timer与私域旁路，所以统一在既有协调器。

待续采用引用重建，降低额外派生正文和epoch刷新风险，代价为超出有界覆盖时保守失效。普通助手输出则必须作为治理派生依赖记录保存，保留实际发言身份。

收尾比较了release后写与持原lease写。真实Writer会在最后租约释放后自动运行并变更epoch，因此先在原守卫下单次commit，再独立cleanup。代价是等待真实回执期间短暂保留lease，由原取消和45秒未知收尾限制生命周期。

## 5. 生效与重启

需要主控统一加载桥接 `src/bridge.js` 与 local-capabilities-bridge、插件lib/client，以及Python core/record_metadata。桥接、插件宿主、能力服务均需按既有流程重启。无需改已安装Pet文件、设备配置、版本或tag。运行中旧页面刷新后读取权威attention值。

## 6. 验证与证据

最新完整命令结果以 `attempt2/checks.json` 和freeze引用的日志为准。直接检查包括以下各项。

- planner CP1/CP2、固定模型、来源删除/纠正、待续、auto-write、unknown时间和feedback。
- 完整coordinator、公开材料既有T1矩阵、独立截止、单timer、QQ/Pet单载体、最终attention取消和native回执。
- 普通助手整轮气泡、未知/失败、重复收尾、来源闭包、末次await取消、清理失败、真实自动Writer屏障、QQ实际turn/end与Pet HTTP。
- P1旧24项和新增7项真实SQLCipher测试，材料23项，A01 controls11与Writer-policy4。
- 完整audit、regressions、插件测试以及guard7/native64/未答37/角色/渠道/tool/media受影响回归。

首次完整audit的115/118失败保留，分别为并发重测试下activity60秒超时，以及两个A01单元夹具未创建临时父目录。activity单跑22通过，A01夹具最小修复后单跑通过。最终audit独立串行运行。source-freeze-03完整audit的activity总60秒超时后，独占计时确认22/22全过、总72,107ms，单组持续推进且最后清理105ms，无自身残留服务。主控批准仅该脚本audit整文件预算120秒，生产和A01时限保持原值。完整接线audit第二轮118/119的唯一失败来自coordinator夹具没有等待新增异步Pet收尾，夹具未等待异步收尾是一项测试缺陷，生产activity漏报等待回执/commit的foreground是另一项产品缺陷。分别修复并补持租约清理失败、重试归零、末次等待停止和无Promise拒绝遗漏后继续全量复跑。各次收尾夹具失败也保留，不将退出0的旧缺陷确认脚本称为PASS。

## 7. 回滚与交接

回滚以最终freeze的完整文件集合对比7208400基线，先停唯一主动协调器，保留加密治理数据与既有删除账本，再按主控流程恢复代码。新增元数据source_kind在旧读者中保守降为unknown，依赖记录仍遵守原治理规则。

真实账号、模型、平台、设备、部署和两小时观察由主控完成。当前实现的本地测试不能替代这些验收。role-package及format、portable_state和purpose.state也需随同一冻结版本加载。共享HANDOFF/ROADMAP、版本和manifest由主控集中维护。

发布交接为完整purpose单元attempt2。基线7208400，新M5真实coordinator unknown/sent/continue三例、旧包单调合并、导出中purpose变化、容量拒绝与新目的矩阵已纳入test-purpose-role-package。源码、测试、协议及本case由 `attempt2/freeze.json`、`attempt2/artifacts/full.patch` 和 `attempt2/artifacts/delta-from-attempt1.patch` 精确绑定。原attempt1冻结和CP1/CP2失败保留。待独立验收通过后，主控基于冻结Git对象生成manifest并统一部署。
