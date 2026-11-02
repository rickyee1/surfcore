# T4-D attempt1：只读安装包的媒体 SDK 预加载

## 1. 问题与范围

媒体协议需要两个固定版本 SDK 的内存实现，同时保持 `D:/DSH/resources/app.asar` 不变。本单只新增 preload、专属测试和本 case；不修改安装 DSH、部署脚本、channel 的离线 SDK patch、任何账号配置或用户环境。真实部署由 root 在独立审查后执行。

## 2. 原因与依据

默认 SDK 没有 `surfcore-media-image-v1` prepared-call 标记。现有 `patchMediaSdk` 已提供精确、版本绑定的两个 source；缺口是将它们加载到实际 Electron 进程。[Node 同步 registerHooks](https://nodejs.org/api/module.html#moduleregisterhooksoptions) 支持调用下游 loader 后返回 source；[Electron ASAR 文档](https://www.electronjs.org/docs/latest/tutorial/asar-archives) 说明 fs 读取归档内文件的语义。实际运行时是 Electron 内 Node 24.21.0，具有 `registerHooks`；本单验证完整 SDK 导入，不使用 VM 截取实现替代真实模块。

## 3. 最小方案与边界

`installMediaPreload({asarPath})` 只接受显式绝对 `.asar` 路径；注册前以 Buffer SHA-256 校验两原文件，调用 channel 原 `patchMediaSdk`。同步 load hook 只匹配该路径下以下两个完整 file URL：

- `dsh/node_modules/@deepseek-ai/dsh-llm/lib/index.js`
- `dsh/node_modules/@deepseek-ai/dsh-llm-deepseek/lib/index.js`

每次匹配先执行 `nextLoad`，要求原 module 格式、再次校验返回 source 的精确字节，然后仅替换 source。其他 URL 直接返回同一个下游结果；query/hash 别名不属于匹配集。错 hash、缺路径、缺 hooks、格式变化、加载漂移均拒绝，不降级。`status()` 是冻结快照，含目标 URL、原/新 source hash、已通过 load 校验的名字；它不表示 provider 已请求成功。`deregister()` 幂等，只影响后续加载，不撤销已存在的模块缓存，因此必须在 SDK 首次 import 前 preload。

## 4. 实施与使用

新增 `scripts/dsh-media-preload.mjs`。普通 library import 无副作用；`--import` 指向该文件时自动调用 installer，路径来自 `SURFCORE_DSH_MEDIA_ASAR`。可编程调用安装器时通过参数传路径，无全局 `NODE_OPTIONS` 设置，也无依赖、调度器或插件。Windows 的 preload 参数必须为 file URL，直接传 `D:/...` 会被 Node 解释为 `d:` scheme。

以下是 root 后续隔离 wrapper 的参数形态，本单没有启动此 CLI，也没有创建 wrapper：

```powershell
# 只在 wrapper 子进程的 environment 对象内设置这两个值：
# ELECTRON_RUN_AS_NODE=1
# SURFCORE_DSH_MEDIA_ASAR=D:/DSH/resources/app.asar
# executable: D:/DSH/DeepSeek Harness.exe
# argv（各元素单独传递）：
# --expose-internals
# --import
# file:///D:/luyao_companion_v0_1/surfcore-luyao/scripts/dsh-media-preload.mjs
# D:/DSH/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js
# 后续 root 已批准的隔离 profile 参数
```

## 5. 验证与反例

```powershell
node scripts/test-dsh-media-preload.mjs --proof .local/evidence/t4-d-preload/attempt1/readonly-proof.json
node scripts/test-dsh-media-sdk.mjs
node --check scripts/dsh-media-preload.mjs
node --check scripts/test-dsh-media-preload.mjs
```

专属测试 12 项：普通 library import；实际无 hook 完整两 SDK；实际 `--import` 与 `--import=` 两种形式；llm/deepseek 各自初始变动；初读后 nextLoad 变动；非 module 格式；缺 source；缺 registerHooks；缺显式 ASAR；安装 ASAR 与 channel patch 前后逐字节 hash 相同。普通外部模块、两个带 query 的 SDK、卸载后新 URL 均保持原行为；重复安装拒绝，卸载幂等。

真实完整 `DeepSeekAdapter.prepareCall` 与 `LlmRuntime.prepareCall` 使用合成惰性 provider 依赖：无 hook marker 为 null，hook marker 为 `surfcore-media-image-v1`。不调用 stream，不提供 credential resolver，fetch 设置为抛错 guard。子进程只继承少量 OS 路径，HOME/USERPROFILE/APPDATA/LOCALAPPDATA/DSH_HOME 均为新临时空目录，不复制任何模型种子或真实用户 profile。没有 API/平台调用；本单结果不等于完整模型/设备验收。

测试初期暴露了合成 registration 缺 provider 字段与 Windows preload URL 参数错误，均只修专属测试装配；缺 source 时 Node 自身先抛 `ERR_INVALID_RETURN_PROPERTY_VALUE`，测试按实际错误验证拒绝。没有放宽生产 hash/URL 条件。

## 6. 只读证据与冻结

`.local/evidence/t4-d-preload/attempt1/readonly-proof.json` 保留实际 Electron 输出、runtime 版本、marker、SDK 原 hash 与 ASAR 前后 hash；同目录 checks.json、manifest.json、full.diff 和 narrow.patch 提供本单精确冻结及检查。测试只删除其自行创建并校验父目录的临时文件。channel patch 与所有共享文件保持原字节。

## 7. 恢复与后续

撤掉隔离 wrapper 的 `--import` 参数即可回到原模块；安装包和用户配置无需恢复。DSH/SDK 更新后任何原 hash 不符都会阻止启动，须独立重审对应 SDK，不允许自动兼容。后续生产部署、真实模型与设备测试由 root 在独立接受后操作；本单没有修改系统级环境或安装物。
