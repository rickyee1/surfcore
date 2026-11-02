# T2a：来源提案治理与加密记忆恢复

## 现象、范围与环境

基线 `e9d33b481025b73e8398b0d76548413ab35b3aa8` 已有加密经历、纠错、删除闭包和受众过滤，但自动 `memory.propose` 仅新增经历，没有认知提案消费事务；没有独立删除记录或可用的加密快照恢复。

本单元新增 Python 后端提案治理、可追溯关系派生、确定性关键词索引、口令加密逻辑快照和隔离恢复。独立审查首轮发现 F1–F3 后，按集中定位包进行第二次修复；不以自编测试通过替代独立验收。环境为 Windows / Python 3.13 / sqlcipher3 0.6.2，仅使用临时合成库和测试密钥，未打开真实用户库、凭据或设备。

不在本单元完成声明中：JS 语义 Writer、管理 UI 与导入下载接线、真实模型语义评估、向量检索、M3 工具 Broker、设备能力、完整人格/资产包及全 M0–M5 验收。这些由后续单元负责；不能把此后端接口存在当作全部功能完成。

## 完整逻辑

1. **链路**：父进程通过 `server.py` 的有界 JSONL 调用唯一 SQLCipher 服务。`core.py` 继续验证受信绑定、角色代次和事务；新 `memory_governance.py` 管理提案/消费/检索投影，新 `backup.py` 管理快照与恢复。旧 `context/attention` 路径保持；批准的 T1 接缝只增加有效来源 ID 和可选固定来源修订。
2. **机制**：经历与当前认知分开。提案绑定真实来源 ID、修订、角色代次、受众和全局记忆版本，批次认知、修订及消费标记同事务提交。用户固定内容不能被自动替换。关系投影是同样受治理的派生陈述，不另造情绪评分。
3. **隔离与删除**：可读公开内容不等于可写公开记录。自动 supersede/invalidate 只写当前精确受众、递归可见且活动的未固定目标。删除不仅清正文、修订、索引和派生记录，还按来源/目标、批次产物 ID、正文摘要清理 pending/committed 提案载荷和结果，阻止换提案 ID 重放删除措辞。
4. **恢复权威**：快照用独立口令派生 SQLCipher key，仅包含选中角色的记忆域。独立加密 `sovereignty.db` 留存最新删除摘要、本机备份登记及随机 ledger 实例标识，不随旧快照覆盖。隔离 stage 校验后，提交按当前 ledger 重新判断可信性，合并最新删除记录、执行删除闭包、重建索引，并使旧代次/绑定失效。
5. **批准所有权**：未知来源或丢失最新 ledger 默认暂停。管理复审绑定当前活动 restore_id、快照摘要、当前记忆版本和当前 ledger 实例；旧恢复 A 不能批准新恢复 B。每角色批准持久化后可跨重启保持，其他角色仍暂停，不把全局 trusted 改成 1。ledger 再丢失时旧批准失效。暂停状态再做备份不能洗成可信来源。
6. **取舍与影响面**：直接复制活动 DB 和源 key 简单，但会带回旧删除、许可或不一致内容；在活跃 BEGIN 中调用原生 backup 也有事务风险。选择独立 SQLCipher 逻辑快照与隔离 stage，成本是新增明确定义的状态和校验。影响唯一能力进程及其记忆/恢复读者；不外发、不计费、不运行模型，不修改上游日志或旧人格卡。
7. **生效与回滚**：由主会话在独立验收通过后备份受影响数据并重启能力进程，重建宿主绑定。schema 为增量新表；第一次升级由活动库的已有权威 tombstone 初始化独立 ledger。恢复提交后必须丢弃旧生成结果/队列/上下文。回滚应暂停新后端并保留 memory.db、sovereignty.db、原保护 key 和备份/stage；不能用旧 executable 忽略新删除/复审状态，更不能自动切回旧明文 Writer。真实服务本单元未重启。

## 第二次集中修复的证据

先将七个独立反例加进测试，在首轮冻结实现上实际复现：24 项 backend 测试，8 个失败（公开目标 supersede/invalidate 为两个子用例）。证据 `.local/evidence/t2a/attempt2-before-fix.log`。

- F1：私域不能改 `bili:public`；递归隐藏的目标不能通过换挂新来源恢复可见。
- F2：refs 为空的自动 add 产物删除，必须清掉批次载荷和产物结果；独立来源候选若正文等于删除内容，同样清理且不可重放。
- F3：健康 stage 后 ledger 丢失，旧 stage 默认不能放行；A/B 连续暂停后，当前 epoch/重算摘要也不能批准旧 A；缺 ledger 后有效复审重启保持该角色已审，其他角色继续暂停，再替换 ledger 则旧确认作废。

此外验证错误摘要、更新 epoch 却使用旧批准、暂停期再备份、复审期间用户纠正、重复批准不重导、snapshot 错密码/损坏/事务中断、旧物理主库回放与独立 ledger 优先。T1 接缝验证 active ID 不扩大受众，来源 revision/map 严格匹配且同事务，源纠正后派生想法停止使用。

## 验证与限制

- 服务：原 23 项 + backend 26 项 = **49 项通过**；没有删除旧检查。`attempt2-service.log`。
- JS 兼容：主接线 20、桌宠 16、渠道 18 项通过；增加 T1 接缝后已重跑相同相关检查，全部通过。
- `npm run test:audit`：108/108 通过；`attempt2-audit.log`。
- `npm run test:regressions`：16 项通过；`attempt2-regressions.log`。
- 证据目录：`.local/evidence/t2a/`；完整差异、文件哈希和 API 文档随第二次冻结包交付。

错误均使用 `code/error/hint`。新批准失败保持暂停，损坏/错口令/中断不污染活动数据。旧加密快照和取消后的 stage 保留，不声称物理擦除了所有旧副本；恢复时删除记录优先。跨设备没有最新删除记录时无法凭空重建它，必须暂停并明确复审。测试只证明合成场景的后端行为，不等于真实账户/语义模型/灾难恢复运维全部验收。

## 发布交接块

### T2a attempt3：自动写入关闭不跳过删除校验

T1 接缝补充反例：同角色 QQ 私聊曾持久化稳定来源事件，主人删除后关闭自动整理；公开受众查询依法返回 missing，旧 ingest 却先返回 AUTO_WRITE_DISABLED。调用方可能误把它当成从未持久化的新公开材料，继续临时研究和发送。

只在关闭写入的路径复用 `ingest(validate_only=True)` 的只读验证，先检查角色级 tombstone、字段、派生来源、修订和重复身份，再返回关闭状态；没有新增查询权限或返回其他受众正文/ID。真正新事件仍返回 AUTO_WRITE_DISABLED，记忆、索引和 epoch 均不写入。原七项修复不重构，现有 per-scope 幂等不变。本窄修无需 schema 迁移。

新增两个服务反例先在 attempt2 失败，证据 `.local/evidence/t2a/attempt3/before-fix.log`。随后同一接缝有限表补齐，复现停用/失效/祖先隐藏/其他受众/隔离区五个分支仍被误归为 AUTO，证据 `identity-matrix-before-fix.log`。统一修复后原 23 + backend 29 = **52 项通过**：关闭写入时精确已有事件还必须自身 active 且按普通受众递归可见；只在同角色别 scope/隔离区有记录时仅布尔查询后拒绝；其他角色的同事件删除不影响当前角色合法新输入。每条路径均断言零写入/epoch 不变，开启写入时原有 per-scope 行为也有正向检查。JS 研究不发送的端到端断言由 T1 owner 补齐。改前源码/文档副本路径见该证据目录 `backup-location.txt`。本窄修不启动 M3、不操作用户库。

### 交接

改动：`services/local-capabilities/` 的增量治理/备份实现与协议文档；`scripts/test-local-capabilities-service*`；本 case。完整写集合与 SHA 见冻结证据清单，未改 JS、共享 HANDOFF/PITFALLS、版本或提交。

层级：兼容协议扩展；建议后续发布会话按功能范围确定版本，本编辑单元不改版本。既有无 source_revisions 的 ingest 兼容；review:true 现在必须携带匹配的 review_digest，新增 management-only backup.recovery.status 用于宿主重启后的复审恢复。

接入要求：未来 Writer 用 scoped episodes.pending → 有界模型提案 → submit/commit，不用管理历史作模型上下文；UI 只在明确用户确认后发送当下 digest，不能自动刷新批准后重试；恢复前写入 backend written 意图，成功后清宿主代次/绑定缓存。密码不进日志或持久化。真实升级、UI/语义模型与完整角色包验收仍由后续单元处理。

失败与回滚：见上文恢复暂停、CAS、删除优先及数据保留策略；独立审查通过前不部署本单元。当前只交 READY_FOR_REVIEW，不宣称 ACCEPTED。
