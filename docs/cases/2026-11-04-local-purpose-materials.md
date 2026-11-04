# P2：普通受众目的素材与来源证明

日期：2026-11-04；当前状态：attempt2 READY_FOR_REVIEW，尚未独立验收、集成或部署。attempt1独立FAIL（F1–F3），失败计数及冻结包保留。
任务：`/root/purpose_materials_finish`，接续 `/root/purpose_materials`。
基线：`8f078a125588b03de4e6c32fe582eaa1510f0496`。
只写隔离树：`D:/luyao_companion_v0_1/surfcore-luyao/.local/worktrees/purpose-materials-20261103`。
证据根：该树的 `.local/evidence/purpose-materials`。attempt1原freeze与日志原位保留且完整备份至 `attempt1-archive/`；当前修复及新冻结包位于 `attempt2/`。旧日志仍相对证据根，新日志均明确标记 `attempt2/`。

## 现象与根因

P1 已提供受治理的原始来源元数据，但现有 JS 没有普通受众的有界目的素材快照，也没有每次等待后对原人格、原上下文与真实来源版本的统一复核。旧 actor 标签只是标签，不能证明原话或接收时间。直接拿旧记录的插入顺序、pinned 或当前时间推断主人计划，会将旧文本当成新经历。

原执行者已实现 facade 接缝、素材模块及19项真实 SQLCipher 检查。本次接手的attempt1保留该实现，补充相对时间反例和过滤词；独立复核仍发现3项阻塞，attempt2按集中问题包修复，见下文。原主体并非本次重写。旧 `patch-01.txt` 至 `patch-10.txt`、失败日志和 hash 均保留。原作者逐编辑宿主事件不可读取，记录为 `unknown`；角色名称和文件 hash 不作为宿主事件或模型运行归属的证明。

## 完整逻辑（七步）

### 1. 链路

未来可信 QQ/Pet/Bili 宿主 → `LocalCapabilities.ingest(..., {actor, original:true})` → 原普通 binding 的私有 ingress → P1 `memory.ingest`。默认调用不声明 original，继续得到 unknown 元数据。`rg` 核对当前 `pet-chat.js`、`local-capabilities/channel.js` 和 `autonomous-companion.js` 均仍使用默认调用；具体原始事件接线留给后续集成者，本单元没有修改它们。

未来唯一 coordinator → `createLocalPurposeMaterials({capabilities,getPersona,guard})` → `snapshot({channel,now,config,limit,signal})` → 普通 `facade.materials` → P1 `memory.materials` → 纯引擎 `collectMaterials` 充实每条有效记录。新素材模块的当前读者仅专属测试，没有启用调度、模型或发送。纯引擎文件字节不变。

快照返回 `materials:{items,stats}`、同一组 `engineItems`、人格、原 `context`、`proofs`、`timelessBackground`、`coverage` 和 `lastMasterAt`。引擎证据 id 为 `local:<id>:r<revision>`，可以解析到 sidecar 的原记录 id/revision；私有 WeakMap 保留验证权威，公开快照递归冻结。私有context/records/coverage/binding及proof独立深拷贝冻结，原limit另存不可变primitive。真实tool host的host_gate是冻结空对象、WeakMap身份能力，保留原身份但复制外层binding；可变结构gate被明确拒绝，不能靠clone或替换续权。公开context同样保留可用的原opaque gate。上下文是 host 权威材料，不应整包送模型。

### 2. 机制

`materials` 限制1–50条，默认20，拒绝 selector/query/受众覆盖及 management；绑定来自实际目的地，不另选管理绑定。它返回本次原上下文，读取后还核对绑定是否仍缓存于原服务/角色代次。投影是有界覆盖，不代表完整历史，也不代表材料按事件发生时间排序。

`original:true` 只允许合法原始 actor、无 derived、普通真实缓存 binding；public Bili 仅 external，QQ/Pet 仅 user/assistant。原 ingress credential 仅存在 facade 私有缓存，随绑定、服务和角色代次失效，永不进入返回、状态、日志、模型或管理 allowlist。默认 actor 标签和 Writer 派生结果不能升级为可信原话。

只有正数可信 service-received 时间、original/verbatim user 且历史 owner 标记为真，才形成主人时间材料。助手是 self，公开原始来源是 video/external；群、unknown、revised、derived 均不冒充主人原话。接收时间不是平台事件时间，也不能证明用户所述事情已发生。未知/过期 pinned 仅在整句符合明确常驻知识正向文法时进入独立背景：中文/英文明确喜欢、不喜欢、偏好等谓词，宾语限定茶、咖啡、读书、学习、编程、绘画、音乐、游戏、运动、旅行、猫狗等小词表（最多3项），或“我的母语是中文”等有限语言事实。允许已修订“我现在喜欢茶”；不接受任意宾语、任意尾随句、临时任务、进行中活动或无法判定的旧文本。未命中正向规则计 `background_unproven_excluded`，即使它实际上是稳定知识也保守遗漏。`TIME_CLAIM`仅用于诊断计数，绝不以未命中黑名单作为准入依据；背景仍标记 `temporalFactsAllowed:false`，不成为主人原话或时间证据。

`meta.key=private:governed:<scope>`（群为 group 前缀）只给纯引擎分类，并有 `internalOnly:true`，不是 QQ 会话/发送目标；真实 origin 另留在 `proofs[id].sourceMetadata.origin`。后续不能把内部分类键传给平台投递。

ingest还捕获原character、state对象、binding与服务generation，在每次等待后以及persist/dispatch前同步复核，written仅写捕获的原state。已派发后的旧提交无法撤销，切角后的迟到成功返回STALE_CHARACTER且不通知新角色Writer，绝不把新角色标为written。素材路径每次 await 前后都同步执行原 guard，核对当前角色、人格 id/epoch/revision/hash/正文 hash 与服务代次，绝不刷新原 epoch。`getPersona` 必须是同步权威 getter，Promise getter结构化失败。复核使用原 binding 和同 limit 重调 `memory.materials`，加原 `context.validate`，比对全部实际使用记录的 id/revision/完整投影。P1 已证明同 scope 递归 source 闭包，有限投影无需另读未展示祖先，也不使用仅精确 scope 的 `context.sources` 验证继承公共材料。

共享关闭沿用既有 scope：后续 Pet 私域读写 `pet:local`，不再读写 `owner:local`；既有获授权共同主人知识不搬迁、不删除，映射 QQ 主人仍沿用现有 owner scope。关闭时原 snapshot 退役，不将“关闭共享”误写成清除旧共同知识。

### 3. 爆炸半径

当前新模块生产读者为0，新增运行进程为0；实际验证仅临时 SQLCipher/stdio fixture。facade 由既有聊天宿主读取，窄增接口并保持旧 ingest 默认行为；部署后错误时序若静默放行会污染后续目的模型，故按潜在2类宿主（桥接/插件）×1个 facade ×静默权重3=6作保守评估，并用结构化失败阻断。没有触碰真实 profile、记忆库、凭据、模型、平台或设备；没有发送、付费调用、重启、commit/push。

### 4. 取舍

A：复用 P1 普通投影和纯引擎，增加小适配器；收益是保留现有 scope/删除治理和纯函数机制，成本是有界多次校验，风险集中在元数据映射与等待竞态，可按四文件差异回滚。选择此方案。

B：恢复旧磁盘 history/日志读取器或直接给旧文本补当前时间；代码接线较短，但会绕过治理、制造时间和归属、扩大旧数据暴露，回滚还需处理污染知识，拒绝。也不重写纯引擎或增加另一套 timer。

### 5. 生效与重启

本次没有实际生效到运行仓，也没有启动真实服务。后续 coordinator/可信事件接入后，按部署流程重启读取 facade 的桥接或插件宿主才能使用新代码；P1 Python 不变，无需以本单元为由升级或重建用户库。主动联系开关、真实平台/设备权限仍由原流程管理。

### 6. 验证

- attempt1历史：`node plugins/surfcore/scripts/test-local-purpose-materials.mjs` 曾19项通过，真实临时 SQLCipher；日志 `materials-test-final-02.log`。该结果不足以覆盖后续独立发现的3项漏洞，不当作当前产品PASS。第16项含6类表述×unknown/expired两种 pinned 场景；保留原纠正偏好“我现在喜欢茶”可以成为修订知识的回归。
- attempt1历史：facade整合20、Pet整合16、channel18、Writer23、纯引擎19、purpose wiring、coordinator32、regressions16均 exit0；命令与日志见 `finish-affected-results.json` 和对应 `finish-*.log`。
- attempt1历史：`npm run test:audit`：环境补齐后的 `audit-03-native.log` 为108/108；最终源码 `audit-04-final.log` 同样108/108、exit0。
- 无需额外断言复制实现；专属主测验证材料归属、共享隔离、所有来源修订、删除/停用闭包、未知旧时序、auto_write关闭、同事件去重、token不泄漏、人格/取消/服务代次竞态、有界递归 proof 和无 Bili 私域计划进入纯引擎。

失败记录保留：`audit-01.log` 为106/108（缺合成 config、预设CRLF漂移）；`audit-02-fixtures.log` 在相对 preload 被临时仓继承后中断，不算完整审计。`materials-relative-red.log` 首次新增反例夹具忘记 pin，断言失败后补正夹具；`materials-relative-red-02.log` 真实复现“今晚”进入背景；`materials-test-final.log` 记录初次过滤过宽排除了现有“现在喜欢茶”修订知识；随后缩窄规则，最终19项通过。未擦除失败或改验收条件。

审计只在本工作树临时放置无账号/密钥/profile字段的合成 config，并将两预设字节换为 git对象的 LF；变更前准确备份，完成后还原并将合成 config 隔离。`audit-native-environment.json`、`audit-native-restored.json` 保存前/中/后 hash。setup audit 仅操作其自建临时 repo/DSH_HOME，不操作用户 profile。共享 node_modules/.venv 只读。

失败接口通过 `CapabilityError(code,error,hint)` 向 host 报告；测试要求失败 code 符合且 hint 非空。调用方应显示错误与“丢弃本轮素材，按当前角色/版本重新开始”的下一步；本单元没有 UI，最终目的页错误呈现仍是后续集成验收项。不能用本次接口测试宣称界面、模型或平台通过。

### 7. 回滚与残余

当前完整可应用差异及精确新文件位于 `attempt2/artifacts/full.patch` / `attempt2/artifacts/newfiles/`，attempt2相对attempt1增量为 `attempt2/artifacts/attempt2.patch`，case增量为 `attempt2/artifacts/case-increment.patch`；具体hash见 `attempt2/freeze.json`。旧 `artifacts/original-author.patch` / `artifacts/finish-contribution.patch` 及旧freeze保留，只代表attempt1归属与失败版本。回滚仅针对本四文件：facade恢复基线，新文件先隔离后移除；勿回退其他作者或共享状态。真实运行仓无需回滚，因为未写入。

仍待后续：可信 QQ/Pet 每事件 original接线、coordinator绑定所有实际使用 proof、单入口/单载体和固定模型/平台实测。常驻知识正向文法有意保守，会漏掉不在小词表中的有效偏好/事实；后续消费者仍不得从无时间背景推断日期、主人原话或当前计划。bounded materials 的遗漏不等于缺乏经历。此单元不代表 P2 全链路或 M0–M5 完成；状态须由独立验收确定。

## attempt2集中修复与验证

独立报告为真实运行仓的 `.local/evidence/purpose-materials-independent/review.md`，artifact版本为attempt1 freeze `85bdeb9e6e4ed622ab62b54f0671b26ed5ae54c1d58a66a19d54c8073d8f6d8d`。集中问题F1：最后一次ingress验证后切角，仍写旧角色且错误标新角色written；F2：外部持有原coverage可将private重查limit1扩大到50；F3：黑名单漏掉进行中/相对计划，被当作常驻知识。

先复制该版本全部证据及四文件，保留独立FAIL。修复前实际执行原counterexamples，`attempt2/confirmed-pre-repair.log`确认三项漏洞；该脚本exit0的含义是“漏洞成功复现”，绝非产品PASS。再以最小同写集修复F1–F3，无P1、pureengine、coordinator、UI或真实运行修改。

当前主测22项：`attempt2/materials-01.log`为真实SQLCipher服务、exit0。第20项覆盖冷/缓存credential、首次/第二次validate、首次open和late ingest结果，含切角色、服务代次变化、绑定撤销及默认兼容ingest；派发前0写入，派发后旧提交保留但成功取消，新角色written=false且Writer通知0。第21项外改原coverage.limit、binding.generation/host_gate、记录正文和metadata后，private仍limit1、原gate身份可验证；拒绝mutable gate。第22项9种模糊/临时计划在unknown与expired original均被排除，4种明确稳定知识保留；fresh原始计划继续进入引擎，原第4项仍验证derive/form/mine/select完整链路。

P1当前没有独立pin API，正常management.correct会将记录标为revised。因此unknown+pinned使用真实管理纠正；expired original+pinned通过明确的投影contract fixture，仅在两次materials返回中置pinned=true，保留真实收到时间、source metadata和proof，未写SQLCipher数据库或伪造原始来源。原第16项另保留真实correct后、可信received时间过期的pinned检查。测试日志不把contract fixture称作真实用户库pin操作。

12套affected guard/suites及regressions全部exit0，最终audit108/108、exit0。命令、退出码及日志见 `attempt2/finish-affected-results.json`、`attempt2/audit-final.log`；运行期间只使用本树备份、无账号密钥合成config和git LF预设，完成后还原原字节，见 `attempt2/audit-native-environment.json` 与 `attempt2/audit-native-restored.json`。未部署、commit、push、调用真实模型/平台/设备。await后的晚到已提交不可撤销，是显式残余：只拒认本轮成功，不迁移、重放或伪装回滚。

## 可转发发布交接块

```text
改动文件：plugins/surfcore/lib/local-capabilities/facade.js；新增 plugins/surfcore/lib/local-purpose-materials.js、plugins/surfcore/scripts/test-local-purpose-materials.mjs、docs/cases/2026-11-04-local-purpose-materials.md。
验证：attempt2主测22项真实SQLCipher通过；原19项+F1角色状态竞态、F2私有authority隔离、F3旧知识正向准入。12套affected guard/suites和最终audit/regressions实际结果见attempt2日志清单；旧attempt1独立FAIL与证据保留。无真实平台/模型/设备调用。
建议：patch（窄增 host接口，旧ingest默认行为兼容；不改版本、不tag、不发布）。case：docs/cases/2026-11-04-local-purpose-materials.md。
层级：普通受众材料与可信来源适配接口；同步getPersona、原guard、私有credential、source proof是必需契约。完整逻辑及爆炸半径见case七步。
失败路径：结构化code/error/hint，丢弃旧轮并在当前角色/来源版本重启；有失败分支测试。最终目的页UI尚待集成。
归属：原3文件主体由旧purpose_materials执行者预写，attempt1扩相对时序词与文档；attempt2集中修复F1–F3及回归/重新冻结；逐编辑原宿主事件unknown。
尚未验证：可信QQ/Pet事件接线、coordinator最终usedProofs绑定、UI错误呈现、真实模型及平台/设备。不得据此打开主动联系或宣称完整purpose parity。
交付：隔离树.local/evidence/purpose-materials/attempt2/artifacts/full.patch、attempt2.patch、case-increment.patch与精确files/newfiles，attempt2/freeze.json；原patch-01..10、attempt1冻结包与独立FAIL全部保留，等待attempt2独立审查。
```
