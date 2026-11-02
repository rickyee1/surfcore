# 本地中文语义检索：离线模型与可重建加密索引

日期：2026-11-02；任务 `/root/capability_service` T2b-P attempt1；基线
`b31ce80f76b59ab45e7955b40590801f306c8b17`。后端独立可评审交付，不代表
宿主聊天/UI、真实用户库或全方案已验收。

## 完整逻辑

1. **链路**：受信 session_binding → core → semantic_index（主线程/SQLCipher）→
   提交后 semantic_runtime 的单个有界 I/O 工作单元 → 懒启动 semantic_worker。
   worker 只收当前允许文本的匿名 pipe 批次，不接收角色库路径/密钥，不操作 DB。
   返回512维向量后，由主线程再次核角色、binding、记忆代次、正文修订和递归来源，
   才提交缓存与排序结果。现有 JSONL 主循环仍每50ms轮询工具，推理不占主事务。
2. **机制**：关键词子串不能识别中文同义，原 Luyao 的向量侧库也不适合此服务的
   SQLCipher/删除/受众权威。新索引只是可重建缓存，存模型 fingerprint、正文hash、
   record revision 和递归来源hash。普通查询先按角色+session/public SQL过滤，再核
   递归可见性，最后才给 worker 文本或做 cosine 排序，禁止全局检索后过滤。
3. **爆炸半径**：只改能力服务的四个现有接缝与新增专属模块、模型声明、可选依赖、
   测试和本case。未改JS/版本/共享文档，未访问实际用户记忆/凭据，未联网或下载，
   未操作设备或真实工具。测试只用临时SQLCipher库、合成中文和已准备的模型资产。
   T3代码未改；仅复用其闭锁状态，语义检索不会给群聊/公开来源增加本机工具权限。
4. **取舍**：主线程加载/推理实现少，但会挡住紧停和取消，不能采用。单线程直接
   丢弃结果更省进程，但不能及时结束长加载/CPU工作。选择懒启动本地CPU进程，
   后台I/O写pipe/读响应，主线程只提交小结果；取消不等待模型。进程回收也用一个
   有界清理消费者，不在主线程等待、不为每次取消无限生线程。没有新聊天/定时LLM。
5. **生效与迁移**：重启独立Python能力服务加载，附加 semantic_policy/vectors/
   sources/jobs 四表，SQLCipher/DPAPI/key和旧memory.query不变。每角色默认关闭；
   enabled配置只有布尔值，没有模型路径/供应商参数。关闭或空闲时不跑推理，空查询
   直接使用既有可见近期记忆。可选包见requirements-semantic.txt；不装仍可用基础记忆。
6. **验证**：专属semantic测试包含真实CPU同义中文/无关内容、同模型重建、隔离
   scope/角色/群聊、递归隐藏投影、增量经历/Assertion、64页稳定性、迟到删除/纠正、
   取消/紧停/锁屏/超时、坏模型和无依赖、pipe批32及不传DBkey、模型进程回收、
   SQLCipher持久缓存与旧快照删除ledger、semantic自身COMMIT失败闭锁。真实首检
   相关得分约0.670522，无关约0.178193，重建排序与分数一致。最终命令/结果/原始
   日志在 `.local/evidence/t2b-semantic/attempt1/`，不把夹具模型当真实语义成功。
   最终通过：semantic22项（无跳过/清理警告）、T3工具40项、backend31项、基础服务23项；
   现有JS接线20项、桌宠16项、渠道18项。
7. **回滚与残余**：关闭语义开关，停独立服务，恢复备份
   `.local/backups/t2b-semantic-attempt1-67825157bd214c65943313e3d602a681` 的接缝源码；
   附加表可保留，旧服务不读，不删除DB/ledger/密钥。host/UI接线、实际聊天效果和
   大规模性能仍需独立验收；本单没有部署、外发或修改真实记忆。

## 模型和数据边界

固定 BAAI/bge-small-zh-v1.5 revision
7999e1d3359715c523056ef9478215996d62a620。semantic-model.json 保留11个本地资产
的精确SHA256与大小、512维和算法版本；worker先核所有资产和链接，再导入ML包。
local_files_only=True、trust_remote_code=False、use_safetensors=True，禁用Hub
网络与telemetry。CPU线程2。只复制归因概念，没有导入原Luyao的Embedder/Qdrant模块，
不使用其下载重试，也不产生明文向量侧库。来源文件hash记录在provenance.json。

查询最多1000字；记录先切<=3500字段，每个匿名批最多32段；worker按480 tokens
进一步切分并归一化平均，避免模型512上下文静默截掉长文尾部。每页最多64条，
排序固定pinned优先、新rowid优先。超过64条明确返回has_more/next_offset/page-only，
后续页必须传首个任务的memory_epoch；有变化整次分页作废。受众候选最多4096条、
来源深度64/每记录256节点，超限报错，不冒充完整命中。单全局在途槽，任务120秒
超时；最多64条终态元数据，队列/结果均有界。

management默认仍session，只有明确audience=character可跨当前角色范围；quarantine
不参与。任务status/cancel只允许原opaque binding，management不隐式读取别人的任务。
scope/来源隐藏的条目不进入worker、得分、计数或结果记录。工具权限不因共享记忆改变。

向量、递归来源关联和任务元数据都留SQLCipher。cache在来源纠正/停用/删除时清除，
新独立记录保留其他有效cache。晚到worker结果不能改变取消/失效终态；memory_epoch/
character_epoch及来源hash再核，不得复活删除。恢复事务先清当前角色vector cache，
再合并最新独立删除ledger；旧快照不迁移vector/model/工作进程/工具许可。

## 实现中定位与验证

首轮隔离检查发现把工具Broker的主体许可直接用于memory查询会误拒群聊自己的
记忆；修为仅复用紧停/锁屏/持久化闭锁，受众仍走原记忆权限。定向群聊隔离通过，
未放宽任何本机工具。首次真实模型检查同时暴露子进程/pipe回收警告，修为最多2个
待回收进程的单消费者，并补真实pipe回收断言；没有等待模型的主线程路径。

## 发布交接块（无版本或发布动作）

- 现象：现有子串/关键词无法提供中文同义召回，模型不能在主事务阻挡T3取消。
- 修法：固定本地BGE CPU模型；先受众/递归proof后嵌入；SQLCipher派生vector缓存；
  显式异步start/status/cancel/rebuild、page64和epoch分页；取消/删除/恢复均不重放。
- 接线：精确API在services/local-capabilities/T2B_SEMANTIC_API.md；默认关闭，UI须
  显示页范围/结构化错误，普通memory.query不变。host接线单独验收。
- 验证：Python专属semantic、T3工具、原服务、backend与现有JS接线；最终日志与
  full.diff/freeze-sha256.json在ignored证据目录；audit/regressions由整合会话执行。
- 迁移/重启：附加4表，重启能力服务；可选embedding依赖，不迁密钥或向量侧库。
- 回滚：恢复源码备份并保留活动SQLCipher库、DPAPI和独立删除ledger；不回滚用户数据。
