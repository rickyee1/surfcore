# 语义记忆进入聊天与本机管理（T2b-H）

主会话负责这次共享接线，避免与工具宿主执行者同时修改 facade、management 和 index；Python 索引来自已验收 T2b-P，渠道接线来自 `/root/channel_integration`。本记录只说明语义检索增量，不代替全项目完成验收。

## 完整逻辑

1. **链路**：QQ/桌宠取当前可信入站文本 → 原 binding/context → `semantic-context.js` → Python `memory.semantic.*` → 原上下文验证 → 有限记忆进入原聊天模型。`management.js` 在原本机 Cookie、会话头、Origin 和 loopback 检查后提供独立语义管理页；模型不能调用管理接口。来源纠正仍复用既有 memory 操作。
2. **机制**：默认关闭；空查询不启动任务，关闭时使用原最近记忆。启用后只截取检索问题前 1000 个 Unicode 字符，回答仍收到完整提问。单轮最多等待八秒、顺序检索四页，每页 64 条；保留原角色、主体、memory_epoch，跨 await 重验，不能通过重新取 epoch 放行旧结果。候选按相似度合并，用户确认的最近记录优先，最终最多 20 条。覆盖不全明确告知模型和界面，不把前 256 条称作全库结果。
3. **爆炸半径**：一个 DSH 宿主及一个本地能力服务，两个聊天渠道与本机管理页读者；失败显式中止本轮并提供 code/error/hint。查询和向量运算留在本机 CPU，只有当前主体允许的最终记忆会随已有聊天给所选模型，不改变公开 B站隔离，不访问设备。
4. **取舍**：在 JS 另建索引省一次 RPC，却重复来源/删除权威；直接复用已验收的 Python 分页任务，代码少且删除、纠正、受众和取消行为一致。选择后者。未采用自动降级到其他 embedding 或后台下载；模型不可用时页面说明处理办法。
5. **生效与重启**：需重启 DSH 插件和能力服务，QQ 桥接加载新 context/refine 接线；现有真实部署尚未切换。启用开关由本机页面保存；重启不会额外授予模型、工具或设备权限。
6. **验证**：`node scripts/test-local-capabilities-semantic-host.mjs` 18 项通过，涵盖原 binding/epoch、分页覆盖、超时取消、晚到 job ID、长查询、权限/角色变化、UI 纠正与旧回调。管理 wrapper/HTTP/SQLCipher 16 项和既有接线 20 项通过。真实浏览器在随机合成库加载 BGE CPU，查询“我偏爱猫咪”将猫的事实排在数据库事实前；纠正后旧结果清除，再查询显示修订 2/用户确认，并保留来源。证据 `.local/evidence/t2b-semantic-host/{host-ui-checks.log,cua-checks.json,ui-corrected-sources.png}`。未访问真实用户记忆或平台，临时页面/服务已关闭。
7. **回滚与残余**：完整备份 `.local/backups/t2b-semantic-host-root-attempt1/`，源码回退至接线前并重启对应进程；不删除数据库。实际部署 QQ/桌宠语义召回、冷启动性能与长时间观察尚待验收；本机开关/确认按钮不等于这些项目通过。

## 界面与失败路径

页面显示上次读取模型状态、索引覆盖、受众、每条修订和来源。可逐页查询/重建、取消、纠正、停止使用、删除。修改绑定原修订并要求明确勾选；角色/记忆变更或隐藏页面会取消原任务并清除旧内容。状态轮询不重建未变化的结果，保留正在编辑的草稿。失败可见且提供下一步，不记录查询或记忆正文日志。

## 可转发交接块

改动：semantic-context/client/management 页面、专属测试及 facade/management/index/渠道接缝；检查：18+16+20 项及真实浏览器合成库通过，独立验收与生产接线仍待完成；建议 minor，版本由发布会话确定；case：本文；层级：已存在语义 API 的聊天和管理接线，无新权限；完整逻辑见上七步；失败：超时/过期/模型不可用均 code/error/hint、原任务取消；未验证：真实部署、冷启动与长期运行。不是整体完成或发布声明。

## attempt2：绑定管理动作的原角色

独立审查在实际 UI→wrapper→HTTP→SQLCipher 复现：最后一次状态仍是 A，随后切到 B，旧页面保存开关却启用了 B。仅在客户端前后读状态无法限定服务端下一请求的主体。

现语义页把原 `expectedCharacter {id,epoch}` 作为请求前提传给管理入口。facade 在取得管理 binding 前后及提交前核对，固定该 binding 调用；不再通过新一次 `call()` 自动选择当前角色。返回前也核对，避免旧读取结果到达新页面。纠正/停止/删除的写入意图记录到原角色，拒绝同角色新 epoch 和跨角色操作；前提不是新授权，原后台管理准入不变。旧非语义调用仍兼容未传前提的契约。

新增 `scripts/test-local-capabilities-semantic-role.mjs`：第一项使用真实冻结 UI 与实际 wrapper/HTTP/SQLCipher，修前明确红；修后10项覆盖开关、纠正、停止、删除 × 跨角色/同角色新epoch及迟到 `session.bind`，错误均可见 `STALE_CHARACTER` 和 hint，后台操作调用数为0。attempt1冻结保留，attempt2证据在 `.local/evidence/t2b-semantic-host/attempt2/`。这仍属 root 共享接口的集中修补，待独立复验，不冒领执行子代理实现。
