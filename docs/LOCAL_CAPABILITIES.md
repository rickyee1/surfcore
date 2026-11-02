# SurfCore × 路遥本地记忆

基于 SurfCore `0.8.6` / `59ec3066f7d42a0452fae01f170c9a8484d5dbe5`，实现首期 M0–M2 的本地能力服务、记忆管理与 QQ/桌宠接线。B站自动发送尚未完成纳管；真实模型、QQ 和独立 surfpet 的验收另列，不将离线测试称为完整产品验收。

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

### 已部署的 QQ 与桌宠

本轮已在忽略提交的 `.local/apps/surfpet` 部署 surfpet v0.2.3，配套 Electron 45 已按官方 SHA 清单核验。DSH「设置 → SurfCore → 桌宠」可启动；桌宠右键菜单进入文本对话。真实 API/UI 的合成文本一问一答，以及正常重启后 userdata 设置摘要保留已验证。它们不代表语音已通过。

SnowLuma v2.3.4 由用户按 EULA 5.4 手动部署并登录；由用户运行其官方 launcher，`snowluma.allowLaunch=false`。HTTP 与 WS 使用独立凭证，均只连接本机回环；实际凭据只在忽略提交的本机配置内。QQ 桥接已连接且 DSH/账号在线，主人首轮真实私聊及平台回复历史已确认；第二条出现约 356 秒延迟，定位为 reserved2 等待的旧代次与长回合占用。本轮已持久切换到受支持的 chat 模式，用户另发未重复答案的问题后，真实平台 4 秒内回复并正确召回先前合成测试口令，**主人普通私聊收发与记忆召回 PASS**。reserved2 的长回合问题仍未解决，当前未启用。

准备阶段 QQ 平台开关和 `bridge.autoStart` 均关闭；当前运行阶段已开启 `platforms.start.qq`，既有配置模型将 `bridge.autoStart` 镜像为 true。B站、所有群聊、主动搭话、定时问候及自动历史补发保持关闭，仅允许 `<主人QQ>` 与 `<机器人QQ>` 的指定私聊。账号值不写入本说明。chat 模式每轮只输出最终文本，由桥接自动转发；无会话令牌时不调用二代发送/等待/收尾工具，有令牌仍保留 reserved2 工具契约。鉴权、白名单和代次检查不变，reserved2 连续私聊长回合问题仍未修复。运行与权限详情、证据位置见 [QQ/桌宠部署记录](cases/2026-11-02-qq-pet-deployment.md)。

### B站公开资料与本地草稿

用户选择的范围为扫码接入、读取内容与生成草稿。DSH「设置 → SurfCore → B站」的「公开视频评论草稿」卡片接受完整 BV 号或官方视频链接：先读取标题、作者和简介，再生成并复制评论草稿。材料范围会明确显示；本入口不读取完整视频、私信或 QQ/桌宠记忆。草稿只在当前页面展示，不入待审队列，不触发通知或发布。

该入口独立于自动调度，B站 平台开关继续关闭；`BILI_GENERATION_UNVERIFIED` 门禁保持不变。现有手动操作接口仍存在，新入口的只读范围不代表全局禁写。真实登录核查、公开资料读取、DeepSeek 完整草稿和页面复制已通过；首屏账号状态与记忆状态独立。草稿截断、异常结束或超长会明确报错。测试与接口说明见 [B站草稿记录](cases/2026-11-02-bili-readonly-drafts.md)。

## 使用与数据范围

- 按角色保存后端：`legacy` 沿用原版，`shadow` 仅演练，`local` 使用新服务，`paused` 停用。正式本地写入后只允许暂停，不自动切回旧库。
- 管理页支持搜索、来源和修订、纠正、停止用于回答、删除、导出、自动经历写入。自动写入保存有来源的对话经历；完整语义 Memory Writer、向量检索和自动事实整合尚未实现。
- 纠正固定用户认知并失效旧派生内容；删除清理本服务正文、修订和来源关联副本，保留无正文防重放摘要。旧 DSH 会话、平台原消息、旧备份不由此页面擦除。没有来源关系的新独立改写文本不属于语义删除检测。
- 桌宠、各 QQ 私聊和各群默认隔离。本机管理页可显式开启桌宠共享，绑定 QQ 机器人账号及主人私聊对象。设置影响后续写入，旧私域记录不自动扩大范围；群聊不能继承主人权限。
- 导入先预览。无法验证原始来源的摘要进入 `quarantine` 待审区，标为旧摘要，不参与普通回答。重复迁移不增加记录。
- 主动联系默认关闭。静音、专注、安静时段、冷却、每日限额和未回应衰减在发送前复核；未知结果按可能已发送记账，不换渠道重发。被动提问不受主动预算限制。

管理页面只接受回环访问，并检查会话 Cookie、请求校验码和 Origin；DSH 入口另有宿主认证。身份绑定、删除和权限管理不暴露为模型工具。stdio 是进程边界，不是操作系统沙箱。

## 接入边界

| 入口 | 当前行为 |
| --- | --- |
| 独立管理页 / DSH 设置 | 共用管理处理器和加密服务，提供测试迁移及用户主权操作 |
| 桌宠聊天适配 | 按范围取记忆，模型返回和队列输出前复核代次，停用旧卡片旁路 |
| QQ chat | 可信消息绑定、新会话上下文、代次复核后自动转发最终文本；当前仅主人私聊，真实收发及 4 秒记忆召回通过 |
| QQ reserved / reserved2 | 保留显式发送和等待；reserved2 连续私聊的长回合/旧代次等待问题尚未修复 |
| QQ closed-agent / 未纳管动作 | local 模式下拒绝，避免完整本机工具绕过治理；M3 另行接入 |
| B站 | 扫码登录、公开标题/作者/简介读取及本地草稿通过；自主调度因 CLI 发送未绑定生成代次而暂停，返回 `BILI_GENERATION_UNVERIFIED` |
| 语音输入、屏幕、备份恢复、完整发布 | M3–M5 后续工作 |

QQ 和桌宠共用插件宿主管理的一个能力进程；QQ 桥接不另开数据库写进程。服务故障不退回旧私域提示词，不放宽主动发送条件；页面显示原因和下一步。

## 验证与回滚

```powershell
npm run test:local-capabilities
npm run test:audit
npm run test:regressions
npm --prefix plugins/surfcore test
```

上游审计需要先从示例创建 `config.json`；Windows 生成文件的换行差异可用 `node scripts/build-agent-preset-patches.mjs` 重建。测试只使用临时/隔离数据，不发送真实平台消息。实测见 [实施记录](cases/2026-11-02-local-capabilities.md)。

chat 提示分流后的最终全仓库 `test:audit` 为 108/108 脚本通过，日志在 `.local/evidence/qq-pet-final-audit.log`。后续 chat 提示分流的渠道集成 18 项、bridge audit 16 项和 regressions 16 项通过。本机部署的真实验证分层记录：DSH 模型及记忆纠错/删除、桌宠 API/UI 文本与重启持久化已通过；QQ 当前 chat 模式在 DSH 同步及 5 秒轮询后保持，真实主人私聊收发与 4 秒记忆召回通过；证据为 `.local/evidence/qq-chat-mode-sync.json` 和 `qq-chat-live-retest.json`。reserved2 曾发生约 356 秒延迟，当前未启用且仍未解决。语音、同模型 30 场景和 M3–M5 未完成。QQ/桌宠截图或在线状态不能代替相应收发行为证据。

新增 fork 已收紧目录和凭据 ACL，保留 Chromium 在 surfpet userdata 的 Shared Dictionary、Network、Cache 三棵原有运行时树所需能力 ACE；关键 25 项及整树最终独立复验通过。回滚用正常设置/API 停桥接与桌宠，保留 `.local/backups/` 及数据库，不自动恢复 Everyone/Users 宽权限。

未开启时可继续 legacy。正式写入后先暂停、导出核对，再明确修复或回迁，不能直接覆盖旧快照。保留 `.local/` 数据库和 `key.dpapi`，不要提交到 Git，也不要复制原路遥密钥。新库加密不代表原 DSH 日志、平台消息或导出的明文 JSON 同样加密。
