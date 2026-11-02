# SurfCore × 路遥本地能力

基于 SurfCore `0.8.6` / `59ec3066f7d42a0452fae01f170c9a8484d5dbe5`，本分支扩展本地记忆、语义整理、受控工具、自主公开阅读、语音与窗口问答、角色包恢复。当前仍在完成 M0–M5 集成验收；源码检查、实际部署、模型、平台和设备结果分别记录在[执行与验收](FULL_INTEGRATION_EXECUTION.md)，不能把其中一层通过视为全部完成。

## 安装与运行

需要 Windows、Node >=22.13、Python 3.13。使用仓库自己的虚拟环境：

```powershell
npm ci
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r services/local-capabilities/requirements.txt
npm run dev:local-memory
```

打开 `http://127.0.0.1:3210/local-capabilities`。这是生产管理处理器的隔离实例，角色为 `isolated-local-test`，数据在 `.local/local-capabilities-dev/`。它能真实管理加密记忆，不模拟模型回复，也不连接 QQ/B站。首次选择 `local` 创建 SQLCipher 数据库与当前 Windows 用户的 DPAPI 密钥；后续缺密钥时拒绝打开，不创建空库冒充原库。`SURFCORE_LOCAL_PORT` 更换端口，`SURFCORE_LOCAL_PYTHON` 指定 Python。

DSH 内使用设置中的本地记忆入口。先按原安装文档安装 SurfCore；host/client 变更后重启所用 DSH profile，桥接代码变更也需重启桥接。隔离安装可将 `DSH_HOME` 指向本仓库 `.local/dsh`，运行 `node scripts/setup-dsh.mjs web`，再用已安装 DSH 的 CLI 启动 `--profile web --host 127.0.0.1 --port 3211 --no-open`。首次访问使用 DSH 自己生成的本机登录入口，认证信息不放进共享文档。

已准备好上述隔离环境后，可用 PowerShell 7 管理两个服务：

```powershell
# 首次提供本机已安装的 DSH CLI；路径仅保存在忽略提交的 .local 中。
pwsh -NoProfile -File scripts/local-deployment.ps1 start -DshCli '<DSH 安装目录>\resources\runtime\cli\bin\dsh.cmd' -OpenBrowser
pwsh -NoProfile -File scripts/local-deployment.ps1 status
pwsh -NoProfile -File scripts/local-deployment.ps1 restart
pwsh -NoProfile -File scripts/local-deployment.ps1 stop
```

默认地址为记忆管理页 `http://127.0.0.1:3210/local-capabilities` 和 DSH `http://127.0.0.1:3211`。DSH 需要登录会话，`-OpenBrowser` 让官方 CLI 启动时打开本机登录页面；已运行时可用 `restart -OpenBrowser`。脚本只管理自身记录且身份匹配的进程，遇到其他进程占用端口会给出错误与处理提示。停止保留数据库、配置和日志。详见[部署记录](cases/2026-11-02-local-deployment.md)。

隔离 DSH 使用自己的模型配置。真实聊天前，在 DSH 的模型页面为 `deepseek-official` 配置 DeepSeek API Key 并保存，选择可用的默认模型。密钥仅填本机设置页。缺失或拒绝凭据时聊天返回 `MODEL_AUTH_REQUIRED`，其他模型调用故障返回 `MODEL_UNAVAILABLE`；本地记忆故障保持独立的错误提示。管理页健康检查通过只代表本地能力服务可用，不能证明模型或 QQ 已连通。

### QQ 与桌宠的既有部署基线

本轮已在忽略提交的 `.local/apps/surfpet` 部署 surfpet v0.2.3，配套 Electron 45 已按官方 SHA 清单核验。DSH「设置 → SurfCore → 桌宠」可启动；桌宠右键菜单进入文本对话。真实 API/UI 的合成文本一问一答，以及正常重启后 userdata 设置摘要保留已验证。它们不代表语音已通过。

SnowLuma v2.3.4 由用户按 EULA 5.4 手动部署并登录；由用户运行其官方 launcher，`snowluma.allowLaunch=false`。HTTP 与 WS 使用独立凭证，均只连接本机回环；实际凭据只在忽略提交的本机配置内。基线 QQ 主人私聊收发与记忆召回已通过：reserved2 曾出现约356秒延迟，切到 chat 后真实平台4秒内回复并正确召回合成口令。新分支已修复 reserved2 旧代次和长回合占用，并通过独立确定性检查；其新版本真实平台连续性仍待部署验证，当前运行保留 chat。

准备阶段 QQ 平台开关和 `bridge.autoStart` 均关闭；基线运行已开启 `platforms.start.qq`，既有配置模型将 `bridge.autoStart` 镜像为 true。群聊、旧主动搭话、定时问候和自动历史补发关闭，仅允许已绑定主人私聊。账号值不写入本说明。chat 每轮自动转发最终文本；reserved2 保留显式发送、等待和自然收尾。运行与权限详情见 [QQ/桌宠部署记录](cases/2026-11-02-qq-pet-deployment.md)。

### B站公开资料与本地草稿

用户选择的范围为扫码接入、读取内容与生成草稿。DSH「设置 → SurfCore → B站」的「公开视频评论草稿」卡片接受完整 BV 号或官方视频链接：先读取标题、作者和简介，再生成并复制评论草稿。材料范围会明确显示；本入口不读取完整视频、私信或 QQ/桌宠记忆。草稿只在当前页面展示，不入待审队列，不触发通知或发布。

该入口独立于自动调度，B站 平台开关继续关闭；`BILI_GENERATION_UNVERIFIED` 门禁保持不变。现有手动操作接口仍存在，新入口的只读范围不代表全局禁写。真实登录核查、公开资料读取、DeepSeek 完整草稿和页面复制已通过；首屏账号状态与记忆状态独立。草稿截断、异常结束或超长会明确报错。测试与接口说明见 [B站草稿记录](cases/2026-11-02-bili-readonly-drafts.md)。

## 使用与数据范围

- 按角色保存后端：`legacy` 沿用原版，`shadow` 仅演练，`local` 使用新服务，`paused` 停用。正式本地写入后只允许暂停，不自动切回旧库。
- 管理页支持搜索、来源和修订、纠正、停止用于回答、删除、导出和自动经历写入。Writer 在聊天空闲后整理同一受众的有限来源，形成可追溯提案；关闭自动写入也停止整理。用户修订和删除优先。
- “本地语义检索”可启用本机 CPU 向量索引、查询与检查来源。索引只是可重建缓存，原始记忆仍在 SQLCipher；关闭或尚未覆盖的查询会明确显示状态。聊天使用经过当前受众过滤的有限结果。
- 纠正固定用户认知并失效旧派生内容；删除清理本服务正文、修订和来源关联副本，保留无正文防重放摘要。旧 DSH 会话、平台原消息、旧备份不由此页面擦除。没有来源关系的新独立改写文本不属于语义删除检测。
- 桌宠、各 QQ 私聊和各群默认隔离。本机管理页可显式开启桌宠共享，绑定 QQ 机器人账号及主人私聊对象。设置影响后续写入，旧私域记录不自动扩大范围；群聊不能继承主人权限。
- 导入先预览。无法验证原始来源的摘要进入 `quarantine` 待审区，标为旧摘要，不参与普通回答。重复迁移不增加记录。
- 主动联系默认关闭。静音、专注、安静时段、冷却、每日限额和未回应衰减在发送前复核；未知结果按可能已发送记账，不换渠道重发。被动提问不受主动预算限制。

管理页面只接受回环访问，并检查会话 Cookie、请求校验码和 Origin；DSH 入口另有宿主认证。身份绑定、删除和权限管理不暴露为模型工具。stdio 是进程边界，不是操作系统沙箱。

### 自主阅读后私聊主人

DSH 的 B站页提供自主陪伴配置：读取公开推荐/搜索结果，根据公开材料形成想分享的内容，再通过已绑定的主人 QQ 私聊发送。页面可查看来源、预览、最近结果、开关和停止状态。读取范围按实际取得的标题、简介等资料标注，不能当作已经观看视频画面。这个流程不会向 B站发布评论、动态或私信。

源码默认关闭；初始节奏为每小时检查一次、每天最多四次主动私聊、至少90分钟冷却，并遵守统一安静时段、静音、专注和未回应衰减。QQ和桌宠共用额度；不确定是否送达的内容不会换渠道补发。既有 B站自动发布入口继续保持原权限门槛。

### 本机工具

从“本地记忆 → 本机工具与权限管理”登记可读目录、查看便签和执行记录。支持时间、目录只读、文本读取、便签及打开已登记目录。可以在原 QQ 私聊或桌宠说“现在几点”或“创建便签……”，也可用 `/tool time.now`。涉及目录或已有便签时，在原请求中提供页面给出的具体标识；模型不会替用户猜目标。

操作需要核对具体参数、用途、期限与次数。本地读取结果再次用于模型解释时，还要确认这份结果和原目标；默认不写聊天历史、记忆或语音缓存。紧停会取消待发内容；解除紧停后需要重新发起请求。便签是持久记录，时间/文件工具不是任意命令行或全盘访问权限。

### 语音与窗口

从“本地记忆 → 语音与窗口控制”，或已更新桌宠的右键菜单打开本机设备页。先选择设备与用途，核对具体目标，再点击明确启动。按住录音、松开核对转写后，另点发送；免提使用“你好路遥”，最长15分钟。窗口问答只发送已经预览的同一帧，最多在60秒内取得三帧。隐藏页面、停止、撤权或切换角色/模型会让旧许可失效。媒体输入和派生回答不写记忆与历史。

Windows 本地声音通过唯一输出链播放；桌宠必须先确认已停止原来的音频，才能开始新播音。纯文字和媒体均使用当前 DSH 模型；窗口问答还要求该模型实际支持图片。可选依赖和本机模型清单见 [资产与依赖](LOCAL_CAPABILITIES_ASSETS.md)。媒体 SDK 需要版本绑定的[启动预加载](cases/2026-11-02-dsh-media-preload.md)，不修改 DSH 安装包；版本不匹配会拒绝启动，不能自动放宽哈希。

### 备份与角色包

记忆页支持独立口令加密备份和预览恢复；最新删除记录优先，旧备份不能静默恢复已删除正文。“角色包与升级恢复”包含七层人格、加密记忆、防重发摘要和资产来源清单，不包含账号凭据、授权、设备许可或资产二进制。导入目标先暂停，核对后才能恢复使用；响应丢失时先查询状态，不能重复导入。真实库升级及浏览器文件操作的完成情况以验收记录为准。

## 接入边界

| 入口 | 当前行为 |
| --- | --- |
| 独立管理页 / DSH 设置 | 共用管理处理器和加密服务，提供测试迁移及用户主权操作 |
| 桌宠聊天适配 | 按范围取记忆，模型返回和队列输出前复核代次，停用旧卡片旁路 |
| QQ chat | 可信消息绑定、新会话上下文、代次复核后自动转发最终文本；当前仅主人私聊，真实收发及 4 秒记忆召回通过 |
| QQ reserved / reserved2 | 保留原生发送/等待/收尾；新入站退役旧代次并保留未答请求，真实连续性待部署验证 |
| QQ closed-agent / 未纳管动作 | local 模式下拒绝；固定本机工具经独立授权与交付流程执行 |
| B站 | 登录、公开读取和本地草稿；新自主陪伴只向已绑定主人私聊，旧公开发布入口仍受门槛限制 |
| 语音与窗口 | 有界设备许可和固定模型交付，设备实测仍待完成 |
| 备份和角色包 | 加密预览、恢复与暂停复审；完整角色包第2次修补已独立通过，真实升级待验 |

QQ 和桌宠共用插件宿主管理的一个能力进程；QQ 桥接不另开数据库写进程。服务故障不退回旧私域提示词，不放宽主动发送条件；页面显示原因和下一步。

## 验证与回滚

```powershell
# 完整能力回归需要本机语义/媒体依赖和已核验的离线模型；不会启动实际设备。
.\.venv\Scripts\python.exe -m pip install -r services/local-capabilities/requirements-semantic.txt -r services/local-capabilities/requirements-media.txt
npm run test:local-capabilities
npm run test:audit
npm run test:regressions
npm --prefix plugins/surfcore test
```

上游审计需要先从示例创建 `config.json`；Windows 生成文件的换行差异可用 `node scripts/build-agent-preset-patches.mjs` 重建。测试只使用临时/隔离数据，不发送真实平台消息。实测见 [实施记录](cases/2026-11-02-local-capabilities.md)。

基线 `e9d33b4` 的最终全仓库审计为108/108，真实 DSH 模型、记忆管理、桌宠文本与重启、QQ主人私聊及B站读取/草稿均有记录。本批新增功能的最终审计、120次原生对照、实际平台与设备、运行观察尚在进行，详见[执行与验收](FULL_INTEGRATION_EXECUTION.md)。旧日志不能替代新版本验证，截图或在线状态不能替代实际收发和设备行为。

新增 fork 已收紧目录和凭据 ACL，保留 Chromium 在 surfpet userdata 的 Shared Dictionary、Network、Cache 三棵原有运行时树所需能力 ACE；关键 25 项及整树最终独立复验通过。回滚用正常设置/API 停桥接与桌宠，保留 `.local/backups/` 及数据库，不自动恢复 Everyone/Users 宽权限。

未开启时可继续 legacy。正式写入后先暂停、导出核对，再明确修复或回迁，不能直接覆盖旧快照。保留 `.local/` 数据库和 `key.dpapi`，不要提交到 Git，也不要复制原路遥密钥。新库加密不代表原 DSH 日志、平台消息或导出的明文 JSON 同样加密。
