# 主动投递凭据跨异步等待过期

## 现象、根因与取舍

独立审查让120秒凭据在最后策略调用等待期间从119秒变成121秒；原实现仍调用发送器一次。TTL只在 await 前检查，异步完成后的通过结果已经失效。选择在每个返回/外部副作用边界同步检查现有绝对到期时间；另一路是延长或自动刷新TTL，会使过期内容重新获准，故不采用。

## 完整逻辑

1. 宿主 channel.issueIntent 创建固定正文/主人/上下文/TTL，bridge通过认证claim消费一次凭据；每次核验调用本地服务，最后调用OneBot。
2. validateIntent 在异步策略和双上下文核验后重核到期；handler在后续IPC结束、返回结果前也重核。claim把可信 expiresAt交给bridge，最终注意力RPC返回后、transport前同步拒绝到期；恰好到期也拒绝。
3. 影响宿主与桥接两进程的主动投递；被动聊天不读该凭据。只拦过期消息，不改正文、主人、预算和权限。失败可见，无新增模型调用。
4. 此为T1第三次尝试中root接管的局部修补，独立reviewer保持只读。未重写作者主体协调器。
5. 宿主与QQ桥接需要共同重启；旧宿主缺expiresAt时新桥接拒绝主动发送，不放宽兼容。finalize/finish不返回内容，过期后仍允许结算failed/unknown，不让预留卡住。
6. `node plugins/surfcore/scripts/test-autonomous-companion.mjs` 32组通过，新增policy/context/最终IPC响应三个位置×120秒/121秒六种情形全部零发送且failed可结算；原独立反例由sends=1变COMPANION_STOPPED/sends=0。渠道18与协议regressions16通过；独立定向复验PASS。
7. 改前3文件保存在 `.local/backups/t1-attempt3-root`，完整窄补丁及hash见 `.local/evidence/full-integration/t1-attempt3-*`。不得仅回滚TTL守卫后继续启用自主发送；回滚该批前先停用协调器。真实模型/QQ主动发送与长期运行另行验收。

## 发布交接

仅channel.js、local-capabilities-bridge.js及对应测试；版本保持0.8.6。最终交付前运行audit、插件与协议检查，生成当前HEAD安装清单。本case不宣称完整融合已交付。
