# A01 原生双版本评测 harness（T6-A01 attempt3）

执行者 `/root/tools_ui`；工作区 `D:/luyao_companion_v0_1/surfcore-luyao`。只新增 `scripts/a01-*.mjs`、`scripts/fixtures/a01-native/` 和本文。未修改 bridge、pet、DSH 配置或冻结的30场景 JSON；未启动真实 DSH、读取真实凭据正文、调用模型或连接 QQ/B站。本交付是可评审的 runner/factory，不是 A01 体验通过证据。

## 完整逻辑（七步）

1. **链路**：`a01-native-runner.mjs plan` 冻结两repo refs与fixture/harness/persona哈希 → 120个随机交错场景运行（30×2版本×2重复）→ 每次git archive生成独立可写试验树 → `a01-dsh-factory.mjs` 创建全新用户目录/DSH_HOME/profile → 原生 SurfCore bundle/presets/MCP 与 `a01-native-host.mjs` 加载在同一DSH上下文。桌宠实际调用该版本的 `createPetChatService().chat`，其原生提示词和历史机制保持在原模块内；QQ实际启动该版本 `src/bridge.js`，通过原生 DSH sessions/presets/MCP 运行，只将 OneBot HTTP/WS 传输替换为回环记录器。原版ref必须为 `59ec3066f7d42a0452fae01f170c9a8484d5dbe5`；融合版ref由最终验收冻结，不用legacy模式模拟原版。
2. **机制**：fixture字节SHA256固定为 `a37c4a112fd8c0f9451c43765a9b9b8f8445f43df5c5683af2b099e35f24d1f5`。同一人格与合成账号在每trial经原生角色API建立；原版经原生memory-card API建立QQ/pet事实，融合版经原生binding/context/ingest建立对应主体事实；history作为原生入站预热重放，不拼进手写system/user提示词。原版没有的每群细分范围保留为来源标签并明确记录nativeScope限制，不给原版发明隔离器。`llm.prepareCall/stream/resolveCallWithInfo`只作透明观察，保留原options、configure、frozen单次handle、取消、异常、chunk和finish；实际resolved参数、contextWindow、usage、callId与生成的合成assistant输出单独记录，不记录system/messages/headers/凭据。原生session/event记录tool/call/result与turn/start/end，无工具参数。准备但未dispatch的handle单列，不冒充模型请求。
3. **爆炸半径**：当前验证为1个自检进程×回环记录器/假CLI子进程×可见失败1；不接触真实用户库、用户profile或平台。未来显式run仅使用指定的模型材料目录，factory只逐字复制 `.credentials.yaml`，不解析/哈希/输出其正文。环境白名单移除继承的provider/platform变量；HOME、USERPROFILE、APPDATA、LOCALAPPDATA、TEMP、DSH_HOME全部指向trial子目录。DSH stdout/stderr只排空，不提取登录URL或token；原桥接自己使用隔离DSH_HOME的原生认证。子进程只按本次持有的PID/子树停止，清理失败保留记录并中止批次。不会扩大ACL。
4. **取舍**：A直接给两模型写提示词比较，开发快但绕开原生历史、preset、等待、分条、收尾与代次守卫，不符合验收。B使用实际Git版本、DSH和bridge，仅替换平台传输，成本是每trial启动隔离宿主，但调用路径可核验。选择B；不向生产bridge新增seam，也不复用会改写逻辑的VM审计harness。Windows系统tar无法解出原版中文路径已由确定性自检复现，改用Git UTF-8 ZIP + PowerShell Expand-Archive；不改原版字节，保留归档供核验。
5. **生效与重启**：新增脚本不进入生产启动流程。root需先冻结融合版ref，使用已明确选择模型的最小材料；只先执行 `--smoke-original`（固定A01-02桌宠、A01-01 QQ chat，均repeat1），真实安装CLI/profile/原版认证/telemetry尚未验证时不跑120。每trial重启全新DSH和原生bridge。当前安装入口由本机 `dsh.cmd` 源码确认是 Desktop executable + `--expose-internals .../dsh-desktop-host/lib/cli.js --profile web --host 127.0.0.1 --port N --no-open`；尚未以真实CLI启动验证。installed `dsh/lib/profile-boot-C14i-8IN.js`明确以空root叠加已有profile的bundle列表，因此factory显式注册且只注册 `@deepseek-ai/dsh-base`、`@deepseek-ai/dsh-web-app`、`surfcore`，不依赖隐式补base/web，也不复制用户其他插件。
6. **验证**：`node scripts/a01-self-check.mjs` 检查冻结ref/fixture、120次随机计划、环境隔离、透明llm观察、实际SnowLuma SDK WS+HTTP、气泡边界、目标拒绝、盲评60对保留失败和NOT_RUN、硬失败优先、参数比较、copy-only模型种子、假CLI实际子进程生命周期，以及真实原版归档字节保留。所有模型行为均为明确的确定性stub，不能当作A01原生运行通过。`npm run test:regressions`通过；`npm run test:audit`为107/108，唯一既有发布清单对HEAD不一致失败。完整结果、退出码和日志在 `.local/evidence/a01/checks.json`。源代码语法与完整diff核验结果也在该目录。
7. **回滚与残余**：未接入生产，无需生产重启；停止本次owned子进程即可停评测，不删结果、不覆盖已有batch。真实DSH/profile加载、native cookie认证、实际adapter telemetry可观察性、原生记忆事实是否进入正确上下文、reserved2八场景完整工具回合及120次付费运行/人工盲评全部仍为NOT_VERIFIED。任何失败、超时、挂起、未交付、不支持项保留在120分母；setup/cleanup失败中止剩余调度并留下NOT_RUN。原生pet内部降档/重试仍按原版行为观察，不静默删去；harness自身不重试场景。模型metadata无独立版本字段时明确保留null，不猜测版本。第二输入无reply消息ID时只给时间窗口延迟并标为归因未证实，需盲评结合完整气泡核对。

## 文件与运行契约

- `scripts/a01-contract.mjs`：冻结fixture、ref/范围校验、随机计划、参数比较、盲评pack与三维不劣/硬失败判定。
- `scripts/a01-native-runner.mjs`：plan/preflight/run/assess；原生试验树、进程、入站时序、气泡/延迟/未交付、完整120分母。
- `scripts/a01-dsh-factory.mjs`：可执行隔离profile/bundle/MCP/模型材料接线、真实CLI启动/ready核验及owned停止；不是待root补实现的stub。
- `scripts/a01-native-host.mjs`：真实DSH ctx中的原生pet/角色/记忆、session工具事件、透明llm参数/usage观察。控制端点仅回环POST+随机header，不开放浏览器Origin。
- `scripts/a01-onebot-recorder.mjs`：只有合成目标的有界OneBot HTTP/WS记录器，不连接SnowLuma。
- `scripts/a01-self-check.mjs`、`scripts/fixtures/a01-native/{persona.md,fake-cli.mjs}`：确定性自检与公共合成人格；fake CLI不会用于真实A01。

先生成最终计划，操作不会启动宿主或调用模型：

```powershell
node scripts/a01-native-runner.mjs plan --original .local/evaluations/a01/original-59ec3066 --fork . --fork-ref <最终40位commit> --seed a01-final-batch --out .local/evaluations/a01/final-plan.private.json
node scripts/a01-native-runner.mjs preflight --plan .local/evaluations/a01/final-plan.private.json
```

root另行明确执行极小真实预检（本执行者未执行）：

```powershell
node scripts/a01-native-runner.mjs run --execute --smoke-original --plan .local/evaluations/a01/final-plan.private.json --out .local/evaluations/a01/new-smoke --dependencies D:/luyao_companion_v0_1/surfcore-luyao/node_modules --model-seed D:/luyao_companion_v0_1/surfcore-luyao/.local/evaluations/a01/model-seed --dsh-executable "D:/DSH/DeepSeek Harness.exe" --cli-entry D:/DSH/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js --python D:/luyao_companion_v0_1/surfcore-luyao/.venv/Scripts/python.exe
```

两个原版trial实际路径均通过后，root才能在新输出目录、同一冻结计划上去掉 `--smoke-original` 进行完整120次运行。未显式传 `--execute` 不启动；已有batch不覆盖、不自动resume。factory不读取用户默认DSH_HOME、不抽取登录token；如原版不能原生认证，保留 `NATIVE_BRIDGE_NOT_READY` 并先停下调查，不改原版代码。

输出：每trial `result.json`/host attestation/进程记录/试验树；batch `results.private.json`、`plan.private.json`、`blind-pack.json`、`blind-mapping.private.json`、`summary.json`。只将blind-pack交评审，private mapping留本机。blind-pack保留完整气泡边界与输入时序、usage/finish、未交付输出，不出现版本标签或实现路径；不能以内部文本冒充实际交付。填完三维0–4分与硬失败列表后运行：

```powershell
node scripts/a01-native-runner.mjs assess --plan <冻结plan.private.json> --pack <已评分盲评pack> --mapping <private mapping> --results <private results> --out <新报告路径>
```

至少24/30三个维度均不低于原版才满足不劣；融合版任一次泄漏、虚构已执行或漏答明确请求直接FAIL，不能被均分抵消；未评分/模型参数不等/实际工具回合未核验保持NOT_VERIFIED。该报告不替代独立验收。

## 可转发交接块

改动：上述6个新脚本、2个新fixture及本文；无生产文件修改。检查：确定性自检及日志见 `.local/evidence/a01/`，regressions通过，audit107/108仅既有发布清单失败；建议minor（新增独立验收工具，版本由发布会话决定）；case：本文；层级：离线评测编排与隔离运行契约；失败可见：结构化code/hint、失败/挂起/未交付及未运行分母保留、setup/cleanup失败停止批次；未验证：真实原版1pet/1qq预检与全120次/盲评。READY_FOR_REVIEW，不宣称A01体验通过。


## attempt2 集中修复与验收边界

独立FAIL包 `.local/evidence/a01/review-attempt1.md` 针对两项：评分删去6场景且raw=[]仍可能PASS；原生宿主按platforms.start.qq启动桥接、与runner竞争。attempt1完整证据保存在 `attempt1/`，本轮不改生产代码或冻结fixture。

- F1：assess入口必须读取冻结plan；核验固定30场景、120个唯一trial、每场景每版本每重复唯一、60个唯一pair；mapping须与冻结seed的确定性映射一致。除scores/hardFailures外，pack全部内容须等于raw results重建值。raw缺失/重复/身份不符、pair或mapping变更、气泡和输入篡改都返回NOT_VERIFIED；只prepare未dispatch、无finish或无结束时间不能充当真实模型调用。保持三维两次均分与任一融合硬失败直接FAIL规则。CLI无--plan不能评分通过。
- F2：factory环境最后强制 `SURFCORE_SKIP_AUTOSTART=1`，不能被extra覆盖；QQ平台仍启用，只有runner人工启动原生bridge，pet不启动bridge。关闭 `updates.enabled` 与 `updates.checkOnStart`。DSH ready校验当前持有的alive child PID与endpoint报告pid/trial/repo/home；QQ ready校验alive child、原生bridge.lock PID以及status.root/DSH URL/mode，不能借用另一桥接的ready状态。
- 验证：18项确定性checks通过，其中评分伪PASS矩阵13类拒绝、实际assess CLI空结果拒绝；VM提取执行原版和fork真实maybeAutoStartBridge函数，以及真实updates.startAutoCheck配置表达式，验证pet零桥接/QQ仅runner一个owner/更新关闭。持有子进程退出和错PID/lock/root/URL均拒绝。fake CLI进程生命周期和真实原版归档仍通过，不冒充真实DSH验证。
- 完整/窄检查、实际退出码及剩余全仓发布清单问题见 `.local/evidence/a01/checks.json` 和 `attempt2-*.log`；完整新增差异 `full.diff`、相对attempt1最小修复 `repair.diff`、哈希 `manifest.json`。
- 原版真实tiny smoke、实际模型参数/usage观察、120场景和人工盲评仍NOT_VERIFIED。先独立验收attempt2，再由root做固定原版1pet/1QQ smoke；不自动重试、不将缺失运行移出分母。本执行者只负责9个原有交付文件，未触碰root新增语义文件。

## attempt3：真实宿主加载事务修补

主会话接管局部 runtime 装配修补，不重置尝试计数。已保留第一次原版 smoke 的失败分母和输出：宿主启动超时，零模型请求，`DSH_START_NOT_VERIFIED`。只启动、不调用模型的隔离诊断 v3 证明 apply 已进入且停在 `agentDefaultModel.saveSelection` 前后边界，ready HTTP405；安装包 ConfigEditor 明确与 Loader 热更新串行，apply 内 await 配置修改会等待当前加载事务。

选择在 factory 的 `cordis.patch.yml` 预置完整 `agent-default-model.config`，host apply 仅检查当前 provider/model/reasoningEffort 与冻结选择一致。与启动后异步改配置相比，这条路线没有模型短暂错选，也不改原版 native producer。独立 diagnostic v4 同样 20 秒观察窗口得到 ready HTTP200/JSON；确定性 18 项仍通过，现有失败记录不删除。代码与证据 `.local/evidence/a01/attempt3-startup/`；原版有模型 tiny smoke 和完整120仍待运行，禁止把启动成功称作 A01 体验通过。

改动层级为测试 factory/host 的加载事务，生产程序无改动，无真实平台/设备；所有模型材料仍 copy-only。备份在 attempt3-startup/before。回滚三个脚本后新建隔离 trial，不覆盖旧试验。交接：局部测试基础设施 patch、18 检查与真实零模型启动通过、需独立验收和真实 native 两场景后才全量；保持版本号不变。
