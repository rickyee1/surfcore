# QQ 本地发送边界兼容官方 MessageChain（R1 attempt1）

本单元基于 `fb5b97c`，只改 `src/bridge.js` 的 SDK 导入与本地消息形状转换，新增真实 SDK 回归。没有改 A01 harness、安装、生产 profile、模型、权限或版本，没有发送平台消息。旧 A01 失败及其分母保留；本修补不是 T1/T4 的重试。

## 完整逻辑

1. **链路。** 原生 QQ chat 完整回复 → `sendToQQ` 分条/入队守卫 → 官方 `text()` → bot 本地 wrapper → `onebotSendSegments` → 原 `LocalChannelBridge.sendFetch` → OneBot HTTP。真实 A01 三次模型正常 stop，但该边界拒绝消息，平台交付为 0。
2. **机制。** 本机 `@snowluma/sdk` 1.14.20 的 `text()`/`image()` 返回 `MessageChain`，它既非数组，也无单段的 `type`。原转换只接受 string/Array/type-object，因而在 HTTP 前报 `INVALID_REQUEST`。实际 SDK 实现见 `node_modules/@snowluma/sdk/dist/messages/chain.js`：官方类的 `toSegments()` 复制 items 数组；其公共 `normalizeMessage()` 同时接受结构化 duck type，不能不加约束地用于此处。
3. **影响面。** 仅桥接进程一个本地 SDK 形状边界。字符串、原 OneBot 数组/单段及 legacy SDK 路径保留；角色、epoch、收件人、TTL、来源、排队和最终发送校验仍由原链路负责。本次所有发送都到本机临时 HTTP recorder，使用合成身份/正文与真实隔离 SQLCipher，不调用模型或真实 QQ。
4. **路线取舍。** 直接调用 SDK `normalizeMessage` 最短，但会执行任意对象自定义 `toSegments()`，不满足边界要求。选择只接受官方类的精确 prototype 及其正常 items 数组数据属性，再直接调用**官方 prototype 方法**；不调用输入对象的方法或 getter。自定义结构对象、子类与伪造 items getter 拒绝，真实实例的覆盖方法不会执行。转换后仍进入原 OneBot 校验及发送守卫，不新增发信路径或重试。
5. **生效与重启。** 只有桥接进程读取这个边界，主会话在独立通过后按新的完整 SHA 正常重启。DSH、SnowLuma 与既有模型授权不需此修补变更；本执行者未启动或关闭它们。SDK 未来若改变官方类表示，应明确复核，不靠自定义方法兜底。
6. **验证。** `node scripts/test-qq-sdk-message-chain.mjs` 使用未改的原 harness 并注入实际 SDK 类/工厂；先红日志明确 `MessageChain/type undefined/INVALID_REQUEST` 和 native 0 HTTP，修后 6 组通过：原生 chat 回复、字符串/文本图片段/混合链、拒任意方法/子类、忽略实例覆盖方法、拒 items getter、收件人/缺 context/旧 epoch/排队会话撤销仍 0 外发。桥接 audit16、regressions16、channel18、tool-host29 通过；完整 audit 108/108 通过，命令退出码和证据在本批 manifest。
7. **回滚与残余。** 先正常停止桥接，再恢复本次源备份或窄补丁，保留全部配置、数据库、A01 失败与未知收据，不自动重放。回滚会恢复已知 MessageChain 不兼容，不能当作可继续发信版本。真实 QQ/真实模型与 A01 重跑由主会话负责；这里不声称平台或 A01 已通过。

备份：`.local/backups/r1-message-chain-attempt1/src_bridge.js`。证据和完整窄 diff/hash：`.local/evidence/r1-message-chain/attempt1/`。源码变更 7 行新增、2 行替换；新测试未改公共 harness。测试索引由主会话统一收口，不在本单元改 package。

```text
发布交接：R1 native QQ MessageChain attempt1，基线fb5b97c，待独立复核；无提交/部署/真实消息。
修改：bridge SDK导入+本地normalize边界；新增真实SDK/SQLCipher/loopback回归与本case。
行为：官方MessageChain经官方prototype转段，保留全部旧发送守卫；拒自定义方法旁路，无新增重试。
验证：新6、bridge16、regressions16、channel18、tool-host29；完整audit108/108通过，退出码见freeze manifest。
部署：root按新SHA正常重启桥接后再做真实/A01验证，保留此前失败。
回滚：停止桥接后恢复有界备份，保留配置/DB/收据，不重放旧回复。
```
