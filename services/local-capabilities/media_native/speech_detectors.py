"""Local sherpa-onnx wake-word and Silero VAD adapters for an audio worker."""
from dataclasses import dataclass
from pathlib import Path
import math
import re
import struct
import threading

import numpy as np

from media_native.asr import AsrProfile


class SpeechDetectorError(RuntimeError):
    pass


class WakeKeywordValidationError(ValueError):
    """Safe preflight diagnostics, without file paths or user content."""


_ASCII_SPACE = " \t\r\n\v\f"
_NUMBER = re.compile(r"[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?\Z")


def _wake_error(kind, line, reason):
    raise WakeKeywordValidationError(f"{kind}第 {line} 行：{reason}")


def _wake_lines(path, limit, kind):
    with path.open("rb") as stream:
        data = stream.read(limit + 1)
    if not data or len(data) > limit:
        _wake_error(kind, 1, "文件为空或超过大小限制")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError as error:
        _wake_error(kind, data[:error.start].count(b"\n") + 1, "需要有效的 UTF-8 编码")
    # getline uses LF only; a final LF does not create an extra record.
    lines = text.split("\n")
    if lines[-1] == "":
        lines.pop()
    for number, line in enumerate(lines, 1):
        if "\ufeff" in line or "\0" in line:
            _wake_error(kind, number, "不支持 BOM 或空字符")
        if "\x1a" in line:
            _wake_error(kind, number, "不支持 Ctrl+Z 文件结束控制字符")
        if any(c.isspace() and c not in _ASCII_SPACE for c in line):
            _wake_error(kind, number, "仅支持 ASCII 空白分隔符")
    return lines


def _validate_wake_files(tokens, keywords):
    symbols, ids = set(), set()
    for number, line in enumerate(_wake_lines(tokens, 4 * 1024 * 1024, "词元表"), 1):
        fields = re.findall(r"[^ \t\r\v\f]+", line)
        # ReadTokens also supports a bare ID for the literal space symbol.
        if len(fields) == 1:
            symbol, value = " ", fields[0]
        elif len(fields) == 2:
            symbol, value = fields
        else:
            _wake_error("词元表", number, "需要词元和整数编号")
        if not re.fullmatch(r"\+?[0-9]{1,10}", value) or int(value) > 2147483647:
            _wake_error("词元表", number, "编号必须是非负 int32 整数")
        identifier = int(value)
        if symbol in symbols or identifier in ids:
            _wake_error("词元表", number, "词元或编号重复")
        symbols.add(symbol)
        ids.add(identifier)
    lines = _wake_lines(keywords, 65536, "关键词")
    if len(lines) > 128:
        _wake_error("关键词", 129, "记录数量超过限制")
    for number, line in enumerate(lines, 1):
        if len(line) > 1024:
            _wake_error("关键词", number, "记录长度超过限制")
        count = 0
        for word in re.findall(r"[^ \t\r\v\f]+", line):
            # EncodeBase checks membership before interpreting metadata prefixes.
            if word in symbols:
                count += 1
            elif word.startswith("@"):
                if len(word) == 1:
                    _wake_error("关键词", number, "标签不能为空")
            elif word.startswith((":", "#")):
                value = word[1:]
                if not _NUMBER.fullmatch(value):
                    _wake_error("关键词", number, "数值选项无效；不支持注释")
                numeric = float(value)
                try:
                    rounded = struct.unpack("f", struct.pack("f", numeric))[0]
                except (OverflowError, struct.error):
                    _wake_error("关键词", number, "数值超出 float32 范围")
                if (not math.isfinite(numeric) or not math.isfinite(rounded) or
                        abs(numeric) > 3.4028234663852886e38 or
                        (numeric != 0 and abs(numeric) < 1.1754943508222875e-38) or
                        (numeric == 0 and any(c in "123456789" for c in value.split("e")[0].split("E")[0]))):
                    _wake_error("关键词", number, "数值超出有限 float32 范围")
            else:
                _wake_error("关键词", number, "词元不在模型词元表中；请使用模型对应的编码关键词")
        if not count:
            _wake_error("关键词", number, "记录必须包含至少一个模型词元，不支持空行或注释")


@dataclass(frozen=True)
class WakeProfile:
    transducer: AsrProfile
    keywords: Path

    def validate(self):
        self.transducer.validate()
        _validate_wake_files(self.transducer.tokens, self.keywords)


@dataclass(frozen=True)
class VadProfile:
    model: Path

    def validate(self):
        if not self.model.is_file() or not 0 < self.model.stat().st_size <= 64 * 1024 * 1024:
            raise ValueError("A local bounded Silero VAD model is required")


def _samples(pcm):
    if type(pcm) is not bytes or not 0 < len(pcm) <= 32000 or len(pcm) % 2:
        raise SpeechDetectorError("Expected bounded 16 kHz mono PCM16")
    return np.frombuffer(pcm,dtype="<i2").astype(np.float32) / 32768.0


class SherpaWakeDetector:
    def __init__(self, spotter):
        self._spotter = spotter
        self._stream = spotter.create_stream()
        self._owner = threading.get_ident()

    @classmethod
    def from_profile(cls, profile: WakeProfile):
        profile.validate()
        import sherpa_onnx
        model = profile.transducer
        spotter = sherpa_onnx.KeywordSpotter(tokens=str(model.tokens),encoder=str(model.encoder),
            decoder=str(model.decoder),joiner=str(model.joiner),keywords_file=str(profile.keywords),
            num_threads=2,sample_rate=16000,provider="cpu")
        return cls(spotter)

    def _check(self):
        if threading.get_ident() != self._owner or self._spotter is None:
            raise SpeechDetectorError("Wake detector is closed or belongs to another worker")

    def accept(self, pcm):
        self._check()
        self._stream.accept_waveform(16000,_samples(pcm))
        for _ in range(128):
            if not self._spotter.is_ready(self._stream):
                return False
            self._spotter.decode_stream(self._stream)
            result = self._spotter.get_result(self._stream)
            if not isinstance(result,str):
                raise SpeechDetectorError("Invalid wake-word result")
            if result:
                self._spotter.reset_stream(self._stream)
                return True
        raise SpeechDetectorError("Wake detector exceeded its decode budget")

    def reset(self):
        self._check()
        self._spotter.reset_stream(self._stream)

    def close(self):
        if threading.get_ident() != self._owner:
            raise SpeechDetectorError("Wake detector belongs to another worker")
        self._stream = self._spotter = None


@dataclass(frozen=True)
class VadTransition:
    active: bool
    started: bool
    ended: bool


class SileroVadDetector:
    def __init__(self, detector):
        self._detector = detector
        self._owner = threading.get_ident()
        self.active = False

    @classmethod
    def from_profile(cls, profile: VadProfile):
        profile.validate()
        import sherpa_onnx
        config = sherpa_onnx.VadModelConfig(
            silero_vad=sherpa_onnx.SileroVadModelConfig(model=str(profile.model),threshold=.5,
                min_silence_duration=.4,min_speech_duration=.096,window_size=512,max_speech_duration=15),
            sample_rate=16000,num_threads=1,provider="cpu",debug=False,
        )
        return cls(sherpa_onnx.VoiceActivityDetector(config,buffer_size_in_seconds=20))

    def _check(self):
        if threading.get_ident() != self._owner or self._detector is None:
            raise SpeechDetectorError("VAD is closed or belongs to another worker")

    def accept(self, pcm):
        self._check()
        self._detector.accept_waveform(_samples(pcm))
        completed = 0
        # The ASR worker owns utterance PCM; never retain VAD's duplicate completed segments.
        while not self._detector.empty():
            if completed >= 16:
                raise SpeechDetectorError("VAD exceeded its segment budget")
            self._detector.pop()
            completed += 1
        active = bool(self._detector.is_speech_detected())
        value = VadTransition(active,active and (not self.active or completed > 0),
                              self.active and (not active or completed > 0))
        self.active = active
        return value

    def reset(self):
        self._check()
        self._detector.reset()
        self.active = False

    def close(self):
        if threading.get_ident() != self._owner:
            raise SpeechDetectorError("VAD belongs to another worker")
        self._detector = None
        self.active = False
