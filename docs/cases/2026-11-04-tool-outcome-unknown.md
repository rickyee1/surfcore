# 工具执行 unknown 被误报为失败

实现由 `/root/tool_outcome_copy` 完成，基线为 `3c7d139c2aa622ad31866ab9ccf76c86c0285244`，记录日期为2026-11-04。主控在功能验收后整理本页排版。

## 1. 链路与现象

主控通过真实 Pet 入口确认打开合成目录，核验Explorer窗口399082的路径与sample.txt正确。原执行 `f3b51d12e4c54c35921a3bb28b5b9eb9` 为unknown / OUTCOME_UNKNOWN。Python broker summary经过host step/catch与job metadata到达本机工具页时，被描述为“未完成/失败”，用户难以判断是否应重试。该窗口核验来自主控既有记录。

## 2. 机制与根因

Explorer进程退出状态提供进程层确认，窗口实际呈现还需独立核验。非零返回或三秒超时记为unknown符合T3_API。summary使用通用错误文案，host又丢弃error/hint，catch遗漏execution.state=unknown，导致终态和说明失真。

## 3. 影响面

涉及Python服务和DSH宿主两个进程，状态由工具页执行记录和宿主任务两处读取。误报可能诱导重复副作用。此次变更限于summary、host终态和错误呈现，原真实执行继续保留unknown。

## 4. 两条路线及取舍

路线A通过窗口观测决定succeeded，需要新增可靠窗口识别和契约调整，成本与影响面较大。路线B保留保守unknown，复用broker error/hint，明确说明操作可能生效并请用户核对窗口，改动局限且可按文件回滚。本次采用路线B。failed/cancelled继续沿用既有host处理。

## 5. 生效与回滚

broker为unknown提供专门说明，host使用原error_code/error/hint，缺字段时提供对应后备文案，catch保留unknown。工具页现有组件显示execution错误与host lastError。正式生效需要重启Python本地能力服务和DSH宿主。回滚使用备份还原两份源文件，执行记录继续由持久账本保存。此单元冻结时尚待主控集成部署。

## 6. 验证

Python既有测试以隔离登记根和mock Popen覆盖零返回、非零、TimeoutExpired和异常，核对终态、code/error/hint、三秒参数与重复execute的单次启动约束，全套42项通过。JS覆盖status/execute两路及unknown/failed/cancelled，验证原错误提示、终态与后续处理停止。最终受保护的host30、工具页35、regressions16和audit110/110通过。

audit初轮108/110的两项失败分别来自缺少隔离config.json和preset的CRLF文本差异。测试环境从example创建合成配置，在证明preset规范化后等于HEAD并备份后恢复HEAD的LF字节。stickers71及preset契约定点检查通过。独立审查还通过两路缺失错误字段的后备文案检查，并核对五份源文件、18项证据哈希和补丁重建。

## 7. 测试事故、残余和交接

最初三次JS夹具在handle之后才安装RPC mock，异步step可能先调用真实adapter并打开TEMP合成目录。失败日志host-attempt1/2/3.log保留，第三次出现TOOL_BUSY。只读进程清单记录同期Explorer embedding，无法可靠关联其目标。旧finally在收到保留指令前已删除临时根，随机根名无法追溯，实际副作用情况仍有不确定性。

第四次改为handle前安装mock，30项通过。最终夹具进一步在Python服务启动前硬拒绝subprocess.Popen，并在handle前拦截全部tool.execute，经主控静态核对后复跑30项通过。最终夹具根标识为surfcore-tool-host-tYJut6。早期事故归属于测试夹具，必须随结果保留。实际GUI、模型、平台和设备的后续验证由集成任务分别记录。

## 可转发交接块

> 实现层patch修复broker文案、host终态及原错误透传，原执行保留unknown。Python42、host30、UI35、regressions16、audit110/110及独立功能验收通过。正式生效需要Python服务和DSH重启。完整逻辑、回滚与早期夹具的GUI副作用不确定性见本case。补丁、freeze和完整日志在独立树的.local/evidence/tool-outcome-20261104。建议按兼容patch交给发布会话评估版本。
