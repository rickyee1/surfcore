# 本地部署、进程管理与真实模型联调

日期：2026-11-02。范围：Windows 隔离部署、真实 DSH 插件与模型联调、部署辅助脚本及模型错误提示修复；版本保持 0.8.6，不连接真实 QQ 或独立 surfpet，不修改用户默认 `~/.dsh`。

## 现象与根因

隔离记忆管理端与 DSH 原先分别靠临时命令启动。端口有监听只说明某个进程在运行，不能证明它属于本次部署；单凭 PID 停止服务会遇到 PID 重用。重复启动还可能让两个进程争用同一个加密数据库。

新增 `scripts/local-deployment.ps1`，让启动、查询、停止和重启共用一份进程身份记录。默认端口为记忆管理 3210、DSH 3211，监听地址均为 `127.0.0.1`。

## 使用

在仓库根目录运行 PowerShell 7：

```powershell
pwsh -NoProfile -File scripts/local-deployment.ps1 start -DshCli '<DSH安装目录>\resources\runtime\cli\bin\dsh.cmd'
pwsh -NoProfile -File scripts/local-deployment.ps1 status -Json
pwsh -NoProfile -File scripts/local-deployment.ps1 stop
pwsh -NoProfile -File scripts/local-deployment.ps1 restart
```

首次可用 `-DshCli '<DSH安装目录>\resources\runtime\cli\bin\dsh.cmd'` 指定已安装的官方 CLI。选择顺序为显式 `-DshCli`、当前进程环境变量 `SURFCORE_DSH_CLI`、仓库 `.local/deployment/state.json` 中上次保存的路径、PATH 上的 `dsh.cmd`。通过启动预检后保存有效路径，后续无参数 start/restart 自动复用；不修改用户环境变量或默认 DSH 目录。未找到路径时返回 `DEPENDENCY_MISSING` 和设置提示。依赖为 Node、PowerShell 7 和仓库 `.venv` 的 SQLCipher；隔离 `.local/dsh` 应已完成插件注册。本脚本不安装依赖或迁移用户数据。

`-MemoryPort`、`-DshPort` 可调整端口；同一次部署的后续命令应保持相同参数。换端口前先停止本脚本实例，避免两套记忆管理并发写同一个数据库。默认关闭自动打开浏览器；需要 DSH 官方启动登录流程时运行：

```powershell
pwsh -NoProfile -File scripts/local-deployment.ps1 restart -OpenBrowser
```

这只让官方 CLI 按正常启动流程打开浏览器，不解析日志、不提取登录 token、不创建替代登录入口。`start -OpenBrowser` 遇到已运行的实例仍保持幂等，不额外启动浏览器。

所有命令输出 JSON。失败返回非零退出码，并包含 `ok:false`、`code`、`error`、`hint`；例如 `PORT_UNAVAILABLE` 提示由原进程拥有者处理占用，脚本不会接管或终止未知监听者。

## 完整逻辑

链路：当前 PowerShell 调用脚本，脚本启动隐藏的 PowerShell 子进程；子进程分别运行 `node scripts/local-capabilities-dev.mjs` 和官方 `dsh.cmd --profile web --host 127.0.0.1 --port 3211 --no-open`。`-OpenBrowser` 仅省略 `--no-open`。两个子进程都显式设置 `DSH_HOME=<当前仓库>/.local/dsh` 及仓库 Python 路径，不使用用户的默认 DSH 目录。

机制：先按显式参数、进程环境变量、仓库私有状态、PATH 解析 CLI 路径，再检查依赖、SQLCipher、隔离目录和两个端口。有效 CLI 路径只保存在仓库忽略目录，不写入公开脚本或用户环境。已登记且身份吻合的监听保持运行，重复 start 不创建进程。身份由 PID、进程创建时间、可执行文件路径、完整命令行的 SHA-256 共同确定；不把命令行或凭据输出到状态页面。新监听必须属于已记录启动器的子孙进程。停止时重新验证原身份，仅停止已验证的启动器、监听者和其已核验子进程。记录已失效或 PID 被重用时拒绝停止对应进程。操作锁避免两条部署命令同时更改状态。

进程、日志和数据：记录及启动日志位于 `.local/deployment/`，记忆服务仍使用既有 `.local/local-capabilities-dev/`，DSH 使用 `.local/dsh/`。stop 保留记录、日志、数据库、配置及会话。日志可能含运行时自己的私有登录信息，只在本机检查，不复制或提交。脚本不读取日志正文来获取凭据。

爆炸半径：两个受控启动器及其子进程，由当前用户手工调用一份脚本。停止可中断正在进行的模型请求；不会发 QQ 消息、不迁移或删除记忆。异常会在当前命令输出中显示，避免静默接管未知进程。

取舍：方案 A 是继续使用两条手工启动命令，成本低、易撤回，但无法幂等启动或安全停止，依赖人工检查身份。方案 B 是一个仓库内 PowerShell 入口，增加少量状态和身份核验代码，换取可复查的生命周期操作；不引入 Windows 服务、任务计划或常驻通用管理框架。选择 B，回滚只需先停止本脚本拥有的实例，再回到原来的隔离命令。

生效与重启：脚本每次调用读取当前源码。服务本身代码改变后使用 restart；当前已有的临时启动器不会自动成为脚本管理对象，须由其拥有者先确认身份并停止。若部分服务启动失败，脚本保留已启动进程的身份，按提示运行 status/stop，禁止重复启动未知实例。

## 验证

执行 `pwsh -NoProfile -File scripts/test-local-deployment.ps1`。它把脚本复制到仓库 `.local/deployment-tests/<随机目录>/fixture`，只创建短暂睡眠进程和随机回环测试端口，不启动 DSH、记忆服务或 Python 数据库。10 项检查通过：PowerShell parser、显式参数与进程环境变量优先级、私有 CLI 路径持久复用、PATH 发现、缺失 CLI 的结构化提示、未知监听的结构化错误、正确身份停止与模拟 PID 重用保护、数据及身份记录保留、并发操作锁、损坏记录拒绝停止。证据见 `.local/deployment-tests/9e992199-51ee-4bf6-ac07-0aebd01cf687/results.json`。

实际只读 status 已验证：原有 3210/PID 21412、3211/PID 17640 返回 unmanaged-port、`PORT_UNAVAILABLE` 和处理提示；未停止或接管它们。定位测试曾发现 JSON 将 ISO 时间恢复为 DateTime，初版字符串比较会拒绝停止本脚本进程；已改为 UTC ticks 比较，重新运行上述安全测试全部通过。

主会话实际部署验证：

- DSH 插件真实 HTTP 接口 19 项通过：认证、跨站拒绝、加密服务健康、迁移幂等、待审范围、纠正、修订冲突、停用、导出、删除、禁止误切旧库及持久化夹具。
- 新脚本首次启动两个实例，重复 start 保持相同监听 PID；stop 释放两个端口；随后 restart 恢复两个受管理实例。记录与正文摘要跨此轮停止、恢复保持一致。还执行了运行中的直接 restart，未传新的 CLI 参数，复用保存在本机的安装路径。
- 官方 `-OpenBrowser` 流程在 Edge 打开已认证的 DSH 页面。用户自行在本机保存 DeepSeek API Key，密钥未经过聊天、源码或测试日志传递。
- 真实模型连通性返回“连接成功。”；真实记忆联调写入虚构代号、纠正为新代号后模型采用新值、删除后模型回答“不知道”。全程使用隔离测试角色，无真实平台消息。

真实模型证据见 `.local/evidence/live-model-connected.json`、`live-model-memory.json`；生命周期证据见同目录 `deployment-start.json`、`deployment-idempotent-start.json`、`deployment-stop.json`、`deployment-restart.json`、`deployment-live-restart.json` 与 `persistence-after.json`。这是限定部署场景验收，不代替原融合计划的同模型 30 场景对照或真实 QQ / surfpet 验收。

## 模型错误提示修复

部署时发现记忆管理读写正常，但真实模型缺凭据被误报为“本地能力服务不可用”。原因是被动聊天把模型异常交给通用本地能力错误转换。修复仅在 `complete()` 调用边界区分 `MODEL_AUTH_REQUIRED` 与 `MODEL_UNAVAILABLE`，给出 DSH 模型设置提示；真正的 `CapabilityError` 保留原结构化语义。供应商原始文本不进入这一聊天路径的响应、状态和模型日志。

选择分阶段捕获而非全局修改 `errorResult()`，以保留存储、角色代次与服务故障的语义。插件宿主重启后生效。真实缺密钥调用已验证返回 `MODEL_AUTH_REQUIRED`；用户配置密钥后真实回复成功。桌宠集成由 12 增至 16 项，增加缺凭据、一般模型错误、本地前置失败和后置存储失败；伪密钥不回显。插件桌宠测试及 16 项回归通过，独立审查补充验证流结束时的认证错误和模型边界内的真实 `CapabilityError`。

本轮首轮 `npm run test:audit` 为 107/108，唯一失败是首次融合提交后 `release/install-manifest.json` 仍对应上游旧 HEAD。清单必须从已提交的 Git 对象重新生成，再用 `node scripts/test-release-manifest.mjs` 与最终审计核验；不能跳过该门禁或按 Windows 工作区字节生成清单。最终执行证据保存在 `.local/evidence/deployment-final-audit.log`。

## 回滚与交接

回滚：运行 stop 停止本脚本确认拥有的进程，保留整个 `.local` 目录；然后恢复原来的两个手工隔离启动命令。不删除数据库或会话，不修改用户默认 `.dsh`。若进程记录损坏，按错误提示人工核验身份，脚本保持拒绝终止状态。

发布交接块：

```text
改动文件：部署脚本及测试、pet-chat.js及其集成测试、本case与受影响使用/交接/坑记录、生成安装清单。
已测：10项部署检查、19项真实管理接口、16项桌宠集成、插件桌宠及16项回归、实际启停与恢复持久化、真实DeepSeek模型回复与纠正/删除记忆联调。
建议版本：不在本编辑任务定版；独立发布时按部署入口新增能力评估。
改动层级：新增运维入口，纠正模型异常的错误归类；记忆协议及已有启动命令保持兼容。
完整逻辑与爆炸半径：见本 case；仅管理身份匹配的脚本实例，全部状态在仓库 .local。
失败路径：JSON code/error/hint + 非零退出；未知端口、PID 重用、状态损坏和并发操作都有拒绝路径测试。
未验证：原融合计划同模型30场景对照、真实QQ和独立surfpet；B站自主发送仍暂停。
未做：版本发布、QQ/surfpet实发、用户默认 ~/.dsh 修改；代码保存到用户fork开发分支。
```
