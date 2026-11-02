# 本机工具与权限管理页（T3-U）

任务：`/root/tools_ui`，T3-U attempt2（最多3次）；工作区 `D:/luyao_companion_v0_1/surfcore-luyao`，任务基线 checkpoint `0904c404b17f002171e1e51ce156365ef02f8639`。本执行者只拥有页面、客户端、行为测试和本文；共享入口已由主会话应用独立补丁，attempt2未修改共享接线。未改原 Luyao 目录、用户库、版本、tag 或 Release。

## 现象与根因

T3 服务已有固定工具、主体绑定、精确许可、执行历史与逐结果外发协议，原记忆管理页尚无对应入口。用户无法在本机核对实际参数、授权、取消、紧停、查看本机正文或确认已准备的固定交付用途。普通状态列表不能代替对具体请求及版本的明确确认。

## 完整逻辑（七步）

1. **链路**：可信宿主的精确 `/local-capabilities/tools` 路由 → `management.js` 现有本机会话、HttpOnly cookie、随机请求头、Origin 门禁 → 内联 `tools-client.js` 的真实 `mountToolsManagement` → 同一管理 `/api` → facade management → Python `T3_API.md`。DSH 实际前缀为 `/dsh-surfcore/local-capabilities`。现有记忆页和独立开发服务复用这个管理 handler；主会话接线补丁同时给出原记忆页导航与 DSH exact 路由。浏览器只读元数据、结果及精确确认，不具备原渠道执行或消费外发正文的接口。
2. **机制**：先顺序读取角色ID与epoch，再读取管理列表，列表全部返回后重读角色ID与epoch；前后一致才提交整批UI快照，核验期间禁用确认/授权。独立审查复现了旧版并行读status与列表造成“标签角色A、主体/根目录角色B”的混合快照；attempt2使这种情况丢弃整批数据、清除旧正文和核对、禁用授权，自动轮询不能解除，必须点击刷新后重新完整核验。稳定角色下保留未保存的分钟数、次数、路径和标签草稿。待确认执行保留所展示的 execution_id/revision/digest，不接收替换参数；轮询发现变更立即使核对失效。请求提交前同步占用按钮、记录本页已经尝试过的 id+revision；断网和旧修订都不自动重试。外发先点击 `result.read` 展示具体正文，再显示不可编辑的 descriptor、用途、期限、此前不明交付总数与最多20条ID，再要求勾选。confirm 只带 export_id/revision/digest；不 prepare、不换目标、不延长 TTL、不 consume。只有 model_input 的文案不暗示私聊回复；组合用途明确两跳及 memory_write=false。角色、代次、策略或锁屏变化会禁用旧核对，并清除已展示的旧私域内容。后端persistence_fault/recovery_required=restart会独立显示存储闭锁与重启要求，同时保留服务的code/error/hint；本进程reset按钮禁用，修复/重启/人工核验后才可重新明确解除紧停。
3. **爆炸半径**：1个本机管理浏览器 × 1个页面读者 × 可见报错1 = 1；下游服务负责真正的文件、目录、便笺和外发权限。页面没有设备采集、任意路径读取、模型请求、发送器、正文持久化、日志或 URL 导出。用户只有点击查看时才取回私域正文；目录登记只提交手工输入的路径和标签，不授予工具或外发权限。既有运行守卫由主会话保留。
4. **取舍**：A 为独立无依赖 DOM 客户端，静态 HTML 内联并导出同一挂载函数供测试；可复用现有风格，接口小，回滚只需摘入口。B 为直接扩充原管理 HTML；文件更长、并行改动会冲突且难以测试真实渲染。选择 A，代价是新增一个小客户端模块及独立测试；共享文件只给未应用 patch，不覆盖其他执行者。
5. **生效与重启**：主会话核对并应用 `.local/evidence/t3u/integration.patch` 后，重启读取 `management.js` 的隔离宿主并刷新页面。Python 新协议也需要重启服务加载。此实现阶段未启动真实用户库、Explorer、麦克风、截图或发送器；没有声称实机验证。
6. **验证**：真实挂载函数使用严格 fake-fetch 和 DOM 执行31项行为检查（输出以 `attempt2-ui-tests.log` 为准），覆盖明确勾选、精确载荷、旧修订、双击、断网、permission denied、未知状态、取消、紧停/重置、授权摘要、表单保留、根撤销、正文 XSS、时间公开结果、固定目标、model-only/两跳文案、TTL、已消费不重放、缺失不明交付元数据、交错结果读取、角色代次失效。新增中途切换角色/同角色epoch反例先红后绿（`attempt2-red.log`），断言混合快照不显示、0 grant/confirm、轮询不解锁、显式刷新后方可核对新主体；另覆盖最终角色核验未返回时按钮全禁用、持久化故障code/hint和重启门槛、缺失epoch拒绝。attempt1的regressions16项与完整插件测试通过，audit107/108仅既有release清单HEAD差异失败；attempt2完整复测以 `checks.json` 和 `attempt2-*.log` 为准，不改发布清单。共享接线由主会话完成，本执行者额外运行已接线的management测试；主会话仍负责浏览器实际页面验收。
7. **回滚与残余**：撤去 tools exact 挂载与导航，回退该补丁涉及的入口行即可关闭新页；现有记忆 UI 保持原 handler。新增四个文件可保留待后续接线，无数据库迁移或许可回放。真实锁屏/目录句柄/Explorer、模型外发、QQ私聊、浏览器布局与宿主路由集成均未由本执行者验证。原始状态为 unknown/unconfirmed 的记录只显示人工核验，不重放。主会话统一更新 ROADMAP/HANDOFF/PITFALLS/案例索引和测试注册，避免共享文档写冲突。

## 文件与证据

- `plugins/surfcore/lib/local-capabilities/tools-management.html`：静态同风格页面；仅 `__SESSION_TOKEN__` / `__API_BASE__` / `__TOOLS_CLIENT__` 占位。
- `plugins/surfcore/lib/local-capabilities/tools-client.js`：状态、核对、授权、目录、结果与固定外发用途 UI；导出 `TOOLS_UI_OPS` 和真实挂载函数。
- `scripts/test-local-capabilities-tools-ui.mjs`：无依赖 fake-fetch/DOM 行为验证，无真实库或设备。
- `.local/evidence/t3u/`：`full.diff`（当前四文件完整新增差异）、`repair.diff`（相对attempt1最小修复）、`manifest.json`（SHA256）、`checks.json`、`attempt2-*.log`。`attempt1/`保存上次冻结证据；`integration.patch`为上次接线建议，已由主会话应用，attempt2不再应用。

建议检查命令：

```powershell
node scripts/test-local-capabilities-tools-ui.mjs
git apply --check --reverse -- .local/evidence/t3u/full.diff
npm run test:regressions
npm --prefix plugins/surfcore test
npm run test:audit
```

页面白名单精确列于 `TOOLS_UI_OPS`；共享补丁在浏览器 handler 再核验所有 `tool.*` 操作，防止将来可信宿主扩展 facade 后间接开放 host-only 能力。禁止的操作包括 destinations.register/revoke、export.prepare/consume/validate/finalize、tool.propose/execute。页面不接收 provider 或 recipient 自由输入。

失败可见：当前页面 alert 同时显示 code/error/hint；读取失败显示“状态不明”，旧核对禁用。提供“刷新 / 重试读取”用于重读元数据；不可把响应丢失当作可重放确认。

## 可转发交接块

### 实际浏览器补验与第三次局部修补

主会话用真实 SQLCipher 随机隔离库，在 Edge 验证了具体参数核对、勾选后授权、服务 `authorized` 状态和显式本机结果查看。发现每五秒刷新重建执行列表，会移除正在看的结果。根因是结果 DOM 属于会被替换的列表行；仅延长轮询仍会丢内容，因此选择独立的本机查看区域。普通同版本刷新保留正文且不重新取数；结果版本、角色、策略或锁屏变化清除正文；用户可主动收起，迟到响应不能重新显示。

这是根会话 attempt3 的局部集成接管，主体页面与权限机制仍来自执行者。没有扩大许可或外发能力。源码修改后需重新加载页面，宿主读取模板的进程也需重启。新增三项行为检查后共有34项通过；窄补丁、哈希和浏览器证据见 `.local/evidence/t3u/attempt3-root-*`。回滚可用 `.local/backups/t3u-attempt3-root/` 中的三个修改前文件；隔离测试库保留，不触碰真实用户库。真实宿主投递、全局紧停联动、锁屏和 Explorer 仍由后续专项验证。

改动文件：上述四文件；attempt2集中修复混合角色快照并显示存储故障重启门槛，共享四文件接线由主会话完成且本轮未改；测试：DOM/fetch31项，完整复测结果见checks.json及attempt2日志；建议 minor（本批管理接口新增且原页面兼容，版本由发布会话决定）；case：`docs/cases/2026-11-02-local-tools-ui.md`；改动层级：管理 UI 与原接口兼容的修复；完整逻辑/爆炸半径见本文七步；失败路径有可见结构化提示及拒绝行为断言；未验证：浏览器布局、真实锁屏/Explorer/外发/用户库。交付状态为 READY_FOR_REVIEW，由独立验收决定是否接受。
