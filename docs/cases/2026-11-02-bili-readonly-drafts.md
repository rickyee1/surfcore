# B站公开资料读取与本地评论草稿

日期：2026-11-02。用户选择扫码接入、读取内容和生成草稿。QQ chat 与桌宠已通过的链路不在本次修改范围；B站 自动回复、自主发布仍未授权，自动平台开关保持关闭。

## 行为与使用

DSH「设置 → SurfCore → B站」新增「公开视频评论草稿」卡片：输入完整 BV 号或官方视频链接，点「读取公开视频」，查看标题、作者和简介，再点「生成本地草稿」，生成后可复制文字。结果只保存在当前组件状态，离开页面不建立待审队列，没有发布按钮。该卡片不需要打开 B站 自动调度开关。

材料范围始终标明为标题、作者、简介；不读取完整视频、字幕、画面、弹幕、评论或私信，不声称已经看过视频。简介最多取 4000 字符，要求模型生成 300 字以内正文；超过 500 字符会明确报错，不切断后作为成功草稿。风格采用简洁自然的中文评论，不读取角色文件或私域记忆。

B站「登录账号」卡置于首屏，读取既有账号记录并区分“已保存凭据，尚未实时核查”和“登录有效”；可以点「核查登录」确认当前有效性，失败展示建议，账号记录读取失败可刷新重试。记忆状态另列为「B站 记忆」，缺少记忆不会再提示已登录用户扫码。扫码入口和账号核查仍复用既有接口。主会话已确认账号登录、verify 和 deps 四项通过；新草稿功能使用不携带 Cookie 的公开元数据请求，不读取账号凭据。2026-11-02 14:45（Asia/Shanghai）修后真实 UI、当前 DeepSeek 模型完整草稿和复制均 **PASS**。

## 完整逻辑

现象：扫码与平台读取已有代码，但原调度器给长模型会话完整工具权限，无法只靠提示限制为草稿；现有 `reply-draft add` 还会触发通知，不适合作为本次无外发入口。

链路：`client.js` 的独立 BiliDraftCard → 插件既有 DSH 认证/回环 Host/Origin 路由 → `bili-drafts.js`。读取接口仅接受受限 BV 或官方视频路径，丢弃用户链接的查询参数、片段，固定请求 `api.bilibili.com/x/web-interface/view`，明确 GET、禁止跳转、不带 Cookie/Authorization。生成接口只接受 BV，服务端重新读取可信资料，客户端伪造 source 不能进入模型。

模型调用只复用宿主 `agentDefaultModel` 和 `llm.stream`，构造一条标题/作者/简介材料消息；链接不进入模型材料。没有工具列表、长 agent、文件读取、QQ/桌宠记忆、旧完整归档、私有日记或私信。模型结果只返回当前 UI；模块没有 CLI、通知、审批或发布路径。

输入上限 512 字符、JSON 请求 8 KiB、官方资料响应 256 KiB。请求体等待上限 8 秒，读取 API 上限 12 秒，模型生成上限 45 秒，并限制同一宿主同时生成一条。模型调用按本机官方 DSH SDK 契约设置 reasoningEffort=off、maxTokens=1600；仅 finish.reason.kind=stop 算正常完成。max-tokens、无 finish、工具结束或超过 500 字符均明确失败，不自动重试或静默截字。上游返回、格式、超时、模型凭据和空结果均提供 code/error/hint，错误原文不回显给用户；页面有 role=alert 显示错误及下一步，复制失败可手动复制。

影响面是一个新模块、两个精确路由及 B站 页草稿卡片和既有账号状态展示，不改 QQ/pet、BILI_GENERATION_UNVERIFIED、平台开关或现有发送实现。此结论仅针对新草稿入口；原有手动发送/审批 API 仍存在，不将其描述为全局 B站 禁止写入。

取舍：路线 A 复用生物钟/长模型会话，改动看似少，但会把 shell、私信/日记及发布能力一起带入，验证成本高。路线 B 用固定公开读取和无工具文本模型调用，新增约一个小模块与 UI，界限更容易验证，回滚只需停用新卡片/路由；选择 B。没有为本次只读需求重构自动发送。

生效：插件 host/client 更改需重启隔离 DSH 后刷新设置页；主会话已完成重启及真实 UI 验收，恢复桌宠，并确认 QQ chat、DSH、QQ 账号及桌宠在线。全程保留原登录、QQ、桌宠及记忆数据。

## 接口与检查

- `POST /dsh-surfcore/api/bili/drafts/read`，JSON `{input:"BV…或官方链接"}`，返回 `{ok:true,source:{bvid,title,author,description,url},basis}`。
- `POST /dsh-surfcore/api/bili/drafts/generate`，JSON `{bvid:"BV…"}`，重新读取资料后返回 `{ok:true,source,draft,basis}`。
- 错误为非成功 HTTP 状态及 `{ok:false,code,error,hint}`；认证与 Origin 使用现有宿主护栏。

`node plugins/surfcore/scripts/test-bili-drafts.mjs`：10组模拟行为及实际插件路由集成检查通过，覆盖完整输入/固定官方 GET/无凭据和跳转/重新读取/拒绝 source 注入/无工具和私域/上限与并发/读取及模型超时/可行动错误/DSH 认证和 Origin。补充模型真实截断形态、缺失/非文本完成和超长拒绝断言；client contract 实际渲染 BiliTab，检查无记忆时凭据/有效登录仍正确显示、卡片位于首屏且仅一份、核查/读取错误与重试建议可见。新测试已登记到插件 npm test 链，完整 `npm --prefix plugins/surfcore test` 已通过；修改文件的语法及 diff 检查通过。未调用真实平台接口或真实模型。

首轮真实 UI 已读取公开资料，但模型默认推理消耗原 500-token 预算后返回半句，旧实现误报成功；本轮按上述完成契约修复，且输入/草稿框改为卡片全宽以便阅读。

修后真实复测：首屏核查显示登录有效；输入公开视频 `BV1LBxx6YEqJ` 后展示实际标题、作者和简介；当前 DeepSeek-V4.1-Flash 返回完整中文草稿；点击复制后按钮显示“已复制”。非法输入已验证显示 `BILI_VIDEO_INPUT_INVALID` 与操作建议。没有执行评论、动态、私信、通知或分享操作，B站 调度和 QQ 分享开关保持关闭。

证据均在忽略提交的 `.local/evidence/`：`bili-live-ui.json`、`bili-readonly-draft-ui.png`、`bili-final-services.json`、`bili-account-after-restart.json`、`bili-after-login-deps.json`、`bili-credential-acl.json`。最终全仓库审计 `bili-final-audit.log` 为 108/108；插件完整测试、10组草稿检查和账号渲染契约通过；regressions 16 项通过。源码和修后模型结束契约经独立验收 PASS。后续保存的 `bili-old-qq-warning-overlay.png` 是历史警报遮挡截图，不作为草稿证据。

本次仅验收扫码、公开元数据读取、完整本地草稿与复制；不据此宣称完整视频理解、B站 自动回复/发布、语音、同模型 30 场景或 M3–M5 完成。

## 回滚与交接

回滚移除新卡片及两个草稿路由，保留账号、配置、私有 ACL 和已有运行数据；不自动启动调度，也不恢复宽 ACL。因新入口没有持久队列，不涉及迁移或删除用户草稿库。

发布交接：`lib/bili-drafts.js`、`lib/index.js`、`lib/client.js`、`scripts/test-bili-drafts.mjs`、`scripts/test-client-contract.mjs`、插件 package.json 测试登记及本 case/LOCAL_CAPABILITIES/HANDOFF/PITFALLS；接口层新增两个只读/文本生成动作，既有发送接口不变。结构化失败路径与真实 UI/模型均通过；回滚与残余见上文。交付到用户 fork 的 `feat/luyao-local-capabilities` 分支，版本保持 0.8.6，不创建上游发布、tag 或 Release。运行凭据、截图和本机证据不提交。
