# 自主公开浏览 → 想法 → 主人 QQ 私聊（T1）

基线 `e9d33b4`；日期 2026-11-02。用户要求继续实现自主陪伴，尤其自主逛 B站、形成想法后主动私聊自己。本单元实现这段闭环，不授权或启用 B站评论、动态、私信、群聊或陌生人投递。QQ 仍使用已验证的普通 `chat` 模式，不依赖 reserved2 的长回合。

## 链路与机制

宿主 `autonomous-companion.js` 是 local 模式唯一的主动协调器，复用 `purpose-engine.js` 的材料、候选、选择、排程和结果逻辑。既有 QQ purpose、早安、群主动调度与桌宠 purpose 在 guarded 模式退出；旧 B站 agent 的 `BILI_GENERATION_UNVERIFIED` 保留。桌宠和 QQ 的被动聊天不变。旧角色/后端的在途输出仍受原代次校验。

`bili-public-reader.js` 从固定官方 popular API 最多读取 20 个候选，用既有纯 `feed-core` 评分/去重/选择最多 3 条，本轮只研究其中一条。读取标题、作者、简介，并尝试官方字幕。API 只允许 `https://api.bilibili.com`；字幕只允许 HTTPS `aisubtitle.hdslb.com/bfs/subtitle/`，禁止账号信息、端口和跳转，全部 GET、不携带 Cookie 或 Authorization。每次请求 12 秒，普通 JSON 最多 512 KiB、字幕 1 MiB；字幕正文最多 6000 字符。缺字幕或字幕失败就明确降级为元数据材料，不能宣称看过完整视频。没有 CLI、watch heartbeat、通知、封面下载、抽帧或平台写操作。

研究与最终私聊分两次无工具 `llm.stream`：第一次只给本轮稳定来源事件的当前有效公开材料，不再给缺少完整来源证明的整个 `bili:public` 投影；第二次才给允许的主人 scope 投影（最多 12000 字符）和当前角色 core/tone（最多 6000 字符）。研究结果不能回流 B站外发动作，因为该模块没有这种动作。每次模型最多 1800 tokens、45 秒，显式关闭本机 SDK 已支持的推理，只有正常 `stop` 成功；缺 finish、max-tokens、工具结束、超长或超时均可见失败，不重试、不截半句。

研究前先用 exact audience 的 `context.sources` 读取稳定材料事件状态：deleted/suspended 直接拒绝；active 必须使用当前正文、记录 ID 和修订号，已更正的正文不会被新下载的旧材料拼回去。missing 后仍必须通过 ingest 的只读合法性检查，明确 AUTO_WRITE_DISABLED、同一 ctx 下仍 missing 才能作为本轮新鲜临时材料；临时材料不留下独立持久想法。

自动写入允许时，研究想法用 `derived_from` 绑定材料记录，并以 `source_revisions` 给出当前修订证明；Python 在 expected_memory_epoch 相同的事务内校验并保存证明。删除材料会删除派生想法，纠正会令旧想法停用/不可见；最终模型不能继续取得孤立旧想法。材料与想法写入后才取最终生成的双上下文；每次刷新必须等于该次写入返回的 epoch，并发纠错/删除不能靠新上下文认可旧想法。最终生成后不刷新上下文，发送仍校验原双 ctx。

关闭自动写入不豁免来源治理。Python 先核对角色内全局删除凭据、原事件存在性、递归可见性和修订，再决定 AUTO_WRITE_DISABLED。off 路径下，同角色全局已删拒绝；exact 停用或递归隐藏、仅别 scope 或 quarantine 存在同事件均拒绝且不回显 ID/正文，不能伪装 never-persisted。合法可见 exact active 由只读 lookup 复用；真正新的当前角色事件才允许临时材料。enabled 路径保留原按 scope 独立归档契约，不复制别 scope/隔离区正文；不同角色的事件不混用。

宿主签发 120 秒单次 opaque intent，内含固定正文、绑定主人及原双 ctx。桥接只接收 intent ID，不能接收调用者的目标或正文，拒绝浏览器 Origin、agent token/call。领取在任何异步验证前原子消费。实际 OneBot HTTP 前再次检查当前主人绑定、明确私聊白名单、角色/暂停/专注、chat 模式、当前机器人登录身份和好友关系，并经过统一 `attention.check → reserve → 身份/好友等待 → 原 ctx/运行态/策略复核 → transport → finalize`。身份等待必须先结束，随后才做最后 attention 检查；最后检查携带原 ctx 的 memory_epoch，避免等待期间的静音、专注或记忆修改漏过。宿主在签发/消费 intent 时重新核对 purpose 配置指纹、当前安静时段与主人的实时空闲；收紧配置或跨入安静时段都会取消旧轮次，不能只比较协调器自身设置。明确成功记 sent，平台明确拒绝记 failed，网络/回执不明记 unknown；未知不会补发、换渠道或刷新 ctx 继续。Finalization 本身不释放内容，允许在停止或记忆纠错后结算原预留，但仍由 Python 验证绑定和角色代次。

## 范围与取舍

路线 A 扩展旧 reserved2 purpose，代码表面较少，但会卷入旧完整材料、工具等待、20 分钟收尾和 local 提示替换；对现有 QQ 的回归风险高。路线 B 新增有界宿主协调器和窄投递 seam，复用纯 purpose 与统一账本，能逐段模拟和停用，不迁移已有数据；本次选择 B。该状态文件只存公开来源编号、材料范围、排程和结果，不复制主人上下文、最终私聊正文或旧私有 purpose 历史。

默认不开启；浏览间隔 60 分钟、每日最多 4 个主动尝试、冷却 90 分钟。既有 purpose 安静时段/空闲判断和统一 attention 的更严格预算、安静时段、衰减、专注仍生效；“立即运行”不绕过这些检查。配置可本机调整，但不能覆盖统一账本。每角色文件和进程执行锁位于 ignored `.local/local-capabilities/companion/`；跨实例不能并行生成，同一来源发送前先持久标记，崩溃后不自动重放。只在 PID 被确认不存在时回收锁，不按年龄抢活锁。

## 接口与操作

均复用插件既有 DSH 认证、回环 Host 与同源写操作规则。

- `GET /dsh-surfcore/api/companion/status` 或 `/config`：`{ok,config,running,local,nextBrowseAt,last,error,unifiedAttentionRequired}`；`last` 包含时间、BV、材料范围、是否实际入库和发送结果，不含主人身份或私聊正文。
- `POST …/config`：局部 JSON `{enabled,intervalMinutes,dailyMax,cooldownMinutes}`。仅这些字段；间隔 5–1440 分钟，每日 1–20，冷却 5–10080 分钟。启用是独立明确操作，不会启动 QQ/B站进程或改变平台开关。
- `POST …/preview {}`：只读候选/材料，返回 `source,basis,sends:false,modelCalled:false`；不入库、调用模型或发送。
- `POST …/run {}`：执行一轮，仍受所有排程和 attention 限制；返回 `outcome,source,thought,delivery`。没有任意目标、文本、工具或强制跳过字段。
- `POST …/stop {}`：持久关闭并取消本实例在途模型；其他实例在下一检查拒绝旧 revision。状态 `running` 可短暂显示清理中，已释放到平台的请求无法撤回，其结果按 sent/failed/unknown 结算。

未通过时 HTTP 非成功并带 `{ok:false,code,error,hint}`。管理 UI 应展示这些字段、运行中/下一轮/最近结果，并提供预览、明确开关和停止。统一主动联系未启用、主人绑定缺失、未收到当前机器人的可信主人入站或非 chat 模式时，都不能发送。身份、令牌、证据与实际运行配置只在 ignored 本机目录。

桥接内部 `GET /api/companion/readiness` 供宿主读就绪；`POST /api/companion/deliver {intentId}` 仅消费 host intent。它们沿用控制台鉴权，禁止 Origin 与 agent 调用，不作为前端直连 API。统一服务没有新增 TCP 监听或第二个 Python 进程。

## 验证、生效与回滚

新增 `plugins/surfcore/scripts/test-autonomous-companion.mjs` 使用真实隔离 SQLCipher 服务与真实 channel/LocalChannelBridge；公开 HTTP、模型和 QQ 均模拟，不访问真实账号或平台。覆盖公开域名/字幕限制、无工具两阶段模型、仅主人投递、真实桥接 HTTP 鉴权、默认关闭、跨实例竞争、持久去重、预算/安静/专注、纠错/删除与刷新竞态、自动写关闭、角色/后端/停止、intent 过期/重复/伪造、max-tokens/缺 finish/超时、预留后收紧、明确失败与 unknown 不重放。命令：`node plugins/surfcore/scripts/test-autonomous-companion.mjs`。attempt1 独立审阅曾以四个反例拒绝：派生想法未绑定材料、AUTO_WRITE_DISABLED 绕过已删源、身份等待后漏静音、旧 purpose 安静策略未重核。attempt2 先复现四例（`.local/evidence/t1-attempt2-reproduce.log`），随后修复；适配当前 imports 与新 thought 事件标识的原反例脚本显示四例违反数为 0。另用真实服务补齐来源有限矩阵，包含递归隐藏 active、跨 scope 删除、隔离区与 other-scope 的 off/on、other-role 新来源；不靠扩大 lookup 权限修复。

attempt2 新增及原链路合计 31 组检查通过；原审阅脚本的 18 组加四个反例共 22 组复核通过。定向命令日志 `.local/evidence/t1-attempt2-target-tests.log`，原反例复核 `.local/evidence/t1-attempt2-review-current.log`；既有 channel/pet 回归日志同目录 `t1-channel-regression.log`、`t1-pet-regression.log`。最终测试数量与完整结果以冻结证据为准。

宿主与 bridge 源码改变需分别正常重启隔离 DSH 和桥接；由主会话负责，不自动部署、启用或发送。本单元真实公开读取、真实模型与主人 QQ 主动消息仍 **NOT_VERIFIED**，需主会话执行受控一轮。本单元不代表 reserved2 问题、B站自动评论/发布、语音或全部 M3–M5 已完成。

回滚先调用 stop，等待状态不再运行，再正常停用新 timer/route；如需撤回代码，恢复对应备份并重启宿主/桥接。保留加密记忆、配置、状态、ACL 和备份；不删除用户数据、不恢复宽 ACL。旧主动调度不会在 local 中自动恢复为宽松模式。

发布交接：T1 新增公开读取器、自主协调器、模拟集成测试与本 case；窄改 index 注册、channel intent、LocalChannelBridge 发送、bridge 内部 seam 和 guarded 主动互斥、pet-purpose 互斥；attempt2 另局部扩展 facade.ingest 第四参 `derivedFrom:[{id,revision}]`。来源 ID、原子修订证明和 off 路径的只读检查接缝由 capability_service 工作者负责 Python，本单元没有编辑其文件；root 的管理页/备份改动不归本单元作者。不改版本、真实账号配置或共享文档，不提交或发布。最终 full diff、checks 和日志位于 `.local/evidence/t1-companion-*`，独立验收与真实部署由主会话接续。
