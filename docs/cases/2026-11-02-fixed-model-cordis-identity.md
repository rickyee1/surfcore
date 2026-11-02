# 固定模型宿主：Cordis facade 身份与服务撤销

## 现象与根因

真实隔离 DSH 在模型配置修订相同的两次媒体准备中均返回 `FIXED_MODEL_STALE`，尚未激活设备。固定模型检查把 `ctx.get('llm')` 返回对象的引用当作服务身份；实际 Cordis 每次创建新的 facade，因此正常服务也会被拒绝。此前对象字面量模型桩没有覆盖这层宿主协议。

本修补是固定模型宿主第 3 次有新证据的修补；不重置先前 T3-H / T4 的次数。真实运行先决检查由主会话在独立验收、部署后继续；本次没有调用真实模型、设备或平台。

## 完整逻辑

1. **链路**：DSH 中的工具结果与媒体宿主调用 `local-capabilities/fixed-model.js`，固定模型 pin 在准备、流式输出和最终交付前反复检查同一目标。实际 `Cordis Context.get` 经 `getTraceable` 返回 facade；`prepareCall` 仍通过原 facade 调用，保留调用者上下文。
2. **机制**：已安装 Cordis `lib/index.js:123–143` 每次 `new Proxy`，仅 `Symbol.for('cordis.original')` 稳定指向底层服务。`Service` 注册服务；`reflect.provide` 的 disposer 删除服务并经 `notify` 发出 `internal/service(name,value)`。同一对象撤销再注册不能恢复旧请求，因此另用仅监听 `name === 'llm'` 的单调失效代次；不会因其他服务通知撤销模型请求。
3. **影响面**：一个隔离 DSH 进程，两个固定调用读者，错误可见：`1 × 2 × 1 = 2`。更正身份比较不读凭据、不改用户数据、不增加调用或费用；实际服务变化仍使旧请求带 `code/error/hint` 失败。公开 target 的四字段、原配置指纹、原 handle、端点、超时和最终许可检查均保留。
4. **两条路线**：路线 A 比较稳定底层身份，同时保留 facade 执行与服务生命周期撤销，改动小、回滚单文件，采用。路线 B 缓存 facade 或解包后直接调用，会跨越 Cordis 上下文跟踪，且无法单靠对象身份识别同对象撤销恢复，不采用。未修改宿主 SDK 或 ASAR。
5. **生效**：修改只由插件宿主加载；验收后由主会话正常重启隔离 DSH。无需改安装包、profile、客户端或设备设置。本执行者没有重启服务。
6. **验证**：下列真实 Cordis、环境、工具和媒体回归证明成功与撤销边界；模型准备/输出仅为明确标注的合成 fixture。完整 Cordis 与 `LlmRuntime` 从安装 ASAR 只读导入，所有 Context 为空、无 adapter，子进程使用新临时 HOME/DSH_HOME 和环境白名单，网络入口禁止。
7. **回滚与残余**：备份在 `.local/backups/fixed-model-attempt3/fixed-model.js`。由主会话恢复该文件并重启隔离 DSH，可回到原先误拒绝的行为；不要撤销其他已验收补丁。真实部署中的媒体准备、图像先决检查及设备体验仍由主会话验证，不由这些离线结果代替。若本次独立验收再次发现此修补根因未闭环，停止自动改实现并报告。

## 实际契约证据

- Electron Node `24.21.0`。
- Cordis 完整源码 SHA256：`6a9394c0877ff45218818c6e815edd038f8057e1a1deb390a8d43ec81c57691e`。
- dsh-llm 完整源码 SHA256：`d18d8ae4c8d961e628708c1e4698e09716a0ebb80e55a672e0bde1029bec1155`。
- facade 创建：Cordis 84–89、123–143；服务读取 763–765；注册及撤销 800–820；通知 846–849；`Service` 1770–1783；`LlmRuntime` 1815–1816。
- 只把 `service[Symbol.for('cordis.original')] ?? service` 用于相等比较；没有对解包对象调用方法。无 Cordis 符号的原对象测试和普通聊天接口继续兼容。

## 验证命令与结果

```powershell
node plugins/surfcore/scripts/test-fixed-model-cordis.mjs --electron '<DSH Electron.exe>' --asar '<resources/app.asar>'
node plugins/surfcore/scripts/test-fixed-model-environment.mjs
node plugins/surfcore/scripts/test-tool-host.mjs
node plugins/surfcore/scripts/test-media-host.mjs
npm run test:audit
```

实际 Cordis 首次红例在未修源码下复现稳定服务 `FIXED_MODEL_STALE`；修后 10 项通过：新 facade 同服务、四字段 target、原 facade 方法调用、不同底层同配置、真实撤销/同对象恢复、准备 await 窗口撤销、无关服务通知、四类既有失效事件和 dispose 清理。错误断言同时检查 `code` 与非空 `hint`。

环境专项 9 项、工具宿主 29 项和媒体宿主 24 项通过，两个改动 JS 文件语法及 `git diff --check` 通过。`test:audit` 实跑 107/108；唯一失败为 `test-release-manifest.mjs` 检查已提交 R1 的 HEAD 清单尚未重建（桥接哈希及两个新增 R1 文件），不是固定模型行为失败。本执行者不修改共享清单，由主会话在最终提交流程处理；不把该次全审计称为全通过。

完整证据、红/绿日志、回归结果、diff、逐文件 SHA 和冻结快照位于忽略提交的 `.local/evidence/fixed-model-attempt3/`。新增真实安装协议测试为显式独立命令，不将本机 DSH 安装依赖塞进普通插件测试链；无需修改 package 测试索引。

## 可转发交接块

范围：仅 `fixed-model.js`、新增实际 Cordis 回归及本 case；保留 R1、媒体、角色包、语义和所有其他并行修改。备份和证据：`.local/{backups,evidence}/fixed-model-attempt3/`。无提交、部署、安装修改、凭据读取或真实模型/设备调用。待独立验收后由主会话重启隔离 DSH，再检查真实准备链路；固定模型宿主本修补计数为第 3 次。
