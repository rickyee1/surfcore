# 经历按来源整理为认知，普通聊天优先

任务：T2b-H attempt1 + 集中修复 attempt2。集成基线：`0904c404b17f002171e1e51ce156365ef02f8639`。本记录只覆盖宿主 JS Writer；Python 语义索引和工具聊天接线分别验收。

## 现象与原因

本地库已有经历、提案和原子提交协议，但真实聊天的入库尚未驱动语义整理。直接给它加定时模型调用会重复处理空库；整理在回复生成途中改变 `memory_epoch`，又会让正常回复被发送守卫取消。

本次由新经历通知宿主 Writer，在同一角色的普通回合结束后整理。模型只提议，受治理服务仍决定来源、修订、受众和提交是否有效。既有的人格编排、回复模型和发送守卫保留。

## 完整逻辑

1. **链路**：插件宿主创建唯一 `local.semanticWriter`。QQ 可信入站与桌宠聊天调用 facade 入库，附加可信用户/助手/外部来源标记；非重复写入只通知受众队列，不立即调模型。Writer 经 `memory.episodes.pending` 读取最多 8 条经历，调用 DSH 当前选中的模型，再按原始绑定、来源修订和 epoch 执行 `memory.proposals.submit/commit`。管理页由管理会话另行接入状态与显式整理按钮。桥接进程只通过已有认证 channel 路由建立/释放前台回合，不拥有整理模型或权限。
2. **机制**：默认 30 秒去抖，最多 32 个受众队列，宿主全局一次一个整理任务。前台读租约按角色而非单会话协调，覆盖 QQ 入站读取到入库、提示准备到真实发送结束、桌宠回复，以及自主陪伴轮次。新普通回合立即使旧 Writer 结果失效，普通回合不等待 Writer 模型。提交前再次检查租约和原 epoch，不刷新上下文给旧输出盖章。15 分钟仍未确认结束的回合显示 `WRITER_FOREGROUND_UNKNOWN` 并继续阻止整理；真实结束或正常角色/后端生命周期清理后才能恢复，不能为了整理取消聊天。
3. **影响面**：新增一个宿主后台文本调用路径，可能使用当前模型额度并新增本地认知；不启第二个聊天 agent、不调用工具、不读取人格文件/完整归档、不改核心人格。每次最多 8 条用户经历（每条最多 3500 字符）和 16 条同 scope 有限认知（每条最多 1000 字符），最多 6 个提案。不同受众不合并，主人记忆共享仍保留原始渠道身份。无法证明来自可信用户的旧经历、助手自述和外部材料只做空提案消费，不付费让它们推断共同经历。
4. **两条路线**：固定周期扫描实现简单，但会增加空库请求，也难以避开正在生成的聊天。本次选择事件驱动队列加前台租约，成本是少量生命周期接线，收益是空库不调用模型、聊天优先且来源变更可取消。没有选择独立长驻聊天 agent 或新预算体系；模型额度仍记入现有 `other` 预算。
5. **生效与重启**：宿主读取新模块，部署后由主会话正常重启 DSH；QQ 桥接的回合释放接线需要正常重启桥接。实现者未操作真实运行时。后端 local 且允许自动写入时自动整理；其它模式不会调用 Writer。角色/后端切换、主人映射变化与宿主退出清理旧任务。
6. **验证**：下节列出真实执行的确定性检查。模型只用有限结构化 mock，数据库是临时隔离 SQLCipher；不发平台消息，不修改用户数据库。真实 DeepSeek 与真实正常聊天由主会话部署后验证，不能用本次 mock 代替。
7. **回滚与残余**：正常停止旧宿主与桥接后，按本单元文件清单恢复实现前的备份，再正常启动。无需删除数据库，也不回滚用户记录；已提交认知仍可在管理页按来源检查、纠正或停用。备份在 ignored `.local/backups/t2b-writer-20261102-173622/`。回滚不能用旧实现继续发送已失效的在途回复。

## 数据与失败边界

来源标记用每个 event 独立的哈希引用，避免所有用户经历共用一个来源引用而被级联删除。模型看不到绑定令牌、渠道账号、模型凭据或任意文件内容。模型不能指定受众、角色、权限、pin 或未知目标；覆盖和失效只允许本批已见、同 scope、未固定的认知，并核查修订。

只接受严格 JSON 与正常 `stop` 完成。截断、工具完成、无 finish、未知字段/来源/目标、重复提案或超时均不会提交；不会自动换模型或重新计费重试。空提案是正常结果，按原子协议消费该批来源，避免重复收费。自动写入关闭时不调 Writer 模型。

身份、长期指引和关系投影还有保守的原话检查。关系投影必须归因于用户明确陈述的已发生事件，不从沉默、单句负面语气或愿望推断亲密度。这些约束不能证明模型摘要在语义上绝对正确；用户仍须能从管理页核查来源并纠正，不能把它当作新的核心人格。

状态包含 `running/queued/foreground/foregroundUnknown/scopes/lastError/lastRun/modelSource/dataBoundary`，不含来源正文或账号。错误保留 `code/error/hint`。前台未结束、模型失败、队列满等均可在管理状态看见；明确整理只重用已排队 scope，不能提交任意正文。

## 接口与检查

- `GET /dsh-surfcore/api/local-capabilities/writer/status`：读取状态；复用宿主插件认证与 Origin 保护。
- `POST /dsh-surfcore/api/local-capabilities/writer/run`：仅接受 `{}` 或 `{ "scopeId": "24位小写十六进制" }`。运行不绕过普通聊天租约。
- 管理页同会话 `writer.status/run` 调用同一个宿主实例；独立开发服务没有宿主模型时显示不可用，不另开模型通道。
- 认证 channel 内部 `turn.begin/turn.end`：可信渠道与 opaque context 绑定；`turn.end` 仅释放租约，不返回正文或修改来源。

已执行日志（均在 ignored `.local/evidence/`）：

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| `node plugins/surfcore/scripts/test-semantic-writer.mjs` | 22 组通过 | `t2b-writer-target.log` |
| `node scripts/test-local-capabilities-channels.mjs` | 18 组通过 | `t2b-writer-channel.log` |
| `node scripts/test-local-capabilities-integration-pet.mjs` | 16 组通过 | `t2b-writer-pet.log` |
| `node plugins/surfcore/scripts/test-autonomous-companion.mjs` | 32 组通过 | `t2b-writer-companion.log` |
| `node scripts/test-audit-bridge.mjs` | 16 组通过 | `t2b-writer-bridge-audit.log` |
| `npm run test:regressions` | 16 组通过 | `t2b-writer-regressions.log` |
| `npm --prefix plugins/surfcore test` | 通过，退出码 0 | `t2b-writer-plugin.log` |
| `npm run test:audit` | 107/108；唯一 release-manifest 与当前 HEAD blob 不一致 | `t2b-writer-audit.log` |

来源删除/纠正、提案后删除、提交前新前台回合、pinned、跨 scope、8+4 批次、普通 pet/QQ 真实函数入口、未知前台超时均有行为断言。全审计唯一失败为 `test-release-manifest.mjs`，当前工作树多单元并行修改，清单与 HEAD 的 `package.json` / `server.py` 等 blob 不符，已交主会话统一 checkpoint 时处理；未修改版本或清单以掩盖该失败。此单元未实测真实模型费用、真实发送或语义向量召回；不宣称它们已验收。

## 来源与发布交接

独立验收在 attempt1 定位预算异步窗口：`tokenBudget.block` 返回前关闭自动写入，旧正文仍进入模型一次，虽然后续提交会被拒绝。attempt2 先用隔离真实服务复现（`t2b-writer-attempt2-before.log`，模型调用 `1 !== 0`），再在预算返回后增加同步回合检查、原始 `memory_epoch` 的 `context.validate` 和同步检查；不刷新 epoch。新矩阵覆盖关闭自动写入、启动前台、角色变化，均断言模型调用及提案提交为 0。修后 Writer 23 组通过（`t2b-writer-attempt2-target.log`），渠道 18 组仍通过（`t2b-writer-attempt2-channel.log`）；其余 attempt1 有效证据保留，等待独立复验。修复只改 Writer 模型入口、专属测试和本 case。

需求来源：原融合计划记忆/关系章节、执行包 `.local/evidence/full-integration/t2b-writer-task.md`，协议来源 `services/local-capabilities/T2A_API.md`。JS Writer 与回合协调为本单元新增；Python 的 pending/空提案接缝由服务执行者交付，管理页与工具管理接线由主会话交付，不归本单元冒领。

```text
交接：T2b-H attempt2，基线 0904c404b17f002171e1e51ce156365ef02f8639。
内容：事件驱动有来源认知整理；角色级前台优先；有限无工具模型；严格提案与来源修订原子提交；结构化状态/手动接口。
部署：主会话正常重启 DSH 与 QQ 桥接；不需迁移/清空库，不自动启用任何平台。
验证：attempt2 Writer23组与渠道18通过；attempt1 pet16、Companion32、bridge audit16、regressions16、完整plugin有效证据保留；audit107/108，仅清单/HEAD blob不一致，交主会话checkpoint处理。
待验：独立代码验收与主会话真实DeepSeek合成经历/正常聊天；未由实现者重启或发送真实消息。
回滚：停止相关进程，按冻结文件恢复实现前备份，保留数据库和用户认知；禁止盲目回滚用户数据。
```
