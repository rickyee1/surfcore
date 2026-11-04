# SurfCore × 路遥融合验收矩阵

## 11月4日验证更新

当前主源码包含已接受的P2材料8e7232c与A01控制0fa1f35。DSH、记忆服务和QQ桥接处于停止状态，用户已恢复SnowLuma登录。当前集成状态以本节及HANDOFF顶部为准。

| 项目 | 本次证据 | 后续工作 |
| --- | --- | --- |
| P2材料 | attempt2功能独立通过，22项真实SQLCipher检查，主仓四文件canonical一致 | 独立planner与完整协调器/可信事件/UI接线 |
| A01控制 | attempt2功能独立通过，透明iterator及拒绝attempt记录修复，主仓13文件一致 | 新候选冻结后的120次对照与盲评 |
| 原版新参数烟测 | 两条真实模型分别完成隔离QQ和Pet流程，2204ms/819ms，实际call证据通过，模型目录显示DeepSeek-V4.1-Flash | 候选实测与完整比较，旧120次FAIL保留 |
| 渠道清理 | attempt6已修复所有权保留、重试与控制台重启，独立仍发现部分消费者漏报cleanup | semantic-host7集中修全部直接/后台消费者并复核 |
| 备份与恢复 | 停机快照3817文件/95669162字节源hash一致，真实DPAPI数据库副本恢复后24条原记录digest相同，删除标记仍删除，重开通过 | 角色包完整UI流程与第二台物理电脑迁移 |
| 完整purpose | 独立planner/model/attention.status有15+4项检查，进入独立复核 | QQ/Pet单载体、配置/UI、真实主动联系 |
| 设备 | 用户暂停实际设备测试 | 等用户恢复设备实测 |

新恢复证据位于 `.local/evidence/full-integration/recovery-clone-20261104-v2/result.json`。首个夹具共用source_ref使两个合成标记按删除闭包共同删除，诊断和失败日志已保留，第二个全新副本改用独立来源后通过。live数据库、独立删除库、DPAPI文件hash均未变化。A01烟测证据位于 `a01-controlled-original-smoke-20261104.json`，startup目录预检准备项按原契约保留，实际dispatch检查均通过。

事实截点：2026-11-03，Asia/Shanghai。**整体尚未验收通过；真实部署为 `9f456d24b3165773b805879a5d59912a1e6af1e2`。** 本文只汇编已存在的证据，不启动测试、服务、模型、平台或设备，也不增加实现需求。未接受的semantic/T1工作区修改及已接受但未部署的P1元数据均不属于当前运行版本。

后续授权更新：用户已取消本任务自动修补次数上限，原“等待次数授权”已解除；旧FAIL/attempt及验收标准不变。正在隔离修复semantic-host4/T1 activity5，并诊断A01。夜间最多一条仍未使用，设备仍暂停。

要求来源：[原方案第 11–12 节](../../luyao_companion_v0_1/docs/SURFCORE_LUYAO_INTEGRATION_PLAN.md)、[本仓工作副本](../.ai-work/luyao-integration/source-plan.md)、[完整执行单](FULL_INTEGRATION_EXECUTION.md)；当前任务状态参考 [本机状态记录](../.local/evidence/full-integration/state.json)。执行单/状态记录用于定位，具体通过结论以对应版本的独立评审、冻结清单和实际结果为准。历史 case 中的“待独立复核”不推翻其后已记录的限定 PASS；旧部署的实测也不能升级为新版本通过。

## 状态与证据边界

- **通**：所写明的范围已有通过证据；“代码通”包括隔离夹具/实际 SQLCipher/HTTP/原生调用路径，不代表真实模型、平台或设备通过。
- **部分**：只完成该层的一部分，单元格说明剩余项。**基线**：旧部署已有实测，可供回归比较。**待**：必要验证未完成。**阻**：已有失败反例，修复或独立复核未完成。**—**：该项不单独要求这一层。
- 恢复层的“隔离通”指合成数据的重启、故障或中断演练；不包括真实用户库升级、跨设备搬迁、物理断电或磁盘损坏。设备层包括麦克风、扬声器、窗口采集及适用的实际锁屏/热拔插。
- ignored 证据链接只在本机可用，不随仓库发布；本文不复制账号、凭据、消息正文或私密日志。各结果只覆盖其冻结版本，合并后仍需最终门禁及适用实测。

## 11月3日当前结果（覆盖下方11月2日历史检查点）

完整链路、机制、取舍、回滚与失败分母见[实测case](cases/2026-11-03-full-integration-live-results.md)。旧矩阵保留历史含义，不能把其“待部署/未启动”当作最新状态，也不能把旧代码PASS扩大为新反例通过。

| 项目 | 当前结论 | 仍未完成 |
| --- | --- | --- |
| 部署/升级 M0/M5、A10–A11 | 9f实际部署；用户DPAPI/SQLCipher升级、摘要保持和重启通过；9f audit108/108、regressions16、manifest725 | 未接受源码不能重启加载；后续版本需最终冻结与验证 |
| A01 | **FAIL**：全120次、115完成/5超时、双盲360评分；融合版A01-25-r2与A01-28-r1漏答硬失败；40参数一致性失败 | 原生帧已证实72次标题与3次Writer调用来源，另1次仍NOT_PROVEN；不改变旧40项阻塞及15/30无效受控结论 |
| M1 / A02–A04 | 真实Writer消费1条、认知提案0；CPU索引12/12重建、查询通过。P1元数据attempt2功能独立通过，112相关检查；A01原生隔离受众测试已纳入完整批次 | 真实提案质量、纠正/删除/恢复后输出尚未完整覆盖；P1尚未接JS/部署 |
| M2 / A05–A07 | QQ/Pet真实共享合成记忆召回成功（预热后3秒）。原quiet/预算隔离证据仍有效 | semantic-host3紧停与时限反例、T1追加4桥接重启反例FAIL；完整purpose与单载体接线缺失，主动发送关闭 |
| M3 / A08–A09 | 实际时间工具与合成文件经确认→固定模型→原生桌宠sent；过期确认拒绝；便签创建/读取local_only | Explorer、实锁屏未验；一种自然说法未命中分类器限制保留 |
| M4 / A13 | 原生补丁已应用，Flash图像请求前提核查通过 | 用户暂停实际麦克风/扬声器/窗口测试，media关闭，无实际图像回答或硬件PASS |
| M5角色包 | 浏览器实际加密包下载、认证二进制上传及同ID预览通过；new冲突拒绝 | 浏览器选择器受扩展许可限制；未stage/commit用户库恢复、未验证第二台物理电脑 |
| 连续运行 / A12 | **观察已完成**：2h/121样本，三个监听进程无重启；记忆/QQ121/121，DSH页面120/121（一次401）；20分钟空闲观测0模型调用 | DSH业务RPC不支持，业务健康unknown；2h不等于24h，不接受dirty改动，不代表全部模型调用账单 |

本机证据入口：[A01结果](../.local/evidence/full-integration/a01-final-results.json)、[盲评理由摘录](../.local/evidence/full-integration/a01-rationale-excerpts.md)、[两小时结果](../.local/evidence/full-integration/observer-two-hour-result.json)、[当前状态](../.local/evidence/full-integration/state.json)。具体工具、平台、角色包证据见实测case。

当前：用户已取消修补次数上限；semantic-host4/T1 activity5已冻结进入独立复核，取消后Writer占用残留反例仍待修。P1是完整purpose所需的新素材元数据，attempt2功能独立PASS，不重置旧计数，P2素材适配正在独立树实施，单协调器完整接线尚未实现。一次夜间公开内容私聊测试仍未使用；每天4次/90分钟/quiet保留，取消30分钟闲置门槛的修改未部署。P1保存的补丁与采用模块一致性已核，但原生逐编辑调用轨迹仍NOT_VERIFIED；不冒充已验证的宿主归属。

## 11月2日历史检查点：M0–M5 退出条件

| 阶段 | 代码层 | 模型层 | 平台层 | 设备层 | 恢复层 | 连续运行层 / 当前退出结论 |
| --- | --- | --- | --- | --- | --- | --- |
| M0 固定基线、唯一编排与能力进程 | 通：绑定/代次、单服务、停用/故障与协议回归（E01） | 部分：关闭功能不调用模型已有确定性检查；新部署空闲实测待验 | 基线 QQ chat/Pet 文本可用；新部署回归待验（E00） | — | 隔离启动失败、父退出、重启通；实际升级待验 | 2h 未启动（E12）；**未退出** |
| M1 来源记忆、隔离与用户主权 | T2a、Writer、索引/聊天/UI 独立通（E02–E04） | 本地 BGE CPU 及合成库浏览器检索通；真实 Writer 整理质量待验 | 新版本跨端来源/纠错/删除输出待验 | — | 删除优先、错误口令、坏包、缺 ledger 复审、重启隔离通；用户库待验 | 待；**未退出** |
| M2 跨端连续性、关系依据与统一主动限制 | T1、T6 确定性独立通；关系为有来源的受治理投影（E03、E05、E07） | 原版 A01 两项 native 实模型 smoke；融合版对照/盲评与关系表达待验 | 仅旧 QQ chat/Pet/B站公开读草稿为基线；新自主主人私聊、reserved2 连续回合待验 | 媒体迟到结果另见 M4 | 预算、去重、unknown 不重放、quiet/focus/未回应持久化隔离通 | 待；**未退出** |
| M3 受控本机工具 | Broker/UI/固定聊天宿主、幂等历史接缝独立通（E06） | 当前模型真实提议→确认→固定结果交付待验 | 新桌宠消费者补丁、原私聊组合交付待验 | 实际 Explorer/Windows 锁屏停止待验 | COMMIT/回滚失败闭锁、取消、unknown、重启旧许可不复活隔离通 | 待；**未退出** |
| M4 按键转写、单输出、免提与窗口 | T4-P attempt3、preload 与 T4-H attempt2 独立通（E08–E09） | ASR/VAD 公共 wav、KWS 加载/AEC 静音帧预检通；媒体实际模型请求待验 | 已安装原生 pet 整链路待验 | **实际设备 0**；无麦克风/播放/窗口/实锁屏通过结论 | 后端撤权、晚输出、expiry/COMMIT/native-open 隔离通；宿主修补已独立放行，实机待验 | 待；**代码通过，实机未退出** |
| M5 备份、角色包、升级与诊断 | T2a 与 T5 attempt2 独立通，后者专项 51 项（E02、E10） | 资产存在/固定哈希及依赖清单已记录；不等于所有运行效果通过（E11） | 浏览器真实选文件/保存、用户升级及跨设备迁移待验 | 设备许可不迁移，须重新授权/实测 | SQLCipher/Windows DPAPI 历史 Store、断点重启、包完整性/删除优先隔离通；真实升级待验 | 2h 未启动；**未退出** |

## 11月2日历史检查点：A01–A13 逐项矩阵

每行的“待”均保留在原验收范围内；未完成项不从分母删除。六层不能互相替代。

| 编号 / 原要求 | 代码 | 模型 | 平台 | 设备 | 恢复 | 连续运行 | 对应证据 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A01 同模型同参数固定聊天集，自然程度/完整性不退化 | harness 独立通 | **部分：仅原版 2 项 smoke；完整 120 次和盲评未跑** | native QQ/Pet 路径已 smoke，QQ 传输为 loopback；真实平台待 | — | 初次 setup 失败保留，未静默重试抹分母 | 待 | E07；门槛至少 24/30 不劣，任一次泄漏/虚构已执行/漏答明确请求均硬失败 |
| A02 用户纠正与旧 Writer 竞争 | 通：pinned/来源修订/epoch/提案消费事务 | 待：当前模型真实经历整理及纠正后认知核查 | 待：新部署管理纠正→聊天输出 | — | 隔离通：旧提案/重复提交不覆盖当前修订 | 待观察 | E02–E04 |
| A03 群聊诱导私域或跨群检索 | 通：受众先过滤、递归来源可见性、共享须绑定 | 待：新版本实模型输出验证 | 待：原生 QQ 群/私聊适配器配隔离 OneBot 与 SQLCipher；不向实际群发送测试消息 | — | 隔离通：来源停用/删除、重启不扩大范围 | 待观察 | E01–E05；E00 只作旧版基线 |
| A04 删除→重启→重整理→恢复旧备份 | 通：别名/派生闭包、提案载荷、索引与候选失效 | 本地 BGE 删除/重建通；真实 Writer 旧结果拒绝待联调 | 待：新部署最终输出不出现已删内容 | — | 隔离通：独立 ledger、旧快照/包不得复活；真实用户恢复待 | 待观察 | E02–E05、E10 |
| A05 切角期间回复/语音/工具迟到 | 文本/工具及 T4-P 通；T4-H attempt2 独立通 | 待：新版本真实慢模型切角 | 待：实际 QQ/Pet 迟到交付为零 | 待：播放/采集切角停止 | 隔离通：旧绑定/context/许可失效；宿主修补通，实机未验 | 待观察 | E06、E08–E10、E13 |
| A06 QQ/Pet 并发主动联系及断网 | 通：统一预留/幂等/来源校验/unknown 不补发 | 待：实模型主动一轮 | 待：主人 QQ 实际发送、并发载体及受控失败结果核对 | — | 隔离通：跨实例竞争、重启去重/unknown | 待观察 | E01、E05、E06 |
| A07 安静/静音/未回应/重启 | 通：quiet/focus/预算、群消息不重置主人状态 | 待：融合版被动正常回答/不打扰体验 | 待：新部署 quiet/专注及被动回复实测 | — | 隔离通：限制和账目重启保留 | 待观察 | E01、E05、E10 |
| A08 伪主人/模型篡改授权 | 通：可信主体、参数摘要/版本/原目的地确认、无全局授权 | 待：真实模型工具提议与拒绝路径 | 待：实际管理确认/桌宠与私聊固定交付；群聊不能继承 | — | 隔离通：撤权/切端点/过期/双 consume/旧确认重放拒绝 | 待观察 | E06、E10 |
| A09 执行中紧停/锁屏/服务退出 | T3 与 T4-P 通；T4-H attempt2 独立通 | 待：真实调用取消/晚结果 | 待：已安装宿主最终交付/队列停止 | 待：实际锁屏、采集/播放停止及 Explorer | 隔离通：持久化故障闭锁、取消、保守 unknown；无孤立 running | 待观察 | E06、E08–E09、E13 |
| A10 迁移重试/坏数据/中断 | 通：隔离/暂停、清单/收据、原子角色门禁 | — | 待：真实升级与浏览器文件流程 | — | 隔离通：T2a/T5 故障、历史 DPAPI Store、合法 begin 后恢复；物理断电未验 | 待观察 | E02、E10 |
| A11 缺 key/服务不可用 | 通：不造空库、不退明文、不回旧库；错误可见 | 缺模型凭据与模型故障有安全 code/error/hint；真实模型配置单独核对 | 基线部署健康可复用；新版本故障界面/恢复待 | — | 隔离通：SQLCipher/DPAPI/独占锁失败与恢复边界 | 待观察 | E01、E06、E10、E13 |
| A12 启动/空闲/停用，无第二聊天/整理循环 | 通：唯一编排、事件驱动 Writer、惰性语义 worker、停用/取消 | 确定性无闲置模型调用通；新部署空闲遥测待 | 待：实际宿主/桥接/能力子进程收敛 | 待：实际设备 worker 退出 | 隔离通：父退出、重启、任务/队列失效 | **待：observer v2 仅 once，2h 未启动** | E01、E03–E04、E08、E12 |
| A13 真实语音多轮与屏幕撤权 | T4-P/preload/T4-H attempt2 独立通 | 仅离线 ASR/VAD 与 KWS/AEC 预检；当前选择模型/同帧实际请求待 | 待：已安装 pet 的单输出 ACK/实际呈现 | **0：识别、播放、打断、回声/误唤醒、窗口/撤权均未实机验收** | 合成设备的后端取消/TTL 通；不代替实锁屏/热拔插 | 待观察 | E08–E09、E11 |

## 11月2日历史证据索引（新增结果见上）

| ID | case / 固定范围 | ignored 证据入口与解释 |
| --- | --- | --- |
| E00 | [本地部署](cases/2026-11-02-local-deployment.md)、[QQ/Pet 部署](cases/2026-11-02-qq-pet-deployment.md)、[B站只读草稿](cases/2026-11-02-bili-readonly-drafts.md) | [QQ chat 实测](../.local/evidence/qq-chat-live-retest.json)、[模式同步](../.local/evidence/qq-chat-mode-sync.json)、[B站检查](../.local/evidence/bili-readonly-drafts-checks.json)、[升级前状态](../.local/evidence/full-integration/baseline-live-status-before-new-deploy.json)。仅为 `e9d33b4` 既有链路：QQ chat、Pet 文本、B站登录/公开资料/本地草稿；不证明新自主外发、reserved2、媒体或新迁移。 |
| E01 | [本地能力服务](cases/2026-11-02-local-capabilities.md) | [服务修复证据](../.local/evidence/service/s1-verification.txt)、[递归来源复核](../.local/evidence/service/source-read-attempt2-verification.txt)、[T2a 最终来源接缝冻结](../.local/evidence/t2a/attempt3/freeze-sha256.json)。多角色/多受众、加密/锁/key、来源身份与删源验证；历史测试版本见各冻结清单。 |
| E02 | [提案与备份](cases/2026-11-02-local-memory-proposals-backup.md)、[记忆管理](cases/2026-11-02-local-memory-management.md) | [attempt2 清单](../.local/evidence/t2a/attempt2-sha256.json)、[attempt3 清单](../.local/evidence/t2a/attempt3/freeze-sha256.json)、[管理 attempt2](../.local/evidence/full-integration/management-attempt2-freeze.json)、[管理浏览器证据](../.local/evidence/full-integration/management-ui-evidence.json)。独立通过状态见执行单/状态记录；HTTP 加密传输通过不等于浏览器文件选择/落盘已通过。 |
| E03 | [语义 Writer](cases/2026-11-02-semantic-writer.md) | [Writer attempt2 冻结](../.local/evidence/t2b-writer-attempt2/freeze-sha256.json)、[23 组结果](../.local/evidence/t2b-writer-attempt2-target.log)。模型为 stub，来源/epoch/聊天优先/auto-write-off 入口核查；真实 Writer 模型效果待验。 |
| E04 | [本地语义检索](cases/2026-11-02-local-semantic-search.md)、[聊天/管理接线](cases/2026-11-02-semantic-chat-management.md) | [CPU 实模型证据](../.local/evidence/t2b-semantic/attempt1/real-cpu-evidence.json)、[后端检查](../.local/evidence/t2b-semantic/attempt1/checks.json)、[浏览器合成库检查](../.local/evidence/t2b-semantic-host/cua-checks.json)、[接线 attempt2](../.local/evidence/t2b-semantic-host/attempt2/freeze-sha256.json)、[集中独立 PASS](../.local/evidence/full-integration/joint-review-attempt2.md)。BGE CPU 512 维、同义召回/重建与纠正通，不推断全量语义质量。 |
| E05 | [自主陪伴](cases/2026-11-02-autonomous-companion.md)、[设置卡](cases/2026-11-02-companion-ui.md)、[过期接缝](cases/2026-11-02-companion-expiry.md) | [T1 最终冻结](../.local/evidence/full-integration/t1-attempt3-freeze.json)、[最终定向结果](../.local/evidence/full-integration/t1-attempt3.log)、[组件检查](../.local/evidence/t1u-companion-ui-checks.json)、[真实公开 reader](../.local/evidence/full-integration/bili-reader-live.json)。reader 是公开元数据实读；协调器公开 HTTP/模型/QQ 为隔离夹具；组件树不是实际浏览器 DOM；新主动发送未部署。 |
| E06 | [Broker](cases/2026-11-02-local-tool-broker.md)、[工具 UI](cases/2026-11-02-local-tools-ui.md)、[固定工具聊天](cases/2026-11-02-fixed-tool-chat-host.md)、[重复事件](cases/2026-11-02-tool-proposal-duplicate.md) | [Broker attempt2](../.local/evidence/t3/attempt2/checks.json)、[UI 浏览器](../.local/evidence/t3u/attempt3-root-ui-evidence.json)、[宿主集中独立 PASS](../.local/evidence/full-integration/joint-review-attempt2.md)、[幂等历史接缝](../.local/evidence/t3h-duplicate/attempt1/checks.json)。含实际 HTTP/SQLCipher 和路径反例，模型/QQ/Explorer 为隔离替身；真实锁屏未验。 |
| E07 | [reserved2 连续性](cases/2026-11-02-reserved2-continuity.md)、[A01 harness](cases/2026-11-02-a01-native-harness.md)、[A01 固定标准](testing/A01_ACCEPTANCE.md) | [连续性独立 PASS](../.local/evidence/full-integration/joint-review-attempt2.md)、[harness attempt3 独立 PASS](../.local/evidence/a01/attempt3-startup/independent-review.md)、[原版两项 smoke 汇总](../.local/evidence/a01/original-smoke-v2-summary.json)、[30 场景冻结](../.local/evidence/full-integration/a01-fixture-freeze.json)。两次场景约 26/22 秒，正常 stop/气泡交付；真实模型、loopback 平台，未做融合版比较/盲评。 |
| E08 | [媒体 authority](cases/2026-11-02-local-media-authority.md)、[只读 preload](cases/2026-11-02-dsh-media-preload.md) | [T4-P attempt3 独立 PASS](../.local/evidence/t4-media/attempt3-root/independent-review.md)、[preload 独立评审](../.local/evidence/t4-d-preload/attempt1/independent-review.md)、[实际 Electron 只读证明](../.local/evidence/t4-d-preload/attempt1/readonly-proof-final.json)。限定后端/加载路径，ASAR 未改、未调用真实模型或设备；T4-H SDK 修复后需刷新 preload 依赖证据并重验协议。 |
| E09 | [媒体宿主](cases/2026-11-02-local-media-host.md) | [attempt1 独立 FAIL](../.local/evidence/t4-host-attempt1/independent-review.md)：F1 文本转写在 SDK 最终 fetch 前缺原许可复核；F2 暂停 ACK 后旧 native 排队音频仍可播放。两项均为实际 authority/完整 adapter 或原生 class/renderer 的无设备反例。[attempt2 红灯目录](../.local/evidence/t4-host-attempt2/) 保留修复证据；其后[attempt2 独立 PASS](../.local/evidence/t4-host-attempt2/independent-review.md)已覆盖原反例及受影响路径；实际 Electron preload 的更新依赖证明见同目录 preload-dependencies.json。实机仍待验。 |
| E10 | [完整角色包与升级恢复](cases/2026-11-02-role-package-recovery.md) | [attempt2 独立 PASS](../.local/evidence/t5/attempt2/independent-review.md)、[51 项及影响回归](../.local/evidence/t5/attempt2/checks.json)、[冻结清单](../.local/evidence/t5/attempt2/manifest.json)。12 Python + 22 Node + 11 legacy native + 6 HTTP；真实 SQLCipher/隔离 Windows DPAPI，旧 binary 拒绝及 marker/TTL 边界通；用户 Store、跨设备、浏览器文件流程、物理断电未验。 |
| E11 | [依赖与资产](LOCAL_CAPABILITIES_ASSETS.md) | [媒体清单](../.local/evidence/full-integration/media-models.json)、[ASR/VAD 离线预检](../.local/evidence/full-integration/media-model-preflight.json)、[KWS/AEC 预检](../.local/evidence/full-integration/media-wake-aec-preflight.json)、[embedding 清单](../.local/evidence/full-integration/embedding-assets.json)、[依赖许可元数据](../.local/evidence/full-integration/optional-dependency-license-metadata.json)。公共 wav 推理及唤醒模型加载/AEC 静音 PCM 不是实机识别/误唤醒/回声效果；外部资产不随仓库分发，环境许可元数据不等于安装包完整 notices。 |
| E12 | 连续运行计划（没有完成结论） | [observer v2 计划](../.local/evidence/full-integration/observer/plan.json)、[v2 冻结/once 结果](../.local/evidence/full-integration/observer/freeze-v2.json)。预定 7200 秒、60 秒间隔、121 端点样本；前 20 分钟计划空闲，后段负载须另记录；**未启动 2h**。once 为 HTTP 可用性，3211 RPC `supported=false/404`，`businessHealthy=null`；不推断业务失败或成功。2h 本身也不是 24h 稳定性证据。 |
| E13 | [模型失败提示](cases/2026-11-02-local-deployment.md)、[安装完成状态](cases/2026-11-02-voice-install-completion.md)、[导入失败回滚时序](cases/2026-11-02-voice-import-failure-order.md)、[更新复制同元数据](cases/2026-11-02-update-copy-same-metadata.md) | [模型失败检查](../.local/evidence/pet-model-errors/verification.txt)、[语音导入独立 PASS](../.local/evidence/voice-import-failure-order/independent-review.md)、[更新 helper 初轮冻结](../.local/evidence/update-copy/attempt1/manifest.json)。失败提示/安装门禁不构成真实媒体能力通过。更新 helper attempt1 定向通过后独立 FAIL：`/IS` 未覆盖相同大小/mtime、不同 ChangeTime 的 Modified 类，仍可留下旧正文；其后[attempt2 独立 PASS](../.local/evidence/update-copy/attempt2/independent-review.md)以真实helper验证正文/清单和14保护路径，修补已提交7fd0b1b；最终audit仍待清单收口。 |

## 11月2日验证计划（已执行项与暂停项以上方当前结果为准）

1. **部署已接受的媒体修补。** T4-H attempt2 覆盖原两个反例、普通文本/附件回归和同帧/无历史边界，独立限定通过；SDK patch 更新后的实际 Electron preload 12项通过。三文件原生补丁须整体应用，实际设备另验。
2. **冻结并部署本次版本。** 主会话记录最终 commit、资产/依赖、实际启用设置与重启结果；最终 audit/regressions、相关插件和安装清单按该版本收口。现有最新整合前 [audit 日志](../.local/evidence/full-integration/final-audit-before-manifest.log) 是 **106/108**，两失败为更新 helper 与 manifest；定向修复通过不能改写该历史结果，也不能用早先 108/108 代替最终合并树结果。
3. **验证新链路的真实模型/平台结果。** 正常 QQ chat/Pet 回归；真实合成经历→Writer→可查认知/纠正/删除→CPU 检索；明确主人范围的自主浏览→有来源想法→一次真实私聊；reserved2 连续回合；固定工具模型提议、用户确认、正确私聊/桌宠结果与 unknown 核对。默认关闭的动作须按已批准范围启用；不扩至群聊或任意发布。
4. **由用户显式激活设备专项。** 记录 ASR/PTT 预览与 Send、单一 TTS、免提/KWS/VAD/AEC 实际多轮、打断、同帧窗口问答，以及停止/撤权/锁屏/切角/失心跳/父退出后的采集、播放与发送终止结果。当前所有真实设备计数为 0；模拟 PCM/VM/loopback 不填此栏。
5. **完成恢复与体验验收。** 在保留新写入和独立删除权威的前提下，由主会话演练适用的实际升级/恢复、浏览器文件流程和角色包迁移。迁移和中断用隔离新 Store 与进程故障验证；第二台物理电脑及物理断电保留为未覆盖环境，不额外扩大原验收范围。A01 按冻结 30 场景×2 版本×2 次完整执行与盲评，保留失败/超时/不支持项；原版两个 smoke 只作链路预检。
6. **执行已声明的观察。** 最终部署和重启验证后再明确开始 observer v2 的 2h 批次，记录版本、开始/结束、空闲合规、实际负载、缺样/进程变化/业务层覆盖和结论；启动计划或 once 不算开始/完成。没有完成这一层，不宣称 M0–M5 全量验收。

更新每项结果时保留：`验收编号｜实际版本/清单｜环境与层次｜时间｜结果/失败分母｜case/证据路径｜未验证项`。仅追加脱敏事实；旧失败和旧冻结证据保留，不能用新结果覆盖其原始含义。

## 本次范围之外

Live2D、完整持续感知、签名安装器/签署发布、RM1 自然语言提醒均不加入本次欠账；原方案将其单列扩展或明确不作首批依赖。本文不增加平台发布权限，不安排版本 bump、tag、Release，也不要求为了矩阵再实现一套功能。
