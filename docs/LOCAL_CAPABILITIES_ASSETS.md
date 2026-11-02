# 本地能力的运行依赖与资产

更新：2026-11-02。本文件记录本次开发已准备的资产和来源，不代表语音、窗口或完整部署已经验收。软件、模型和设备许可分别核对；仓库不内嵌模型权重、QQ客户端、DSH安装包或用户角色资产。

| 用途 | 当前固定资产 | 上游许可声明与来源 |
| --- | --- | --- |
| 本地中文语义检索 | BAAI/bge-small-zh-v1.5，revision `7999e1d3359715c523056ef9478215996d62a620`，CPU 512维，safetensors | [该固定版本模型卡](https://huggingface.co/BAAI/bge-small-zh-v1.5/blob/7999e1d3359715c523056ef9478215996d62a620/README.md)声明 MIT |
| 本地中英ASR | sherpa-onnx-streaming-zipformer-small-bilingual-zh-en-2023-02-16；int8 encoder/joiner、fp32 decoder | [官方转换与下载说明](https://k2-fsa.github.io/sherpa/onnx/pretrained_models/online-transducer/zipformer-transducer-models.html)链接到[源模型卡](https://huggingface.co/csukuangfj/k2fsa-zipformer-bilingual-zh-en-t)，其声明 Apache-2.0 |
| 中文唤醒词 | sherpa-onnx-kws-zipformer-wenetspeech-3.3M-2024-01-01，chunk16/left64 | [官方模型来源说明](https://k2-fsa.github.io/sherpa/onnx/kws/pretrained_models/index.html)指向[原模型发布仓库](https://github.com/pkufool/keyword-spotting-models)，该仓库声明 Apache-2.0 |
| 语音活动检测 | 本机固定 `silero_vad.onnx` | [Silero VAD许可](https://github.com/snakers4/silero-vad/blob/master/LICENSE)声明 MIT；此处不等同于其它 Silero TTS/STT 模型的许可 |
| 本机语音输出候选 | Windows 已安装 Microsoft Huihui Desktop | 操作系统提供的语音组件，使用本机既有安装，不随仓库复制分发；实际播放与单输出接线尚需设备验收 |

模型留在忽略提交的 `.local/models/`。ASR/KWS下载归档已记录本地SHA256，未取得发布者独立摘要，不能称为双渠道来源校验。VAD下载摘要已与发布者核对。资产逐文件大小/散列保存在 `.local/evidence/full-integration/media-models.json`、`embedding-assets.json`；真正接入时还应由各模块的固定清单校验，不接受模型任填下载地址或远程代码。

基础数据库仅使用 `services/local-capabilities/requirements.txt` 的 SQLCipher；语义扩展依赖单列在 `requirements-semantic.txt`，媒体固定版本在 `requirements-media.txt`。本机媒体环境已准备 sounddevice、sherpa-onnx、pywebrtc-audio、windows-capture、Pillow、pywin32、comtypes、scipy和pypinyin；固定资产由 `semantic-model.json`、`media-models.json` 校验，复用源文件及修改归因在 `provenance.json`。已安装17个直接相关包的版本与包内许可元数据记录在 `.local/evidence/full-integration/optional-dependency-license-metadata.json`，这是环境清单，不能代替各包完整许可文本。

原路遥 `docs/NOTICES.md` 及 `packaging/upstream-licenses/` 另有依赖声明，但其中 tokenizers、sherpa-onnx-core 与 PyWinRT 的绑定版本不全部等于本次环境，不能直接复制并声称覆盖本版本。pywebrtc-audio 的嵌套 WebRTC 等声明及 PATENTS 也须随其实际版本核对。当前只运行本机开发环境、不分发运行时二进制或资产；正式安装包的 notices/SBOM 和签署属于后续独立发布范围。

完整角色包只允许用户明确选定、具有来源和许可说明的资产。DSH、SnowLuma、surfpet、语音模型和形象素材各自的许可不因SurfCore使用MIT而改变。SnowLuma仍由用户手动安装与登录；此仓库的部署脚本不自动安装、重启或打包它。角色包不迁移API Key、平台Cookie、授权票据或设备许可。
