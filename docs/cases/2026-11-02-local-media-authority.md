# 本机媒体租约与独立设备进程（T4-P）

2026-11-02；`/root/capability_service` T4-P attempt1及集中修复attempt2，基线
`cc7426889725fc07684f67652af608ba842246b2`。本单是Python可评审实现，
不等于真实麦克风、扬声器、AEC回声效果、Windows锁屏或窗口捕获已验收。

## 完整逻辑七步

1. **链路**：受信host的management binding → media_authority → 具体原pet的
   immutable短租约 → 单独start → 提交后的media_runtime → Windows Job Object
   内设备worker。worker发ASR/窗口帧事件；主线程重核角色、权限、设备、可见性和
   时限后才纳入本机RAM预览。媒体worker不生成聊天，固定模型由host的T3-H调用，
   每轮delivery绑定context_ref、memory_epoch、原pet三元组和确定选择。
2. **机制**：录音/驱动、ASR加载、SAPI、WGC在JSONL线程执行会阻塞停止；
   旧回调也可能在切角后复活。现在只有主线程管理许可与结果，所有外部动作在提交后
   启动，有界pipe线程不碰DB。WTS、紧停、角色/权限、心跳和租约由独立50ms轮询
   核验；停止立即discard并终结进程，晚到结果无法进入新角色或重新播放。
3. **爆炸半径**：只改core必要seams/provenance，新增媒体authority/runtime/worker、
   media_native适配器、API、依赖/模型清单、专属测试和本case。没有修改JS/版本/
   shared docs、原Luyao或实际用户库，也没有读取实际模型凭据。未开麦、未播音、
   未捕获屏幕。实际终止的进程只限本测试创建的无设备helper及其Job子进程。
4. **取舍**：主线程或复用旧Luyao聊天服务改动少，但会引入第二编排器和取消阻塞。
   选择复用原本地音频/窗口适配器的受控副本，重建本仓库单一authority，聊天仍属
   SurfCore/DSH。Job Object只做生命周期containment，不声称OS文件/网络sandbox；
   worker不接收DB路径、key、provider凭据，只有受限匿名pipe和固定公共模型路径。
5. **生效与迁移**：重启独立能力进程；新增media_config（enabled/provider偏好）和
   media_audit（有界元数据）两表。所有设备租约/原始PCM/帧/转写/delivery只在RAM，
   不进DB/日志/记忆，重启不恢复。enabled偏好持久也不能自动打开设备；旧外部voxd
   偏好保留，只有用户明确选择SAPI时才切到本受控输出；绝不静默fallback或双播音。
6. **验证**：`python scripts/test-local-capabilities-media.py`，以及原tools/semantic/
   backend/service回归。attempt1媒体21项通过但独立审查FAIL；attempt2媒体34项通过，涵盖权限、confirm不start、PTT松手、同帧
   hash、context/epoch、barge-in、晚TTS、设备fingerprint、WTS/紧停/期限、3秒可见
   pulse、提交失败、有界队列、真实Windows父硬退出Kill-on-close。公共wav真ASR/
   VAD、真实KWS加载和native WebRTC AEC静音帧通过；这些均不是物理设备验收。
   两轮命令/日志/最终hash在 `.local/evidence/t4-media/attempt1/`、`attempt2/`。
7. **回滚与残余**：停止独立服务后恢复
   `.local/backups/t4-media-attempt1-30718c5b0a1f467ca27de7a47003f172` 的core/provenance；
   新增表可留存，保留SQLCipher DB、DPAPI和删除ledger，不回滚用户数据。host/UI
   必须落实trusted-only准备/consume、同页可见pulse、固定模型、legacy audioKey抑制、
   screen/history隔离，再由用户在完成页面激活实际设备。此单未部署；后续T5作者的
   core/storage机械接缝保持不动，不包含在attempt2修复中。

## Attempt2：独立审查两根因的集中修复

1. **链路**：来源PTT/handsfree的lease→result→delivery→独立output或同一duplex
   合成线程→PCM队列→native callback。原来只在speech.start核来源，此后output只核
   自身900秒许可，来源撤销仍可能播放。现authority独立poll及提交后检查整条依赖，
   下发固定source generation取消；worker控制接收线程立即撤合成token，回调再核同一
   speech许可，失效输出静音/清队列，不把晚SAPI缓冲接到新回合。
2. **机制**：原lease.start在COMMIT前检查，window verify、COMMIT或模型初始化耗时
   可以越过签署expiry；旧免提还用max(1,remaining)把已过期设置延长一秒。现提交后发
   start/speak前重查原角色/权限/两种deadline/pulse，worker保留原绝对期限，模型和
   原生身份核验后、stream构造/start、WGC start/copy和PCM render边界重核，不刷新授权。
3. **影响面**：只修改T4 authority/delivery/worker及其native副本、测试/API/provenance/
   case；没有改core、storage、schema或portable。真实用户库/凭据/设备/运行中服务未操作。
   独立output撤音保留其余有效lease；免提旧speech撤销不重开或延长采集。sent是交付收据，
   不是播放完成；有效sent语音可播完，但原TTL仍到期即停，reply.finished才解除播放跟踪。
4. **取舍**：每次失效直接强杀整个output/handsfree进程代码较少，但会连正常输入一起
   关掉；仅补父poll无法挡住模型/原生setup后的晚效果。选择沿既有speech.stop传播固定
   generation，并在本地worker/native边界复核，成本限于原T4模块，回滚不触T5接缝。
5. **生效**：更新后需由root重启隔离能力进程；不增加表或迁移用户数据。所有租约和
   待播token依旧RAM，旧进程停后不恢复。window单帧worker退出后的同帧preview可pulse，
   只保持本机预览授权，不重启capture或把已退出worker当新设备进程。
6. **证据**：`.local/evidence/t4-media/attempt2/red.log`先复现COMMIT跨期仍启动三模式、
   来源撤销后实际output worker写出320byte合成PCM；随后34项媒体绿测含PTT/独立输出、
   handsfree晚SAPI/排队PCM、epoch/turn/源撤销/TTL/可见性失效、exact expiry及expiry+1、
   提交/模型初始化/window verify gate的0原生open/capture、正常sent继续播音。测试只用
   合成设备/sink；真实公共wav ASR/VAD/KWS/native AEC和自建Windows Job helper仍通过。
   工具42、semantic22、backend31、service23、JS20/16/18回归通过；完整结果见checks.json。
7. **回滚与残余**：只恢复attempt2 backup-path.txt所指目录内本次更改的媒体模块；
   不回退core/storage/T5。provenance仅撤本次repair_attempt2字段，保留其余归因。
   原attempt1独立FAIL快照仅作取证，不能据此启设备。真实麦克风、扬声器、AEC回声、
   锁屏和窗口捕获仍NOT_VERIFIED，须由root在UI就绪后用户显式激活验收；本次没有部署/
   提交/推送。

## 授权与数据

API详见 `services/local-capabilities/T4_MEDIA_API.md`。media操作只给management/受信
host，原subject必须platform=pet且owner；QQ共享owner记忆、群、Bili都不继承设备权。
UI只能枚举/状态/设置、对已准备对象confirm、stop/revoke和本机预览；不能自填
model_selection/subject、准备或消费。租约确认展示实际设备/声音/window PID+creation/
HWND、具体用途和固定模型，confirm本身不start。

PTT每次<=30秒，松手discard:false仅停止采集并本地完成ASR，必须显示转写后点击Send。
其他停止、撤权、紧停、WTS、父退出、切角、失心跳和超时均discard，false不可绕过。
免提<=900秒、最多40轮，KWS→VAD→ASR，思考/朗读时发声可清空旧音频和旧回合。
窗口默认单次，限时也<=60秒/3帧，WGC单工作8秒，只有选中HWND，无桌面fallback。

启动给3秒初始可见窗口；host只在同一控制页/原pet真实可见心跳后通常750ms发pulse。
pulse最多延到min(now+3秒,原signed deadline)，不能刷新权限/模型/用途/设备，迟pulse
拒绝，PTT本地ASR/预览同样受约束。需保持控制页可见；重开要重新准备、批准和start。
同时检查wall expiry与monotonic deadline，改系统时间不能延长设备授权。

每轮新host_request/turn/context_ref；delivery固定<=120秒且不超过源lease，不会续期。
PTT/window需具体结果确认，handsfree来自初始明确连续授权但仍每轮新固定prepare。
consume一次，占用不代表sent；收据sent/failed/unknown，不重放不明交付。每个await
后及实际发模型/发pet/播音前validate。新context/epoch不能续旧结果；screen及派生
回答永远memory_write=false/history_write=false。PTT明确Send后普通输入处理另走
host现有受控入口，媒体自身无memory/history写入。

## 音频和窗口实质实现

采用经hash归因的原asr/audio_devices/audio_endpoints/audio_duplex/audio_processing/
speech_detectors/speech_loop/reply_speech/tts/window_targets/wgc_worker适配副本，
没有从原项目runtime import。仅移除未使用旧编排部分、换成本仓库namespace、固定
模型/用途/时限，并加严格voice token身份和本任务进程控制。没有把噪声门当AEC。
所有原文件只读；实际复用hash与依赖license元数据在provenance/evidence记录。

ASR/KWS/VAD为已准备官方CPU ONNX，精确文件hash在media-models.json；仅sherpa
CPU，不下载模型，不占用GPU做推理。输入及duplex统一16kHz/mono/PCM16；纯SAPI
输出24kHz，handsfree同一受控播放链重采样16kHz作为AEC reverse。WASAPI共享模式
明确auto_convert，设备按endpoint fingerprint而非默认编号，通知变更/丢帧即停。
SAPI用SpMemoryStream和IsNotXML生成有界PCM，不直接让SpVoice选默认扬声器播放。
旧audioKey/Electron/voxd必须在host端按owner状态抑制，即便SAPI失败也不自动改道。

window_targets核secure desktop、可见/未最小化、capture protection、敏感title、同用户
及非elevated进程，再固定HWND/PID/creationTime。WGC前/后及每次预览/交付再核，
不接受任意屏幕/path。PNG<=640px、<=1,500,000字节，在同frame hash上分块读取
（每块<=256KiB，保持外层JSONL<=1MiB）。preview不重新采集另一帧。

有界性：4个child slot、每child32命令、64事件/8MiB输入event、16lease/16raw结果/
24delivery描述符，最多3 retained PNG；超限可见停止，不当成无界采集历史。所有
raw队列/模型上下文跟随generation和撤权清空。

## 发布交接块（无提交/版本/发布操作）

- 现象：缺少统一设备租约/撤权/单语音owner，native调用会阻塞JSONL或产生晚结果。
- 修法：主服务媒体authority+显式confirm/start+3秒可见pulse；隔离Job worker；固定
  ASR/KWS/VAD/AEC/SAPI和HWND WGC；同result hash/context/epoch/固定模型一次交付。
- 接线：T4_MEDIA_API.md，trusted host准备/消费，UI确认/停止/预览；screen不进历史，
  SAPI owner抑制legacy播放，所有await后/外发前重核，不能后台无条件pulse。
- 验证：attempt2媒体34、tools42、semantic22、backend31、service23、JS20/16/18通过；
  两个先红后绿根因、完整/窄diff和静态检查见attempt2证据；root整合后再跑audit/regressions。
- 迁移/重启：只有偏好/元数据附加表，重启无设备许可；optional requirements-media。
- 回滚：attempt2只恢复本轮媒体模块，不回退core/storage/T5；保留活动DB/ledger/key。
- 未验收：真实麦克风/扬声器、回声/插话效果、窗口捕获、锁屏、完成页面的固定模型
  传递和可见性；由root在用户显式激活后取得证据，不能用模型加载替代。

## attempt3：原生打开前重新核对权限

独立 attempt2 复核确认 F1 旧播音撤权已修复，但 duplex/output 将端点 pin 与流构造
放在同一次 authorize 中。pin 超时后才退出该块，导致许可到期仍构造一次原生音频流。
root 接管两处小范围修补；先固定红测，再把端点 pin、设置准备、原生构造及实际 start
分成分别核验的边界。duplex 的 prestart lease.check 后也重新核验；异常仍进入清理。

新增确定性测试实际执行两个适配器，只有 OS 端点与原生流为替身。pin、设置准备和
prestart 检查跨过 wall/monotonic/visibility 三种期限，分别覆盖恰好到期与晚一单位，
共 36 个子用例；旧实现全部失败，修补后通过。完整 `.venv/Scripts/python.exe`
媒体 35 项通过，包括真实公开音频的离线 ASR/VAD/KWS/AEC；没有打开实际设备。
初次误用全局 Python 缺少依赖的失败日志保留，不能算作实现失败或物理测试。

冻结和独立验收证据：`.local/evidence/t4-media/attempt3-root/`。这是该单元第 3 次
正式实现尝试；未扩大到宿主页面或真实设备验收，不回退并行 T5 core/storage 修改。
