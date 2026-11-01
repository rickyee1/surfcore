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
| QQ chat / reserved / reserved2 | 可信消息绑定、新会话上下文、实际发送校验；保留显式发送和等待 |
| QQ closed-agent / 未纳管动作 | local 模式下拒绝，避免完整本机工具绕过治理；M3 另行接入 |
| B站 | 公共记忆投影；自主调度因 CLI 发送未绑定生成代次而暂停，返回 `BILI_GENERATION_UNVERIFIED` |
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

未开启时可继续 legacy。正式写入后先暂停、导出核对，再明确修复或回迁，不能直接覆盖旧快照。保留 `.local/` 数据库和 `key.dpapi`，不要提交到 Git，也不要复制原路遥密钥。新库加密不代表原 DSH 日志、平台消息或导出的明文 JSON 同样加密。
