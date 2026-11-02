# P1：目的素材不能把旧经历当成刚收到的用户原话

2026-11-03，attempt1，基线 `9f456d24b3165773b805879a5d59912a1e6af1e2`。
需求来自原融合方案§5/6及只读设计 `.local/evidence/purpose-parity/analysis.md`
（SHA256 `f7abfcf0447306cf388fcc6286e9bfe176ddf8d51c18a7a39b2087a9a47ee6a3`）。
这是新增受治理来源元数据；没有修复、重置或恢复已停修的 T1/semantic attempt。

## 完整逻辑七步

1. **链路**：可信宿主的原始消息适配器→既有 stdio/普通渠道绑定→绑定专属临时 ingress
   token→同一 SQLCipher ingest 事务。`memory.materials` 先按现有受众 SQL 和递归来源
   修订闭包过滤，再返回有界记录及元数据。未来 JS 适配另行接线；本单没有调度器、
   人格、模型调用、桥接发送或实际部署。
2. **机制**：原库没有可还原事件时序。`revisions.actor=user` 是修订者，不是说话人；
   用户祖先也不能使派生正文成为原话。只有有证明的新原始接收记录服务时钟，明确是
   received，不是事件发生时间。重复、迁移、旧库、Writer派生及恢复都不重新盖时间。
   正常纠正保留原接收时间但变为 revised/nonverbatim；未跟踪旧 reader 改写则 unknown。
3. **影响面**：唯一能力服务、其普通素材读者与既有加密导出/备份读者。新增可选表，
   不改主 memories 字段、schema/min-reader/DPAPI、工具/媒体/attention策略。管理身份
   不能读目的素材；group speaker严格unknown，公开Bili不泄漏读取账号。新表不授新权限。
4. **取舍**：从当前时间、rowid或旧日志回填成本低，却会制造新近经历并错误归属。
   选择有真实证明才记录、其余unknown，代价是旧资料不能驱动时限型目的。快照用可选
   加密sidecar，六表逻辑counts不变，兼容原角色包；旧reader明确拒绝新sidecar，不默读。
5. **生效与重启**：独立验收后由root决定正常重启能力服务；旧行不补数据。宿主必须在
   真正可信入站处另行接线，不能把浏览器/模型给的actor当证明。未接线时旧调用继续
   unknown。本单没有重启实机、读用户内容、凭据、真实库或调用任何平台/设备。
6. **验证**：实际临时SQLCipher库覆盖新接收时间/身份与幂等、旧库升级、旧reader真实
   Store改写/删除/重建、用户纠正与派生、自动写关闭、跨scope/角色/management/旧token、
   隔离COMMIT拒绝原子回滚、新老快照/sidecar损坏/删除ledger优先及完整portable恢复。
   所有命令、初始装配问题、最终退出码和冻结哈希见
   `.local/evidence/purpose-parity/p1-attempt1/`；不以全仓绿替代专项证据。
7. **回滚与残余**：改前源码在该证据目录 `baseline/`。停止受影响写入后可回源码备份，
   保留活动库、删除ledger与原保护密钥，不回滚用户数据。旧reader会忽略活动可选表、
   但不能读取带sidecar的新备份；其未跟踪改写再次被P1读取时unknown，不能恢复旧原话
   证明。未来JS目的适配、group逐事件说话人、真实部署和完整purpose parity都未完成。

## 检查与来源

```text
.venv\Scripts\python.exe scripts/test-local-capabilities-metadata.py
.venv\Scripts\python.exe scripts/test-local-capabilities-service.py
.venv\Scripts\python.exe scripts/test-local-capabilities-service-backend.py
.venv\Scripts\python.exe scripts/test-role-package.py
node scripts/test-role-package.mjs
```

初次核心检查有两项测试装配问题，原日志保留：新事件误用已删除正文，实际正确返回
DELETED_SOURCE；SQL authorizer在早先poll编译COMMIT后未再次命中条件。修为真正新正文，
以及在真实写入后安装COMMIT拒绝（使缓存失效）；没有削弱删除或事务规则。随后核心
12项/原服务23项通过；增加current-frame与备份/角色包覆盖后重跑完整影响范围，最终
21项全部通过；原服务23、backend31、角色包Python12/Node22均通过，共109项。
精确命令、日志哈希及结果以checks.json为准。没有使用ignored baseline作为测试依赖，历史reader来自
固定git对象。schema_compat/portable_state/tool/media/JS/A01文件不在本次修改集合。

## 发布交接块

### P1 attempt2：旧reader来源帧修复

1. **链路**：普通materials投影、owner导出、backup/portable快照读取及correct/suspend
   的来源帧推进共用record_metadata验证；本次只修这条Python来源链，不改JS调用方。
2. **机制**：attempt1只在verbatim中比较原content_hash，且遗漏episode/非derived身份；
   旧Store合法改hash或重建派生类型后仍可留下可信来源。现将这些纳入完整有效性门槛，
   revise在更新前同样验证，失效帧在该次correct/suspend事务中清除，不能借后续correct
   重新贴回。另用旧Store回退已修正的revision/body复现ABA：只跳过更新仍会在合法纠正
   回到旧revision/body时重新匹配；清除失效帧阻断这条路径，COMMIT失败则整笔回滚。
3. **影响面**：一个服务进程的来源投影/快照读写，不新增权限、策略或外部调用；没有
   使用实际用户库。正常P1纠正仍保留原received时间但verbatim=false。
4. **取舍**：选择统一验证并拒绝推进失效帧，变更小且保留旧资料可读unknown；没有采用
   开库批量删除所有疑似行的路线，避免增加迁移写入和损失可诊断残留的风险。
5. **生效**：未部署/重启；仅在独立验收通过、宿主下次显式加载新服务源码后生效。
6. **验证**：实际9f historical Store两个原反例先红后绿；身份反例另拆kind-only、
   derived-only和组合三格。每格断言materials unknown、导出不带metadata、旧残留
   sidecar验证拒绝、合法correct清除失效帧，以及新备份恢复仍unknown。ABA例子另核
   拒绝COMMIT后原记录/epoch/旧帧一同回滚、下次成功correct清除且不恢复来源。运行上述
   metadata、service、backend、portable Python/Node命令；结果及哈希见
   `.local/evidence/purpose-parity/p1-attempt2/checks.json`，不重跑全仓audit。
   最终实际结果24+23+31+12+22，共112项PASS；原两反例及ABA均有真实exit1红日志，
   修后绿日志exit0。ABA前的111项初稿日志与源码留在pre-aba-draft，不冒充最终冻结。
7. **回滚**：attempt1九文件实际字节保存在attempt2/baseline，原FAIL包未改。回源码
   不回滚活动库/密钥/删除ledger；attempt1来源误认仍属已知阻断，不能据此部署旧版本。

attempt2发布交接：统一来源有效性、补actual historical Store回归；完整与窄差异、
冻结源码、红绿日志及实际检查结果保存在attempt2目录。无JS/真实API/设备/生产操作；
独立验收待完成，原T1/semantic失败与次数不变。编辑call ID未被工具接口暴露，原生
逐调用轨迹是否可导出为unknown；保存了实际apply_patch输入及前后字节，不伪造轨迹。

- 改动：record_metadata、storage/core/backup窄接缝，专属测试/API/provenance/case。
- 机制：服务received时钟与可信来源分开；未知留空；speaker与受众不同；修订/hash闭包
  和最新删除ledger权威保留；恢复不产生fresh时间。
- 接线：`services/local-capabilities/P1_METADATA_API.md`；私有open不进管理/模型白名单，
  普通materials读取不靠管理权限；目前没有JS调用方，新功能不自动启用。
- 验证：上述隔离专项与受影响回归，完整diff/manifest/checks在本单ignored证据中；
  未跑真实API、QQ、设备、实际用户库或全仓audit；状态为READY_FOR_REVIEW。
- 回滚：仅恢复受限源码备份并保留数据/密钥/ledger；不降级读取新sidecar，不自动回旧库。
- 残余：独立验收、可信JS ingress与purpose适配另行完成，不宣称完整目的机制通过。
