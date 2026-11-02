# 本机固定工具 Broker：授权、持久执行与逐结果交付

日期：2026-11-02。任务 `/root/capability_service` T3 attempt1；基线
`0904c404b17f002171e1e51ce156365ef02f8639`。此记录是后端可评审实现，
不代表工具 UI、真实 Explorer、锁屏或模型/QQ 外发已验收。

## 完整逻辑

1. **链路**：受信宿主的协议 v1 opaque session_binding → Python core →
   ToolBroker → SQLCipher 许可/执行记录。time/notes 在权威事务内完成；
   files/固定 Explorer 在提交后的两个有界后台槽执行，再由主线程收结果。
   server 输入线程只读 JSONL，主线程每 50ms 检查结果、超时和 WTS；worker 不碰 DB。
   独立 tool_exports 处理管理 host 的逐结果交付。接口见服务目录 T3_API.md。
2. **机制**：原服务把每个请求包在 BEGIN IMMEDIATE 中，直接调用工具会令取消
   和紧停排在长任务后，也无法回滚真实外部动作。现在先提交 running+次数消耗，
   再启动适配器；对象身份、描述符、参数、策略和角色均复核。幂等键异参冲突；
   终态 CAS 丢弃迟到回调。重启把 running 置 unknown、不重放，待确认项取消。
3. **爆炸半径**：只改独立能力服务及专属测试、契约/归因/case。测试只用临时库、
   合成 UTF-8 文件、临时 junction/hardlink；Explorer 由 mock 截断。未读真实凭据、
   未启动真实设备/工具、未发网络/QQ/Bili消息；原 Luyao 只读。普通联系人、群聊、
   跨角色、共享 owner 记忆都不继承许可。管理结果与历史也是明确本机边界。
4. **取舍**：同步适配器改动少，但无法及时取消，也会把外部动作错误包装成可回滚。
   选择两个后台槽+主线程结果队列，持久权威集中且回滚简单；不引通用代码执行、
   shell、网络插件或任意动态工具。第一批仅 time.now、files.list/read_text、
   SQLCipher notes.create/list/read 和固定 local.open_directory。
5. **生效与重启**：加载服务 Python 新模块需重启独立能力进程；不需要更换密钥。
   表结构附加创建，旧记忆/attention 协议保持。session 内部保留 platform/account/
   conversation，记忆 audience 不变。备份 allowlist 不迁移工具许可、绑定、结果、
   根或执行记录，恢复会停用在途代次。root 单独负责宿主 UI/可信路由接线及部署。
6. **验证**：`.venv\Scripts\python.exe scripts/test-local-capabilities-tools.py`；
   同时跑 service.py 和 service-backend.py。定向覆盖：最后一次许可竞争、running
   更新/COMMIT 失败不启动适配器、原子便签、真实打开句柄读取、路径/UNC/ADS/../
   reparse/hardlink、确认后替换、迟到回调、紧停重启、真实 JSONL 取消/父退出。
   逐结果交付覆盖跨 QQ/pet owner 错配、同名 provider 改 endpoint、确认后变更、
   双 consume、提交后丢响应重启、跨 TTL、model-only 不含 private/记忆许可。
   最终通过：工具37项、原服务23项、backend31项；JS接线20项、桌宠16项、渠道18项。
   日志在 `.local/evidence/t3/attempt1/`；audit/regressions由root整合时执行。
7. **回滚与残余**：保留 SQLCipher 数据和独立 ledger；停服务后恢复本次备份源码
   `.local/backups/t3-attempt1-13561c069b554c6e9005a09601ac25e8`，新增工具表可留存，
   旧服务不读取。不要用旧 DB/删除 ledger 回滚。无真实 Explorer/锁屏/host 外发证据；
   WTS 无法验证时工具拒绝，紧停持久，复位不复活旧请求。

## 本机正文与两个用途

files/notes 正文默认只有 management result.read 能读，普通 status/history/execute
只有 result_id。time.now 描述符明确 public，可向原主体返回时间。工具读取不等于
云/QQ许可：管理 host 登记 opaque destination_ref，固定模型+非秘密配置修订+
endpoint 身份、原 platform/account/conversation、host_request_id/turn_id。UI 先展示
正文、目标、用途与旧不明交付，再精确确认；TTL60秒且确认不续期。

consume 仅 management host，提交一次性占用再回正文，不向普通模型工具/MCP暴露。
host 每次 await 后和真正外发前必须 validate 并使用准备时固定选择；切模型/端点/
fallback 必须新确认。model_input 可选组合原 private_reply，永不授 memory_write。
consumed 是 unconfirmed，sent/failed/unknown 收据不可改写；丢响应不重返正文。
本后端不发送网络，也不替 host 伪造模型选择/已送达证据。

## Windows 路径

管理登记绝对根，普通参数仅 root_id+relative_path。每个祖先和最终对象都用 Windows
句柄打开且不分享 DELETE，核真实路径/volume+file identity，确认后执行再核。文件
从同一已核句柄读取；拒绝 reparse 和多硬链接。目录不递归，扫描最多200项，路径
最多12段，结果最大64KiB、执行5秒。Windows DirEntry 缓存的 st_nlink 可能为0，
因此逐项以实际句柄 NumberOfLinks 为准，不靠缓存误判。系统 Explorer 路径来自
GetWindowsDirectoryW；固定数组参数、shell=False，环境变量不能替换可执行文件。

## 随批 T2b 必要接缝

root 明确追加授权的独立兼容改动：pending 返回 auto_write 布尔，关闭直接 episodes=[]
无写入；submit 允许0–6条，空提案也按现有来源 proof/epoch/consent 校验并事务消费，
避免同一无结论经历重复付费。两项独立 backend 断言；不放宽修订、删除或来源权限。

## T3 attempt2：poll 提交失败的权威回滚

独立评审复现了同一个根因的两个反例：锁屏 poll 的 COMMIT 被拒后，lock_state 和
检查时间已经前移，解锁后旧 export 又能取得正文；worker 结果的 COMMIT 被拒后，
队列和 jobs 已被消费，数据库留在 running。修前新增两项确定性测试均 FAIL，证据
`.local/evidence/t3/attempt2/before-fix.log`。旧 UI/Writer 工作区不回退。

修法保持原链路：poll 先暂存锁屏观察，只 snapshot 完成队列，COMMIT 成功后才发布
锁状态、检查时间、ACK 和移除 jobs。任何 poll 失败先锁存不可被同进程 reset 清除的
persistence_fault、同步 cancel 所有 job，再尝试 ROLLBACK；即使回滚本身也被拒，
工具/结果读取/导出仍立即拒绝。存储恢复后首个 poll 先持久 closed、增加策略代次、
将 running 置 unknown、取消待执行/导出，再释放已追踪完成项，不采纳其正文。

这是选择提交后发布而非重新排队已消费结果：保留单一主线程消费权威，可避免
重复回调和错误重放，不引入另一套任务系统。请求轮询与 idle 轮询使用同一闭锁；
core.close 的 finally 确保回滚失败也会关闭连接。新增三项定向反例覆盖 A/B 和
COMMIT+ROLLBACK 同时拒绝、故障后终态可读、reset 不能清锁、重启后旧导出不可复活。
同进程可读状态用于核验，正文必须先修存储并重启、再人工复位，不能直接重试旧任务。

定向与完整回归日志、attempt1→attempt2 窄补丁和基线完整补丁、最终哈希在
`.local/evidence/t3/attempt2/`。恢复源码备份在
`.local/backups/t3-attempt2-4441f7c823794d459eed0fbcd76beb09`；回滚仍须保留 DB/ledger。
实际验证：3项定向 PASS，完整工具40项、backend31项（含T2b接缝）、基础服务23项 PASS。
此修复不包含宿主全局紧停或实际 Explorer/锁屏/QQ交付验收。

## 发布交接块（编辑会话，无版本/发布动作）

- 现象：本机工具尚无独立许可、持久执行、取消与本机正文交付权威。
- 修法：固定七工具+SQLCipher Broker；提交后有界适配器；Windows 句柄路径；
  受信 host 的逐结果、逐模型/原私域用途确认；紧停/代次/unknown 不重放。
  attempt2修复poll提交前内存发布，持久化失败立即闭锁/取消，重启复位也不复活旧结果。
- 迁移：附加工具表，不迁密钥/授权；旧备份不会恢复工具许可；重启能力服务加载。
- 验证：三套 Python 隔离测试与现有 JS 接线回归；完整证据/patch/hash 在 ignored
  `.local/evidence/t3/attempt1/`；audit/regressions 由 root 整合门禁执行。
- 未验证：真实 Explorer、Windows 锁屏事件、host 模型/QQ组合交付，仍需可见验收。
- 回滚：先停独立服务，恢复本次源码备份，保留活动 DB/ledger；不删除用户数据。
