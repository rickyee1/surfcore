from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal
from uuid import UUID

import numpy as np



@dataclass(frozen=True)
class AsrProfile:
    name: str
    tokens: Path
    encoder: Path
    decoder: Path
    joiner: Path
    mode: Literal["streaming", "whole_utterance"] = "streaming"
    int8: bool = False

    def validate(self) -> None:
        missing = [str(path) for path in (self.tokens, self.encoder, self.decoder, self.joiner)
                   if not path.is_file()]
        if missing:
            raise FileNotFoundError("ASR 模型文件不完整：" + "、".join(missing))


def select_profile(profiles: list[AsrProfile], *, low_power: bool = False,
                   whole_utterance: bool = False) -> AsrProfile:
    for profile in profiles:
        if profile.int8 == low_power and (profile.mode == "whole_utterance") == whole_utterance:
            profile.validate()
            return profile
    raise LookupError("没有可用的 ASR 降级 profile")


@dataclass(frozen=True)
class AsrHypothesis:
    text: str
    timestamps: list[float]
    confidence: float
    final: bool


class SherpaOnlineEngine:
    """Thin wrapper around sherpa-onnx; model assets remain user-installable data."""

    def __init__(self, recognizer):
        self.recognizer = recognizer
        self.stream = recognizer.create_stream()

    @classmethod
    def from_profile(cls, profile: AsrProfile):
        profile.validate()
        import sherpa_onnx
        recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
            tokens=str(profile.tokens), encoder=str(profile.encoder), decoder=str(profile.decoder),
            joiner=str(profile.joiner), num_threads=2, sample_rate=16000, provider="cpu",
            decoding_method="greedy_search", enable_endpoint_detection=True,
        )
        return cls(recognizer)

    def accept(self, pcm: bytes) -> AsrHypothesis | None:
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0
        self.stream.accept_waveform(16000, samples)
        while self.recognizer.is_ready(self.stream):
            self.recognizer.decode_stream(self.stream)
        result = self.recognizer.get_result_all(self.stream)
        text = result.text.strip()
        endpoint = self.recognizer.is_endpoint(self.stream)
        if endpoint:
            self.recognizer.reset(self.stream)
        if not text:
            return None
        timestamps = [float(value) for value in getattr(result, "timestamps", [])]
        confidence = float(getattr(result, "confidence", 1.0))
        return AsrHypothesis(text, timestamps, max(0.0, min(1.0, confidence)), endpoint)

    def finish(self) -> AsrHypothesis | None:
        self.stream.input_finished()
        while self.recognizer.is_ready(self.stream):
            self.recognizer.decode_stream(self.stream)
        result = self.recognizer.get_result_all(self.stream)
        text = result.text.strip()
        return AsrHypothesis(text, [float(x) for x in getattr(result, "timestamps", [])],
                             float(getattr(result, "confidence", 1.0)), True) if text else None

    def reset(self) -> None:
        self.recognizer.reset(self.stream)

    def new_utterance(self) -> None:
        self.stream = self.recognizer.create_stream()

