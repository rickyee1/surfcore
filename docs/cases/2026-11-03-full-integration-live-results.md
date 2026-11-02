# 完整融合实测：已运行链路与未通过项

事实截点：2026-11-03，Asia/Shanghai。运行版本 `9f456d24b3165773b805879a5d59912a1e6af1e2`，原生桌宠三文件补丁已整体应用；原 DSH ASAR 未改。**整体 FAIL / 尚未完成；没有启用自主外发。** 此记录汇编已有实测，不启动新模型、设备或平台发送。

## 链路与机制

隔离 DSH 继续作为唯一编排，QQ 桥接以 chat 模式运行，桌宠通过同一能力服务访问允许共享的记忆。受控工具依次经过提案、固定参数确认、本机执行、结果预览及外发确认；本机结果成功不等于模型/桌宠送达。实际 UI 与原生消费者回执按这个顺序核对。

原版 purpose 引擎仍完整保留，但本地协调器只接到“公开 B站材料→目的→QQ”的窄链。原功能还包括人格、聊天/记忆、目标、待续事项和反馈，以及无合适目的时静默。用户指出的缺口成立；恢复完整目的仍在实施，不能把新视频触发等同于原版全部机制。原版还有30分钟闲置默认门槛；用户已选取消此门槛，保留每日4次、90分钟间隔及23:30–08:30安静时段。取消门槛的待修源码尚未部署。

## 实际结果

| 项目 | 结果与限制 | 本机证据（ignored） |
| --- | --- | --- |
| 用户库升级与重启 | 实际 DPAPI/SQLCipher 升级保持原 key 和记忆摘要；min_reader=1；不是跨物理电脑恢复 | `full-integration/real-dpapi-upgrade-proof.json` 及升级/备份清单 |
| QQ/Pet共享记忆 | 桌宠真实保存合成代号；QQ第一次冷启动检索超时未答。显式重建后，主人再次提问，3秒收到正确代号，平台历史可核对 | `pet-shared-memory-live.json`、`qq-pet-memory-platform-readback.json` |
| Writer / CPU语义索引 | 真实模型 Writer 消费1条、提出0条认知，不宣称已验证认知提取质量；BGE CPU重建12/12，37.12秒，查询约0.71秒 | `live-writer-semantic-2026-11-02T16-32-53-764Z.json` |
| 本机时间 | 明确“现在几点”触发真实time.now，原生桌宠送达；另一种自然说法未命中工具分类，限制保留 | `pet-tool-time-live-receipt.json`、`pet-tool-time-request.json` |
| 文件读取与交付 | 仅合成测试目录。第一次结果确认超时被拒；新请求完成读取、固定模型外发确认及实际sent回执，memory_write=false | `pet-tool-file-expired-confirmation.json`、`pet-tool-file-live-receipt.json`、`tool-file-confirmed-live.png` |
| 便签 | 合成便签创建/读取成功，local_only，未导出给模型 | `pet-tool-note-live-receipt.json`、`pet-tool-note-read-live-receipt.json` |
| 角色包 | 浏览器实际下载57367字节加密包并核hash；认证二进制上传/同ID预览通过，new模式拒绝冲突。未stage/commit实际恢复 | `role-package-live-upload-preview.json`、`role-package-export-live.png` |
| 浏览器选文件 | 扩展缺少本地文件URL许可，选择器尚未验证；没有自动扩大浏览器权限 | 同上流程记录 |
| 语音/窗口 | 用户明确“暂时不测”，媒体enabled=false、leases=0。已核查所选Flash的图像请求前提；真实图像回答及设备效果未验证 | `media-deferred-by-user.json` |
| 主动联系 | 当前关闭。用户只批准过一次夜间公开内容私聊，额度仍未使用；完整purpose及发送守卫仍待验 | `live-progress-20261103-0110.json`、`state.json` |

以上证据均相对 `.local/evidence/full-integration/`；不把消息正文、账号、口令、Cookie、模型Key复制到跟踪文档。

## 两小时观察

北京时间11月2日23:52:22至11月3日01:52:28，共121个端点样本，实际采样跨度7200006ms。三个监听进程的PID及启动时间始终一致；记忆HTTP可用121/121，QQ健康且DSH就绪121/121，DSH页面120/121。第32个样本（00:24:24）返回401，随后恢复；没有把它解释成已证明的崩溃，也没有抹掉失败样本。DSH业务RPC不支持（404），业务健康字段仍unknown。

前20分钟21样本无用户输入，自主关闭，桥接/插件观测模型调用均0。后段包含记录过的真实Pet、QQ、索引和工具负载；桥接/插件遥测可重复记录同一事件，不相加为总账，也不代表覆盖全部Writer/Pet模型调用。两小时不等于24小时稳定性，不证明不存在内存泄漏，不接受尚未部署的工作区改动。

证据：`full-integration/observer-two-hour-result.json`、`observer-idle-completed.json`、`load-events.jsonl` 以及结果指向的完整samples.jsonl。

## A01 完整120次与盲评

冻结原版 `59ec3066f7d42a0452fae01f170c9a8484d5dbe5` 与融合版 `9f456d2`，30场景×2版本×2次，115 completed、5 timeout，94分14.770秒，观察到327次模型分派。真实原生QQ/Pet流程、平台为隔离传输，未对真实群发送。

两名独立评审在版本映射隐藏时完成60对、360个分项评分。原assess结果 **FAIL**：融合版A01-25-r2解释请求未交付、A01-28-r1第二条名字与口号请求未交付，均触发漏答硬失败。另有40项同渠道模型参数不一致、5次超时、5项未完成。未经筛选的原始统计为15/30不劣，但参数不一致使受控版本比较不成立；不得据此宣称融合版体验通过或作有效版本优劣结论。

所有失败和未交付输出留在分母，无重跑挑选。完整裁决及两位评审理由摘录分别见 `full-integration/a01-final-results.json` 与 `a01-rationale-excerpts.md`；原始匿名包、评分和映射文件路径/hash由结果记录。参数差异是否来自主请求、标题或Writer没有生产者证据，保留NOT_PROVEN。

## 新反例与尝试边界

- **semantic-host attempt3：FAIL。** 会话更替时在旧记录释放的await窗口紧停，仍能提交一个新模型请求；ready模式8秒预算在认证后重新起算。独立反例和完整冻结差异在 `.local/evidence/semantic-host-attempt3/independent-review.md`。
- **T1 attempt4：FAIL。** 本次用户追加的一次已耗尽。桥接重启使活动revision从0重新到1，存活的旧目的可能与新连接的revision撞值；真实LocalChannelBridge隔离反例发送1次而应为0。见 `.local/evidence/t1-attempt4/independent-review.md`。
- 两项失败源码没有被当作通过版本部署；继续修补的次数上限豁免尚待用户回答。更换会话、改名或新增purpose任务不清零旧计数。
- 完整purpose恢复是原范围尚缺的功能。P1仅增加受治理素材元数据，attempt2功能独立PASS；112项相关检查、root audit108/108及regressions16通过。独立复核关闭旧reader内容hash/派生身份和revision/body ABA反例；完整证据 `.local/evidence/purpose-parity/p1-attempt2/`。P1没有接JS或部署，也不替换以上失败验收；后续目的输入/单入口/载体接线尚未实现。

P1主体来自worker完整可应用补丁，主控负责集成与归档；独立验证保存的实现补丁准确重建最终模块。原生逐编辑调用事件及作者运行时归属接口不可读，单列NOT_VERIFIED，不以角色名/自述冒充宿主调用证据；provider/usage/费用未知。

## 影响面、取舍与生效

失败影响DSH宿主与QQ桥接的会话/最终发送接缝，涉及模型费用和主人私聊，不能凭HTTP健康或单元测试全绿宣称可用。P1影响一个Python服务及其备份/导入读取方，需要独立检查旧包、旧reader、删除闭包和角色代次，未经接受不得重启生效。

路线一是放开原两个目的loop，接线较短，但会恢复旧私域读取、双调度及双预算；路线二是在现单协调器接完整治理素材与原纯引擎，增加窄元数据/适配工作，保持统一权限和账本。采用路线二，保留现在的被动chat运行。没有把不完整功能包装成另一种已经完成的产品设计。

## 验证、回滚与残余

部署9f最后audit108/108、regressions16及725文件清单已通过；这些结论仅属于该冻结版本，不能覆盖dirty源码。此case为既有结果归档，无额外源码执行。所有后续源码仍需定向测试、独立反例验收、对应audit/协议回归及接受后部署。原始失败证据不可被新版成功覆盖。

运行回滚基线为9f及 `.local/backups/full-upgrade-20261102-224525` 一致备份；不能盲目覆盖运行库的新记忆。未接受的semantic3/T1追加4补丁已完整保存到 `.local/backups/unaccepted-semantic3-t1extra4-20261103-0217`，10个跟踪JS/测试文件逐字节恢复9f、2个新增测试移入同目录；hash、combined.patch和逐文件备份保留。P1 Python写集未触碰，未重启服务，未对共享工作区hard reset。后续获准修补应使用隔离修补树。SnowLuma由用户手动运行，不由本任务自动启动或重启。

剩余：完整purpose多来源/待续/反馈与QQ/Pet单载体；semantic/T1反例修复；A01发送失败和参数一致性；一次已批准的真实主动私聊；适用恢复/最终发布清单。设备实测由用户暂停，不能标PASS。

## 发布交接块

仅为事实归档，**不是可发布验收单**。覆盖运行版本9f456d2，代码版本号/tag/Release未变。当前整体FAIL；继续修补需保留失败证据和尝试授权。提交/推送仅限用户fork开发分支，不能发布上游或打包本机数据、凭据、第三方运行时。
