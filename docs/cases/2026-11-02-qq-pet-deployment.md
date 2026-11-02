# QQ 与桌宠隔离部署验收

日期：2026-11-02。范围：本仓库的真实 DSH、独立 surfpet 与用户手动部署的 SnowLuma 接入；不发布、不迁移原路遥数据，不连接群聊或 B站。

## 当前结果

| 项目 | 已观察事实 | 判定 |
| --- | --- | --- |
| 安装物 | surfpet v0.2.3、Electron 45 已按官方 SHA 清单核验，运行时放在忽略提交的 `.local` 中 | 已核验 |
| 桌宠 | 安装目录 `.local/apps/surfpet`；API 和真实桌面 UI 均完成一次合成文本测试的一问一答 | 文本烟测通过 |
| 桌宠重启 | 正常停止、重启成功；`data/userdata/settings.json` 摘要不变，重启后在线 | 通过 |
| SnowLuma | 用户按 EULA 5.4 手动部署 v2.3.4 并登录；HTTP 与 WS 使用独立凭证，端点均为本机回环 | 只读连接检查通过 |
| QQ 桥接 | 当前 `chat`；DSH 同步成功，5 秒轮询后模式仍为 chat | 持久同步通过 |
| QQ 首轮私聊 | 主人实际发送测试，平台历史核对到入站及两条机器人回复 | 首轮端到端通过 |
| QQ chat 私聊与记忆 | 用户另发不重复答案的问题，真实平台 4 秒后收到先前合成测试口令 | **PASS** |
| reserved2 连续私聊 | 曾延迟约 356 秒，长回合阻塞尚未修复，当前未启用 | **NOT_RESOLVED** |
| 权限收紧 | 关键 25 项及整树最终独立复验均通过 | 最终独立复验通过 |

桌宠 API 证据为 `.local/evidence/pet-live-chat.json`。主会话另通过真实 UI 操作验证；`pet-chat-ui.png` 被后续前台窗口遮挡，不作为可靠截图证据。部署、重启及 ACL 后健康分别见 `pet-deployment.json`、`pet-restart.json`、`pet-after-acl.json`。QQ 初始连接证据为 `qq-live-connect.json`，最终 chat 平台实收发/记忆召回为 `qq-chat-live-retest.json`，权威模式持久同步为 `qq-chat-mode-sync.json`，均位于 `.local/evidence/`。真实账号、凭据、运行日志和备份只留在忽略提交的本机目录，本文不包含实际 QQ 号。

## 准备阶段与运行阶段

准备时，根 `config.json` 与隔离 `.local/dsh/surfcore/config.json` 只允许 `<主人QQ>` 私聊；群白名单为空，`allowAllWhenEmpty=false`。当时 `platforms.start.qq=false`、`bridge.autoStart=false`，检测脚本返回的 `noAutoStart=true` 仅描述准备状态。

主会话已通过 DSH 的配置接口将 `platforms.start.qq=true`、`platforms.start.bili=false`，并启动桥接。现有配置模型会把 `bridge.autoStart` 镜像为 true，因此运行阶段不再宣称 QQ 自启关闭。SnowLuma 的 `allowLaunch=false` 保持不变，部署及启动仍由用户手动操作。B站、群聊、主动搭话、定时问候和自动历史补发继续关闭。

HTTP 凭证仅存入已有忽略提交的桥接配置；WS 的独立凭证由现有同账号发现逻辑读入 SDK 内存，不新增不被支持的配置字段，不把令牌写入源码或证据。`.local/evidence/qq-private-ready-check.mjs` 是准备阶段的只读范围检查，包含 `noAutoStart` 断言；开启 QQ 后不能把它直接当作运行期健康检查。运行期请使用 DSH/SurfCore 状态界面，分别查看 DSH 就绪、SnowLuma 连接与账号在线，再以实际私聊验证事件及回复。

## 连续私聊延迟与部署选择

真实平台历史已确认首轮一问两条回复，证据为 `.local/evidence/qq-platform-history.json`。随后第二条在 13:14:33 入站，直到 13:20:29 才收到回复，约 356 秒；最终收到回复不表示连续聊天问题解决。

只读诊断排除了默认 diving 触发条件：`evaluateWakeTriggerV2` 对私聊直接返回 `private`，无需命中关键词或 `anyMessage`。真正阻塞点是 `pendingWakeKey` 仍属于首轮长回合。该回合发送后依次调用 `qq_wait_for_messages`（45 秒、30 秒）、`qq_mark_read` 和 300 秒等待；新消息写入递增记忆代次，旧回合的 wait 返回因记忆版本变化被拒绝，而 mark_read 又要求沉睡前观察。13:20:19 连续工具错误保护终止旧回合，重建会话后第二条才回复。安全诊断仅保留工具、时序和错误语义，见 `.local/evidence/qq-continuous-private-diagnosis.json`，不保存原始 snapshot 或凭据。

方案 A 是重构 reserved2 长回合的消息补入、等待响应与代次管理，需要证明正常新消息可进入旧回合但纠错/删除后的旧上下文仍不可发送，影响面较大。方案 B 是使用已有 chat 模式完成本轮仅主人私聊：每轮生成最终文本并自动转发，不依赖二代等待与收尾。选择 B，保留鉴权、白名单、受众隔离和每次发送的代次复核，不改全局工具门禁，也不启用群聊/B站/主动外发。

主会话使用 DSH 认证的 `POST /dsh-surfcore/api/mode`，JSON 为 `{"mode":"chat"}`；也可通过既有 bridge helper 调用 `/api/mode` 并要求返回 `dshSynced=true`。配置同时写入仓库状态和 DSH qq-mode 命名空间，离开 reserved2 会清理其定时器、队列并退役旧策略会话；不自动重放旧未读。主会话已重启桥接，并通过 bridge `/api/mode` 确认 `dshSynced=true`，5 秒轮询前后均为 chat。权威持久证据为 `.local/evidence/qq-chat-mode-sync.json`。

本轮最小源码修复为 local prompt 的交付分支：有会话令牌保留 reserved2 发送/自然分条/等待/收尾契约；无令牌时明确让模型只输出最终回复，由桥接自动转发，禁止调用二代发送、等待与收尾工具。没有放宽任何权限或记忆版本检查。18 项本地能力渠道集成测试已覆盖两种提示及原隔离/删除/发送守卫，chat 微修后的 bridge audit 16 项和 regressions 16 项也通过。**reserved2 的连续私聊长回合问题尚未修复，当前未启用**，不宣称 reserved2 连续端到端通过。用户已在 chat 模式另发“刚才的测试口令是什么”，没有重复答案；OneBot 真实平台历史核对到请求及机器人回复的 messageId，4 秒后正确召回先前合成口令，`replyReceived=true`、`memoryRecalled=true`。证据为 `.local/evidence/qq-chat-live-retest.json`，本轮主人普通私聊收发与记忆召回通过，不再要求额外用户测试作为本次完成条件。

## 用户操作

1. 由用户在 `.local/apps/SnowLuma` 手动运行其官方 launcher，并完成 QQ 登录。不要让脚本替代解压部署、接受协议或设置自动接受协议的环境变量。
2. DSH 停止后，在仓库运行 `pwsh -NoProfile -File scripts/local-deployment.ps1 start`；首次需 `-DshCli '<DSH安装目录>\resources\runtime\cli\bin\dsh.cmd'`，后续复用 `.local` 私有配置。需要官方登录浏览器时用 `restart -OpenBrowser`。这个脚本管理 DSH 与独立记忆管理实例，不替代 SnowLuma 手动登录。
3. 在 DSH「设置 → SurfCore → 桌宠」启动桌宠；桌宠右键菜单进入文本对话。桌宠文本测试已经通过，不据此宣称语音已通过。
4. QQ 本轮选择 chat 模式，仅从 `<主人QQ>` 向 `<机器人QQ>` 发新的私聊。其他私聊和所有群聊均不在授权范围内。QQ 运行开关在 SurfCore 的 QQ 页；启动前仍应核对 B站关闭以及主人私聊白名单。
5. 本地记忆管理入口为「DSH 设置 → SurfCore → 记忆 → 打开本地记忆管理」。使用同源页面链接和官方 DSH 登录，不从私有日志提取登录 token。

## 完整逻辑与取舍

链路：用户手动启动 SnowLuma，OneBot HTTP/WS 提供本机平台接口；SurfCore 插件负责启动 QQ 桥接与桌宠、调用 DSH 模型，并由插件宿主管理唯一的本地能力服务。桥接从可信平台事件获得会话身份，发送前复核上下文代次；桌宠通过既有适配器获得本轮投影。在线状态与真实消息事件是不同环节，必须分别验收。

机制：HTTP 与 WS 凭证不能混用。配置只保存 HTTP 凭证及安装根，既有自愈逻辑按同一机器人账号选择 WS 凭证。QQ 平台开关既控制运行许可，也投影到 `bridge.autoStart`；它与 SnowLuma 的自动启动许可不是同一个开关。本轮还移除了控制台自动凭证、SnowLuma HTTP/WS 自愈日志中的凭据前缀，只留下配置状态和非秘密来源标识。

爆炸半径：本机隔离 DSH、一个 QQ 桥接、独立桌宠及其运行时；角色数据、日志和备份留在本仓库 `.local` 或既有忽略路径内。QQ 仅限主人私聊，群聊/B站/主动外发关闭。未修改原路遥目录或用户默认 `~/.dsh`。

两条路线：继续只做 API 在线检查，成本低且无平台消息，但不能验证 QQHook 的私聊事件上报或真实 UI；采用受限真实运行，成本是部署运行时和逐段验收，收益是确认桌宠文本与实际连接。选择后者，已由用户真实私聊补齐 chat 收发与记忆召回验证。未改 SnowLuma native，也不建立旁路注入来绕开事件问题。

生效与重启：桌宠、桥接和 DSH 各使用自己的正常停止/启动入口。修改桥接源码须重启桥接，插件 host/client 改动须重启隔离 DSH。桌宠已通过一次正常重启及设置摘要核验。当前运行状态不能自动代表未来重启后仍连通，应重新查看就绪字段。

## 权限、失败路径与回滚

部署发现新 fork 继承了宽权限，现已在新 fork 根、`.local`、根配置、桥接状态及相关备份收紧到当前用户、SYSTEM 和 Administrators。整树只读核验覆盖 12684 个对象，未发现 Everyone/Users 等宽权限 ACE；保留了 surfpet `data/userdata` 下 Shared Dictionary、Network、Cache 三棵原有运行时树中同一个 Chromium capability SID 的 22 条 ACE，涉及 15 个对象；不涉及 DSH、OneBot、host/console 凭据、根配置或备份凭据。两个仓库内部链接按 reparse point 跳过，上级目录及原项目权限未改；上级 DeleteChild 权限仍是本次范围之外的限制。原子替换的安全继承、关键 25 项及整树最终独立复验均通过；冻结摘要为 `.local/backups/acl-hardening-1b3395f02baa477f833d41fd9cc33332/final-summary.json`。

失败会在当前接口或界面显示错误与下一步。真实 API 在线且登录成功只表示平台可连接；若实际私聊没有事件，继续按实际链路诊断，不能凭控制台 QQHook 警告判定成功或失败。缺模型凭据返回 `MODEL_AUTH_REQUIRED`，其他模型调用故障返回 `MODEL_UNAVAILABLE`；本地能力故障保持失败关闭。

回滚使用正常 UI/API 停止桥接和桌宠：DSH 认证下 `POST /dsh-surfcore/api/bridge` 的 `action=stop`、`POST /dsh-surfcore/api/pet/stop`，或对应设置页。关闭 QQ 平台开关可同时禁止后续自动拉起。保留配置、运行时、数据库与 `.local/backups/` 权限备份；不要为了回滚自动恢复 Everyone/Users 的宽 ACL。SnowLuma 的退出由用户自行操作。

## 源码清单

- `src/bridge.js`：三个已定位日志点不再输出凭据值或前缀。
- `scripts/test-snowluma-conn.mjs`：执行真实日志表达式，验证配置状态保留而假凭据及前缀不出现。
- `src/local-capabilities-bridge.js`：按是否持有会话令牌分流工具交付与 chat 最终文本交付，保留全部守卫。
- `scripts/test-local-capabilities-channels.mjs`：覆盖两种实际提示及既有来源、删除、受众与发送检查。

## 验证与未完成范围

chat 提示分流后，主会话再次执行的最终 `npm run test:audit` 为 108/108 scripts passed，日志为 `.local/evidence/qq-pet-final-audit.log`。本轮三个日志点的定向检查 30 项通过，桥接审计 16 项和 regressions 16 项通过；外部 voice-tool 不在本仓库，相应检查明确跳过。源码 diff 与日志在 `.local/evidence/qq-log-redaction.patch` 及同名前缀测试日志中。前述真实桌宠及 QQ 平台证据由主会话收集；最终 chat 的主人普通私聊收发与 4 秒记忆召回通过，reserved2 延迟问题仍单独保留。

语音输入/输出、同模型 30 场景对照以及 M3–M5 均未验收完成。B站自主发送仍不在本轮启用范围；不宣称完整 M2 或完整产品发布。

发布交接块：

```text
文件：src/bridge.js、scripts/test-snowluma-conn.mjs；src/local-capabilities-bridge.js、scripts/test-local-capabilities-channels.mjs；本case及LOCAL_CAPABILITIES/HANDOFF。
验证：全仓库test:audit 108/108脚本通过；日志30项、bridge audit16项、regressions16项通过；外部voice检查skip；桌宠真实API/UI文本烟测、重启设置保留、ACL后健康通过；QQ当前chat模式持久同步通过，主人真实私聊收发及4秒记忆召回PASS；reserved2长回合仍NOT_RESOLVED且未启用。
版本：本任务不改版本、不发布；发布会话另行判断范围。
层级：凭证日志安全修复及local prompt交付分支；chat改用最终文本自动转发，reserved2工具契约和全部权限/代次守卫不变。
失败：接口/界面保留结构化错误与下一步；不通过日志提取token，不放宽鉴权；回滚用正常UI/API停桥接/桌宠并保留数据。
权限：保留必要Chromium能力ACE，关键25项及整树最终独立复验通过；不自动恢复宽ACL。
未完成：reserved2连续私聊长回合问题、语音、30场景同模型对照、M3–M5；无上游发布、无真实群聊/B站/主动外发。
```
