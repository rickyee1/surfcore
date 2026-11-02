# 本地记忆整理、加密备份与恢复管理入口

状态：代码与隔离 HTTP/真实页面已验证；完整融合与真实用户数据库部署验收另记。

## 现象与根因

T2a 提供了来源提案、索引、加密快照和恢复协议，但管理页没有可用入口。直接暴露后端文件路径会扩大本机文件访问，恢复成功或响应丢失后继续使用旧角色绑定也会产生迟到回复。首次集成的测试直接挂载管理 handler，漏过 DSH 外层仅接受 JSON 的 route wrapper，实际二进制上传被 HTTP 415 拦住。

## 完整逻辑

1. **链路**：DSH 的 exact route → management.js cookie/随机header/Origin校验 → facade 管理白名单 → 单 Python/SQLCipher服务；备份文件由 backup-transfer.js 在固定所属目录内处理。管理页用于来源修订、整理记录、索引与恢复确认；普通模型和QQ入口不取得这些管理方法。
2. **机制**：`.scmemory` 只封装口令加密快照与有界清单，不含密钥/旧授权。导入只保存，预览后暂存，再明确确认替换；删除日志优先。外来或删除权威不可核对的恢复暂停回答，复审绑定当前恢复ID、记忆版本及摘要。restore commit无论成功或未知都清宿主缓存，旧生成不可重放。
3. **影响面**：浏览器和宿主/Python三处读取路径；涉及记忆可见性及加密口令，不调用模型或外部平台。测试仅创建随机隔离库，不触碰用户记忆。
4. **取舍**：任意路径复制虽短但难以约束；选择固定ID/目录、大小与散列验证、独占落盘。上传采用精确路径的二进制类型例外；其它POST仍只接受JSON，鉴权不变。
5. **生效**：宿主服务重启后读取新的管理JS/HTML；升级实际库前保留当前加密数据、删除日志、受保护密钥与配置。无需修改账号凭据。
6. **验证**：`node scripts/test-local-capabilities-management.mjs` 执行实际DSH wrapper、真实HTTP和隔离SQLCipher，共12项；合法导入、坏口令/损坏/链接/越界、DSH/Origin/cookie/header、外来恢复复审、未知结果清缓存均通过。已有接线20项回归通过。独立 reviewer 管理 attempt2 PASS。Edge真实页面搜索/来源修订、口令预览、恢复按钮确认门槛、清空口令和取消恢复已验证；截图 `.local/evidence/full-integration/management-restore-ui.png`。下载HTTP返回可验证加密文件；浏览器扩展文件选择缺权限，浏览器历史页面被策略阻止，未扩大权限或绕过，故不把浏览器实际落盘/文件选择标为已测。
7. **回滚与残余**：改前文件在 `.local/backups/full-integration-management-attempt2`；仅回退宿主界面不能删除/绕过新删除权威，恢复时遵守 T2a case。工具、语音、向量与完整角色包仍是后续单元，不能由这12项推断全部完成。

## 发布交接

第二批接线增加同一已鉴权页面的 `/tools` 入口，浏览器操作白名单独立于宿主，明确拒绝工具提案/执行、目的地登记、导出准备/消费/校验/结算。语义整理状态和“现在整理”只转发已存在的宿主队列，参数仅可含已有 `scopeId`，不能提交正文或权限；缺整理器和前台聊天占用都显示结构化错误。主会话负责这段局部集成，工具页面主体由执行者交付并独立验收。实际外层DSH wrapper、HTTP和隔离SQLCipher检查现为15项通过，包括工具页双重会话鉴权、host-only调用拒绝、整理器缺失/占用/非法字段；证据 `.local/evidence/full-integration/t3u-mount-management.log`。新真实浏览器工具验收记录在 `.local/evidence/t3u/attempt3-root-ui-evidence.json`。Writer真实模型与工具聊天交付仍单独验收；本管理页测试没有调用模型。第二批覆盖前备份在 `.local/backups/t3u-mount-attempt1/`、`.local/backups/writer-ui-mount-attempt1/`。

不改版本、tag或Release。受影响文件为本地管理HTML/handler/加密传输、facade.management 与 index.js exact route；新增管理测试需加入本地能力测试链。最终提交前运行 audit、协议回归与插件测试，并按 HEAD 生成/核对安装清单。真实数据升级与长时间观察证据由主会话补充。
