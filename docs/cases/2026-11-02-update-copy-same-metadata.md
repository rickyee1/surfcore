# 更新助手不能把相同元数据当成相同内容

任务 `/root/capability_service`，update-copy attempt2；2026-11-02。只改更新助手
复制参数和现有隔离回归，不执行真实更新、不操作宿主/SnowLuma或用户安装目录。

## 完整逻辑七步

1. **链路**：`plugins/surfcore/lib/updates.js` 校验下载暂存包与安装证据，生成 pending，
   启动独立 `scripts/apply-update.mjs` 等宿主退出。helper 调 robocopy 覆盖目标，写
   安装记录，核对 `package.json.version === pending.to` 后才写 verified 回执。
   设置页通过原更新服务读取 pending/failed/applied，现有失败分类不变。
2. **机制**：robocopy `/E` 包含子目录和空目录，但默认可能跳过大小、修改时间相同的
   “Same”文件，并不按正文哈希判等。若 NTFS ChangeTime 不同，则另分为“Modified”，
   `/IS` 不会覆盖此类；本机 `robocopy /?` 明确要求 `/IM`。短版本号长度相同，快速写入或归档时间精度可使
   元数据碰撞；普通代码文件也可能碰撞。只查版本可能留下旧代码而仍报告 verified。
   首次审计失败夹具已被 finally 清除，无法回读当时的 mtime；原脚本独立复跑通过。
   attempt1 同元数据夹具复现旧 helper exit4，增 `/IS` 后通过，但独立评审又实际复现
   Modified 类：helper 同版本 exit0/verified=true，正文仍 OLD 且与安装清单不符。
   attempt2 在源文件准备后等 25ms 再建立目标，固定同 size/mtimeNs、不同 ctimeNs，
   重现这个分类；不把原审计已消失的现场时间戳冒充已观测事实。
3. **影响面**：ZIP helper 最终采用 `/E /IS /IM`，本次只增 `/IM`。`/XD`、`/XF`、robocopy 退出码
   判据、暂存清单验证和安装后版本拒绝保持原规则。没有 `/MIR` 或 `/PURGE`，不会因
   源包缺少文件而删目标额外文件；用户 config/state/pet/characters 等全部排除仍生效。
   git 更新路径不改。
4. **取舍**：只让测试延迟写入/错开 mtime 成本低，但掩盖真实复制缺口；自行逐文件
   比哈希再复制成本高且重复文件系统逻辑。采用本机 robocopy 明示的 `/IS`（Include
   Same files）与 `/IM`（Include Modified files），分别覆盖两个类别，保留原所有排除。
   代价是多复制部分正文原本相同的发布文件；本次回滚只涉及 `/IM` 及对应测试。
5. **生效**：后续由更新服务 spawn 的 helper 读取新脚本。已经启动、解析过旧脚本的
   helper 不会自动变更；部署/重载由主会话安排。本修复不启动真实 pending，不要求
   迁移数据、修改用户配置或中断当前 DSH/QQ/桌宠。
6. **验证**：attempt1 原红绿证据保留。attempt2 独立合成目录中，真实 robocopy
   `/E /IS` 把固定 ctimeNs 差异的 owned.js 列为“已修改”，正文保留 OLD；
   `/E /IS /IM` 同类别复制为 NEW。首轮 frozen helper 同版本 exit0，实际清单匹配为 false；
   增 `/IM` 后实际正文与清单一致。新回归先红两项（正文/清单），随后完整
   `test-update-apply-result.mjs` 通过。14 个保护路径包括 nested config、pet、characters、
   state、.git 与其它原排除；目标独有文件保留、空目录复制，以及错误期望版本仍拒绝。
   `test-update-version-fallback.mjs`、两文件语法和定向 diff 检查通过。
   证据在 `.local/evidence/update-copy/attempt2/`；完整审计由 root 合并后统一重跑。
7. **回滚与残余**：从 `.local/evidence/update-copy/attempt2/backup-path.txt` 所指备份
   恢复两个源文件及 case 即可撤本次修复，不恢复或删除任何安装数据；仅 `/IS` 仍有
   Modified 类缺口，不能当作安全版本部署。真实升级、其他文件系统/Windows版本、网络下载、进程占用与断电
   行为未在本单新增验收。本机官方 `robocopy /?`、原始/修复夹具和日志均保留在该
   evidence 目录。没有修改版本、提交、推送或执行发布。

## 发布交接块

- 改动：`scripts/apply-update.mjs` 的 ZIP 复制在 `/E /IS` 基础上增 `/IM`，保留全部排除项；
  `scripts/test-update-apply-result.mjs` 固定 Modified 类并验证实际正文、清单和14项保护。
- 机制：相同 size/mtime 可能是 Same 或 ChangeTime 不同的 Modified；两类均复制，版本与清单门槛不放宽。
- 验证：首轮 helper 在 Modified 类假成功，新回归先红两项后绿；实际 robocopy 分类/对照、完整脚本和版本 fallback 通过。
- 生效：由主会话加载新 helper；不在已运行 helper/真实更新中替换。本单未部署。
- 回滚：仅恢复备份源文件，不改安装目录、用户文件或版本；残余见七步说明。
- 门禁：root 最终整合 audit/manifest，critical 独立复验后再合并。
