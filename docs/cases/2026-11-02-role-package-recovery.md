# T5 角色包与升级恢复

原始实现 `/root/tools_ui` attempt1，集中修复 `/root/capability_service` attempt2；工作区 `D:/luyao_companion_v0_1/surfcore-luyao`。原基线 `b7bcb0812a6b313015d1b4dbe309c4bf22735189`，attempt2按实际覆盖前SHA固定（共享文件含上游T4宿主接缝，不冒充本任务作者）。状态：冻结交独立复验，不是实际部署验收。

## 现象与根因

旧角色快照是人格和旧平台文件复制；新 memory snapshot 不含 attention/outreach。直接组合会漏掉身份、防重发、FS/DB 中断边界。旧 Store 没有读前 schema gate，单加 user_version 无法约束实际历史二进制。

## 完整逻辑

1. **链路**：本机管理页 → 原 DSH exact route 和登录/cookie/header/Origin → 固定 role.package 操作 → Node 协调器 → 私有 stdio portable capability → Python SQLCipher 事务和原生 BackupManager。portable.* 不进浏览器/facade 白名单，不新增通用 channel action；恢复管理不依赖已撤销的聊天绑定。
2. **机制**：有界固定 KDF/AES-GCM AAD 包含七层人格、独立口令加密快照、防重发摘要和逻辑资产清单。认证后 canonical JSON/allowlist 拒绝重复与额外字段。source ID = nested ID = target ID；new 不改 ID，已有同 ID 必须显式 restore。导出前后检查 role epoch、人格散列、memory_epoch 和 attention revision。批准已封存密文摘要，既有目标先留口令加密 prechange 包；口令不进 journal。
3. **影响面**：native+portable 预算统一按不含 lineage 的稳定 dedupeDigest 去重；eventKey 保留来源账目，charged OR，unknown/sent 不能被 failed 清洗，时间冲突拒绝。按目的地当前时区计费，保留更严格配置，unanswered=max、intensity=min、enabled=false。密钥/账号/授权/设备许可/队列/排程/旧复审均不迁移。scope/principal 保留，旧 QQ scope 列作未绑定，新账户不能重标或读取旧私域。目的地独立 sovereignty 删除日志优先。
4. **取舍**：永久 UNIQUE(target,packageDigest) receipt 和单目标唯一 begun 操作阻止丢响应后再应用；marker/latch 带 operation ID 并 CAS，A 不能清 B。先 marker+DB begin 暂停、撤销 Writer/绑定/工具/媒体，再安装人格、提交 DB，最后 manifest/index/current epoch。任一中断保持暂停，只能明确继续同一摘要；DB 已有 receipt 时只核对发布，不重放旧 snapshot。复审检查 persona digest 与 committed memory epoch；正式新写入不被旧库覆盖。
5. **生效与升级**：持独占锁、证明旧库可解密后，在任何初始化/迁移写入前检查 schema。生产 DPAPI 原32字节 key 先保留受限 owned 备份，原子封为带 min-reader 的 envelope，最后提交 schema；没有 rekey。历史 Store 解封长度不再为32而实际拒绝。新 reader 可读取 envelope-before-schema 过渡状态；不丢 key、不新建空库、不静默恢复旧 key。raw SURFCORE_LOCAL_KEY 和人工恢复历史 keyfile 不保证历史 binary 受约束。诊断提供版本、keyfile备份路径/迁移阶段、自有 PID/依赖存在性，无密钥/hash/正文/凭据。
6. **验证**：`scripts/test-role-package.py` 10项实际 SQLCipher/Windows DPAPI 测试，含实际历史 b7bcb08 Store、before_envelope/after_envelope 两断点、旧事实与新写入保留、新 schema 预写拒绝、坏/缺 key 不建空库、receipt/互斥/CAS、往返去重/unknown→failed/时区/修订、密码和身份错误。`scripts/test-role-package.mjs` 19项原生 stdio+production coordinator/mounted client 检查完整导入、七层哈希、旧私域/删除优先、真实 A→B→A、四断点重启、失效审批/attention竞态、重复与未知字段、口令/损坏/截断/KDF、hardlink/junction、缺资产与未知响应不重试。`scripts/test-role-package-management.mjs` 6项实际 DSH wrapper/HTTP/SQLCipher 检查认证上传下载、portable浏览器拒绝、persona same-ID fast path/facade/context gate、暂停时恢复入口及本机复审。最终计数和实际回归结果以 evidence `checks.json`/日志为准。
7. **回滚与残余**：覆盖前文件在 `.local/evidence/t5/attempt1/baseline` 和两个 mechanical-apply 的 before 副本。Python/host patches 交 owner 机械落；index 路由由 channel author 落。正式升级后只可暂停、兼容读取、加密导出/修复，不能回旧库/旧 key。独立验收、真实用户库升级、跨设备搬迁、浏览器文件选择/保存、物理设备和长期运行另行验收。必需资产无本机已验证 inventory callback 就阻止导入，无自动下载。断点测试覆盖进程中断，不宣称验证物理断电/磁盘损坏。本次没有模型 API、QQ/Bili 或设备操作。

## 使用入口

本地记忆页“角色包与升级恢复”。导出：口令 → 封存预览 → 核对勾选 → 确认 → 下载。导入：上传 → 口令/明确同 ID 方式 → 预览 → 重新输入口令隔离准备 → 核对勾选确认。响应未知只填操作 ID 查状态；中断先检查再明确继续。提交后查询并核对本机删除记录复审；backend 仍暂停、主动发送仍关，角色选择/本机后端启用/设备许可单独进行。

不更新版本、tag、release 或共享项目账本。完整代码 diff、窄接线 patch、逐文件哈希和日志位于 `.local/evidence/t5/attempt1/manifest.json`。

## Attempt2：legacy durable gate 与原始确认期限

1. **链路**：marker落盘→Node异步portable.status→私有portable.begin→SQLCipher。
   另一条是原生pet/QQ启动/生成→await→队列→最终HTTP。attempt1只靠DB latch和local
   context，marker存在但mode=legacy时旧宿主直接继续；审批只入口用`>`，status await
   越过期限仍begin，两个反例均已独立复现。
2. **机制**：新增独立于backend模式的角色ID/epoch capture和fresh marker检查，放在
   原生pet的chat/暴露purpose complete入口、模型前/后、语音、事件队列、poll和最终
   sync HTTP边界；QQ原生bridge启动、incoming、模型prompt及sendChain最终OneBot
   HTTP均查。旧队列仍带原role，不能在复审换代后重标成新角色。仅把guarded设true
   不足以封legacy无context返回；本次没有用模式转换替代durable gate。
3. **影响面**：T5专属portable_state/role-package/role-package-gate、API/case/tests直接修；
   facade/pet-chat/local-capabilities-bridge/bridge/index只出精确SHA窄patch，由root机械
   应用并保存记录。保留上游T4 media-host/nonce/deliverEphemeral接缝，不改其主体。
   core/storage/schema/portable权限边界没有额外改动；没有部署或操作真实库/设备/平台。
4. **取舍**：仅先把mode持久改paused少代码但marker-before-begin崩溃仍能绕过；按
   每次发送临时重新取角色又会让旧队列跟随新角色。选择捕获原ID/epoch并在实际效果
   边界重核marker，保留管理恢复通路。TTL由Node前后查和Python首次正式写入前查
   原始期限共同保证，较仅JS多查一次能覆盖内部start/coordinator await耗时。
5. **生效**：重启插件/QQ bridge/独立能力进程后生效，不加DB表或迁移用户数据。
   portable.begin新增私有必需字段approval_expires_at（有限整数Unix毫秒），浏览器
   不能传它。JS固定journal expires不续期；<=now拒绝，确认失效时无persona/DB写入，
   backend持久pause配置只在begin成功后写。合法begun后结算可跨旧TTL，不重验旧批准
   也不重导入。过期旧journal/marker需明确重新检查确认或取消，不能后台刷新。
6. **验证**：原35项复用并新增反例：Python12、原生Node22、HTTP6、实际native host11，
   共51专项通过。含缺失/NaN/Infinity/小数/过去/exact期限0begin写入、目标最后read跨期、
   await跨期0begin、合法begin后跨期结算、legacy marker0模型、模型await晚回复不写历史、
   旧队列poll和已选结果的最终pet HTTP无正文、QQ实际prompt0模型和排队HTTP0发送、
   settings原生handler启动/聊天结构化失败以及未暂停正向。所有最终native测试同时固定
   DSH_HOME和合成SURFCORE_ROOT，防止paths.js回落仓库config；无真实外部模型/平台调用。
   红/绿、初始fixture失误和完整实际回归分别保留于 `.local/evidence/t5/attempt2/`。
7. **回滚与残余**：只按attempt2备份和shared-before/after撤本次窄变化，保留T4及原T5
   接缝，不安装旧SQLCipher库/旧keyfile；schema升级仍只前进。不能将attempt1已FAIL
   的缺口版本用于真实迁移。实际用户Store升级、跨设备搬迁、浏览器文件选择/保存、
   物理断电和长期运行仍NOT_VERIFIED。主会话统一audit/regressions、部署和独立验收。

## 发布交接块（本次未提交/未发布）

- 现象：角色包marker在legacy原生pet/QQ链路失效；审批在exact/await边界过期仍begin。
- 修法：角色/代次和durable marker独立gate贯穿启动、生成、队列和最终同步外发；Node
  inclusive TTL及Python首次正式写入前原始approval_expires_at校验，不刷新旧授权。
- 验证：51专项及相关现有回归见attempt2/checks.json；模拟模型/transport和新SQLCipher/
  DPAPI临时库，无实际平台/设备/用户迁移。fixture问题单列，不算有效红例。
- 接缝/迁移：T5_API.md；共享patch由root按实际SHA机械落，无新schema，不改浏览器参数。
- 重启/回滚：root统一重启宿主/bridge/能力进程；回退仅本次代码，不退旧库/key/T4接缝。
- 仍未验收：用户真实升级、跨设备、原生浏览器文件流程、物理断电和长稳。
