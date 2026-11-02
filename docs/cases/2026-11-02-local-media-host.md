# 本机语音与窗口宿主：T4-H

本单元为既有桌宠增加受控设备页、按键转写显式发送、免提逐回合交付、同帧窗口问答和单一 Windows SAPI 输出。attempt1 独立验收发现转写 SDK 等待窗口及迟到音频播放两处缺口，已在 attempt2 集中修复，当前状态为 **READY_FOR_REVIEW**；真实麦克风、播放、窗口、锁屏、模型及已安装原生客户端的整链路仍 **NOT_VERIFIED**。Python 媒体 authority 的独立验收由其任务包负责，未放行前不启用实际设备。

## 完整逻辑

1. **链路。** DSH 已鉴权的 `/dsh-surfcore/local-capabilities/media` → 同一管理 session/Origin 的 `media.host.*` → `media-host.js` → 私有 stdio `media.*` → 原 Python authority/有界设备 worker。主体固定为现有 pet 服务的真实 binding，浏览器不能给 subject、模型、上下文、收件人或正文替换值。最终模型调用仍用宿主 `llm.prepareCall` 的同一配置快照，经原 pet 的受守卫事件及真实 HTTP 完成回执交付。QQ、B站发送与调度未改动。
2. **机制。** 设备只在明确准备、显示后端原 targets/purposes/deadline、确认、启动之后工作。页面 session 首次状态绑定原角色与 epoch；后续请求在实际 binding 等待前后校验，状态刷新不能把 A 页批准换到 B。每个媒体结果先绑定原 context/epoch 与固定模型，再单次 consume；每段免提都是新 input/turn/delivery。所有媒体输入和派生回复均不写记忆、不进 DSH/Pet 历史或 Writer，不授予工具。模型可以读取**已取得的同 pet scope context.text 投影**，Unicode 上限 8000，裁剪状态可见；本次完整转写/问题优先，不读取其他历史、日记或原始 DB。输出不截半句，只接受正常 `stop`，超限/截断明确失败。
3. **影响面。** 现有 DSH 插件进程、私有 Python、受控设备子进程及原生 pet 消费者。潜在外部效果是明确批准的转写/同帧发给固定模型，以及本机声音；本次测试全部使用合成设备/内容、loopback HTTP 和模型 stub。没有读取实际账户凭据，没有启用设备、真实模型或平台消息。私有数据仅在当前内存和本机可见预览中存活，停止/换角/过期/新输入取消后不重放。
4. **路线取舍。** 浏览器直接采集并另连模型虽少宿主代码，但会复制身份/权限、绕过当前 authority，且无法可靠约束同帧和单输出。选择复用 Python authority、T3 固定模型与原 pet 事件。SDK 已声明图像能力，却仅有持久附件入口；把屏幕写附件再删除仍违反无历史边界。改为精确版本的两模块内存接缝：只有显式单帧 symbol、prepared 模型实际 `inputModalities` 和协议标记同时成立，才接受同 PNG/hash/尺寸，强制 inline，跳过 Files API 和扩展诊断。普通附件路径保持原逻辑；无补丁/版本不符明确失败，不换模型或持久附件。主会话负责隔离启动的内存 preload 部署方案；本执行者没有改安装 ASAR。
5. **生效与重启。** DSH 插件需要正常重启。`scripts/patch-dsh-media-sdk.mjs` 只生成离线源副本，拒绝未知 SHA 或已存在输出目录。原 SDK SHA：LLM `d18d8ae4c8d961e628708c1e4698e09716a0ebb80e55a672e0bde1029bec1155`，DeepSeek `21fedb71f8d9aafea73b35ee13bc73737a8271d7ffa261697d4208e8563196cb`。`scripts/patch-surfpet-media.mjs` 只接受已应用 T3 无历史消费者补丁的 dist SHA `edfa3310fa558fcdd02a476b7ed1818ff25aa0636d72f0e2573321ad91b7a9c3`，生成离线主文件；主会话备份、审核后才可应用到自有 pet 并重启。没有部署、提交、版本或用户 profile 写入。
6. **验证。** 下表列实际运行检查。authority 使用真实隔离 SQLCipher、合成 WTS/设备 runtime；测试在导入路径模块之前设置临时 DSH_HOME/SURFCORE_ROOT，不碰用户配置。SDK 检查执行精确源中的 `prepareCall` 与完整 DeepSeek adapter 请求/序列化，导入的外围宿主服务用确定性夹具代替；HTTP 只到 loopback 记录器，返回合成响应，不调用真实模型。
7. **回滚与残余。** 先在设备页“停止全部”或紧停，确认捕获与输出退出；保留数据、许可/未知收据和备份。撤下隔离 preload 后窗口上传明确 unsupported；恢复经核验的源码/自有 pet 备份并正常重启，不自动重播、不恢复租约、不复用旧 ACK。不得降级成持久截图、旧 voxd fallback 或放开任意工具。实际设备权限、声音质量、原生客户端安装、锁屏/硬件热拔插及完整 M4 验收由主会话和用户后续处理；本记录不宣布全部 M0–M5 完成。

## 可见控制与单输出

页面需持续可见，每 250ms 提交可见心跳；宿主只把同一页最近不超过 750ms 的 heartbeat 转为原 lease pulse。隐藏、页面失联、重载、角色/固定模型/权限变化、stop/dispose 都取消旧回合；不以后台无条件续租恢复。后端独立 watchdog 与原签署期限继续生效。按键松开只结束采集并等本地 ASR，之后核对预览、准备固定交付，再点“发送”；窗口 Ask 同样只消费已预览 hash，不重截图。窗口单帧或明确 60 秒内最多 3 帧，后续帧也需显式捕获和核对。

选择 SAPI 后，宿主抑制旧 TTS/audioKey，失败不回退。每次 configure、reset/stop、原生 clientId 重载和角色变化都会作废旧暂停 nonce。**原 pet-token API** 只接受当前 nonce 的暂停 ACK，不授予设备权限；管理页面不能冒充这个 API。离线 dist 补丁在原 pet 的两个已存在音频 renderer 上执行 pause、清 src、load，全部 Promise 完成且原配置仍相同后才 ACK。没有当前 ACK 时 output/handsfree 的 start 返回 `MEDIA_LEGACY_OUTPUT_ACTIVE`，不会用固定延时冒充暂停。原有外部提供方配置保留。

原生菜单增加固定“本机语音与窗口（需明确授权）”入口，只打开已发现的 loopback DSH 页面，不附令牌。媒体输入/派生回复仍在原桌宠显示；T3 的 memory_write/suppressHistory 消费者契约继续保留。

## 结果与证据

证据均在 ignored `.local/evidence/t4-host-attempt1/`；未发布 SDK 源副本或任何运行数据。

| 检查 | 实际结果 / 证据 |
| --- | --- |
| `node plugins/surfcore/scripts/test-media-host.mjs` | 23 组通过，`host-test.log`；含真实管理 wrapper/session/Origin、pet HTTP/ACK、跨 scope 记忆、TTL、新输入/角色/模型/stop 竞态、晚 ASR、unknown 不重放、单输出 |
| `node scripts/test-local-media-client.mjs` | 真实 HTML/client 的 DOM 夹具通过，`client-final.log`；目标/摘要、快速松键、busy/错误恢复、隐藏与晚回调、无正文替换 |
| `node scripts/test-dsh-media-sdk.mjs` | 12 组通过，`sdk-test.log` 与 `sdk-loopback-proof.json`；同 PNG inline、0 Files/磁盘附件/扩展诊断、错 hash/ref、过期/撤权等待、prepared 单次与普通附件回归 |
| `node scripts/test-surfpet-media-patch.mjs` | 精确离线 dist VM 通过，`pet-patch-final.log`；两个 renderer 确认前无 ACK、陈旧/丢 renderer 不 ACK、无历史/旧音频、固定 loopback 入口 |
| 工具宿主 / pet adapter 回归 | 29 / 16 组通过，`tools-regression.log`、`pet-regression.log` |
| `npm --prefix plugins/surfcore test` | 已运行通过，含新 host/client/env 测试；最终合并树记录见 `plugin-test-final.log` |
| `npm run test:regressions` | 16 组通过，`regressions.log` |
| `npm run test:audit` | 107/108；唯一发布 manifest 与当前 package.json HEAD blob 不匹配，见 `audit.log`，由主会话最终 checkpoint/清单收口 |

共享归属：management.js/html 的媒体精确挂载和导航由 root 按本单元契约机械接线；T5 package gate 的 pet/index/facade 及错误透传来自 capability_service/root，保留并单列证据，不冒领。root 的隔离 SDK preload 为独立部署贡献。T3 F3 环境快照修复有独立 snapshot 与窄补丁；本单元只在该修复之上扩展 image 支路，target 原四字段形状不变。

```text
发布交接：T4-H attempt1，需独立复核后才可用户激活设备；无版本/提交/部署操作。
新增：media-host/client/management页、SDK/Surfpet离线精确补丁、对应host/DOM/SDK/原生VM测试。
接线：原pet事件/真实HTTP收据、单输出ACK、同scope共同记忆投影、原epoch固定模型；QQ/B站不改。
配置：默认不开设备；每次精确准备/确认/启动，PTT预览另Send，免提每turn新许可，窗口同帧Ask。
检查：host23、SDK12、DOM/原生VM、tools29、pet16、regressions16及plugin通过；audit107/108清单差异交root。
部署待办：root受审preload与自有pet备份补丁、正常重启后，由用户在可见设备页显式授权实测。
回滚：先停止/紧停并等待worker退出，保留数据库/未知收据/备份；去除preload与恢复精确自有pet备份，不重放旧任务。
```


## T4-H attempt2：文字同许可、原生持续播放代次

本次仅修独立报告 F1/F2，保留 attempt1 全部 snapshot/manifest 与先前有效结果。F3、T5 和 root 的 preload 来源不变，不触 Python、共享 pet/index/facade 或安装文件。

**先红证据。** critical 提供的真实 SQLCipher + 完整 adapter 反例经当前源码复现：resolveAuth 等待期间跨入不可见 751ms 或发生一次真实 local.ingest 后，两个场景均仍有 1 次含合成转写的 HTTP；`f1-before.log` 将期望改为 0，结果红。原生实际 ChatHost 的 did-finish-load 闭包在 pause ACK 后释放，执行实际 bubble.js 的 audio.play=1；`f2-before.log` 同样红。回归源在 critical 反例基础上扩展，原反例归属独立审阅者。

**F1 根因与修法。** 原 image=null 的转写走普通 SDK 分支，仅图片带许可；模型前检查无法约束其后的 credential/extension 等待。现在媒体文字与图片均必须带 prepared-only 单次 symbol permit。转写也不触 extensions、诊断回调、Files 或历史工具路径；普通非媒体聊天/附件逻辑保留。SDK 在所有认证/序列化等待后重新执行原 job/subject/context/TTL 异步 guard，并在该 await 之后、真正 fetch 紧邻处执行同步 guard。没有受审媒体协议的模型在 consume 前明确失败，不借普通 text fallback。原 T3 四字段 target 没有扩权或换 endpoint。

**F2 根因与修法。** 一次 pause+clear-src 只影响当下播放器，不能撤销旧 load 闭包、120ms 自动播放或旧按钮。现在精确补丁覆盖原 `main.js`、`bubble.js`、`dialog.js` 三文件：两个 renderer 默认 closed，只有 main 安装单调播放代次后才可播放；每次实际 play 同时检查当前允许状态与原消息代次。旧代次不能回滚或重开已拒绝的许可。main 的请求在任何网络 await 前捕获代次并给 reply/events/history 标记；迟到 HTTP 与 did-finish-load 不采用新代次洗白。main 只在当前全部 renderer 确认持续门禁已生效后 ACK，renderer 重建仍从 closed 开始。旧按钮被禁用/隐藏；当前有效普通语音的正向播放仍通过。

**部署边界。** 三文件必须整体应用，不能仅更新 main。`patchPetMediaBundle` 先验证全部原始 SHA 再返回全部离线字节：main 输入仍是已审 T3 基线 `edfa3310fa558fcdd02a476b7ed1818ff25aa0636d72f0e2573321ad91b7a9c3`；bubble 原 SHA `0345c43b6a3bc9ff0443b51fd165c5e14522b8a2e955c1afe06134c6481b2b94`；dialog 原 SHA `6d0a8d805448305f06ff40d03594fb7956153c45cb7d887eaf3e13252024fe86`。未知版本拒绝，不在已安装应用中原地试错。完整离线文件/最终 SHA、SDK preload 依赖和步骤见 ignored `t4-host-attempt2/DEPLOYMENT.md` 与 manifest。主会话负责正常停止、整体备份、三文件应用与实机；本执行者未改安装目录。

**集中验证。** `test-media-text-sdk.mjs` 的 5 组实际 authority/全 adapter 检查仅活许可=1 HTTP，其余 auth 跨 visibility/epoch、最终 async guard 后跨 visibility/role 全部 0 HTTP，且媒体文本 0 extensions/diagnostics/files。SDK 原 12+文字 3=15 组通过，普通附件分支仍走原 Files/附件服务。实际 main+bubble/dialog VM 的 7 组通过，含迟到 load、120ms、按钮、晚 HTTP、重建、旧许可拒绝和有效普通播放。实际 Electron 隔离 preload 12 组重新通过，安装 ASAR 前后 hash 一致；没有调用真实 provider、设备或平台。其他受影响回归和命令退出码见本批 freeze manifest 与日志。

**路线、回滚与残余。** 若仅在 host 发出模型前再校验，或只在 ACK 时多 pause 一次，原 await/load 窗口仍在；故分别选择真实 fetch 边界和实际 renderer play 边界，有界修正原根因。回滚必须先停止设备/待发回复，保留数据库与未知收据，整体恢复三文件备份及受审隔离启动设置；不能留下 main/renderer 混用，也不重播旧任务。本修补仍不代表实际麦克风/播放/窗口/WTS/真实模型与已安装原生整链路已验收。

```text
发布交接：T4-H attempt2，仅F1/F2，待独立复核；未提交、部署或启设备。
主修：媒体文字/图片统一prepared单次许可，SDK fetch前async+sync；main与两个renderer持续播放代次。
必需整体原生包：main.js+bubble.js+dialog.js，离线生成/准确SHA在本批DEPLOYMENT与manifest。
证据：f1-before/f2-before先红；f1-after 5、SDK15、native-late7、preload12及受影响回归，完整命令/结果本批日志。
回滚：先停媒体，整体恢复备份/移除隔离preload，不重放旧许可或未知收据。
```


## 2026-11-02 部署显示修正

实际状态页尚未执行模型 prepare，不能把默认 false 当作已确认不支持图片。状态 current_model.image_capable 现为 null；真正准备窗口仍检查原 prepared 模型能力和已审 SDK 协议。主会话只将模型/设备状态改为可读文字，不改授权、采集或发送。已有 DOM 检查及媒体宿主24项通过，独立限定复核 PASS。实际设备和当前模型图片请求仍须另验。
