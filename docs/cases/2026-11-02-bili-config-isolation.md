# B站 CLI 配置遵守隔离 DSH_HOME

日期：2026-11-02。本次仅修复配置路径，不启动调度、不访问真实 B站 账号或发送消息。

## 现象与机制

B站 CLI 的 `tools/lib/state-paths.mjs` 已按 `DSH_HOME` 隔离账号与角色数据，但 `tools/lib/config.mjs` 自行拼接 `USERPROFILE/.dsh`，没有读取 `DSH_HOME`。同一个隔离 CLI 可能使用仓库内凭据，却读到用户默认目录的偏好或发送设置；配置和数据的归属因而不一致。

`plugins/surfcore/tools/lib/config.mjs` 现在复用现有 `state-paths.mjs` 的 `BILI_CONFIG`。选择顺序为显式 `SURFCORE_BILI_CONFIG`、设置了 `DSH_HOME` 时的 `DSH_HOME/surfcore/bili.config.json`、未设置隔离环境时原有用户目录路径。选定的隔离配置不存在时继续采用中性默认值，不跨目录查找用户配置。未改凭据读取、配置合并缓存、发送命令或 `BILI_GENERATION_UNVERIFIED` 门禁。

链路为插件启动的 CLI 子进程 → 公用 config 模块 → 既有公用路径模块。影响面只覆盖读取 B站 配置的进程；没有修改真实配置、数据库或上级/原项目目录。既有只读依赖检查的子进程会立即加载新路径；已载入旧模块的长驻宿主须重启才刷新模块常量，不应为本次路径检查开启 B站 调度。

## 取舍与回滚

方案 A 为每次 CLI 调用显式传入 `SURFCORE_BILI_CONFIG`，无需改源码，但任一子进程漏传都会重现偏差。方案 B 为配置模块直接复用已有路径常量，改动小且避免第二套解析规则；选 B，不增加新抽象。回滚只需恢复该模块及对应测试；若退回旧实现，隔离运行时必须显式设置 `SURFCORE_BILI_CONFIG`，不能依赖旧路径推断。源码原件在忽略提交的 `.local/backups/bili-config-isolation-20261102-135634/`，数据不需要回迁。

## 验证

`node scripts/test-bili-state-paths.mjs` 通过，保留角色账本检查并新增四个独立 Node 子进程断言：显式路径优先、隔离 home 不读默认用户配置、隔离文件缺失时不回退、无环境变量时兼容旧用户路径。测试使用合成文件和临时目录，不读取真实用户配置。

`test-bili-automation.mjs`、`test-admin-bili-prompt.mjs`、`test-automation-config-api.mjs` 通过；`node --check plugins/surfcore/tools/lib/config.mjs` 通过。不存在新的错误返回分支；缺失文件沿用中性默认配置。真实登录/只读依赖检查由主会话另行验证，不把本次路径回归当平台验收。

发布交接：修改 `plugins/surfcore/tools/lib/config.mjs`、`scripts/test-bili-state-paths.mjs` 和本 case；实现层路径修复，兼容无隔离环境的旧路径。版本保持不变。用户后续已选择“扫码接入、读取内容和生成草稿”，调度器门禁和发送行为保持原状；对应使用与验收见 [草稿 case](2026-11-02-bili-readonly-drafts.md)。
