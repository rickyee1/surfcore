"""Bounded 16 kHz mono PCM framing for the native WebRTC audio processor."""
from __future__ import annotations

import threading

import numpy as np


class AudioProcessingError(RuntimeError):
    pass


class WebRtcAudioProcessor:
    frame_bytes = 320
    max_chunk_bytes = 32000

    def __init__(self, *, echo_cancellation: bool = False, noise_suppression: bool = True,
                 stream_delay_ms: int = 0):
        if type(echo_cancellation) is not bool or type(noise_suppression) is not bool:
            raise ValueError("Audio processing options must be boolean")
        if type(stream_delay_ms) is not int or not 0 <= stream_delay_ms <= 500:
            raise ValueError("Invalid audio stream delay")
        try:
            from pywebrtc_audio import AudioProcessor
            self._processor = AudioProcessor(sample_rate=16000, num_channels=1,
                echo_cancellation=echo_cancellation, noise_suppression=noise_suppression,
                high_pass_filter=True, auto_gain_control=False, ns_level=1,
                stream_delay_ms=stream_delay_ms)
        except Exception:
            raise AudioProcessingError("本地降噪组件不可用；可关闭降噪后重新录音") from None
        self.echo_cancellation = echo_cancellation
        self._delay_ms = stream_delay_ms
        self._capture, self._reference = bytearray(), bytearray()
        self._owner = threading.get_ident()

    def _check_owner(self):
        if threading.get_ident() != self._owner:
            raise AudioProcessingError("Audio processor belongs to another worker")
        if self._processor is None:
            raise AudioProcessingError("Audio processor is closed")

    def process(self, capture: bytes, render_reference: bytes | None = None, *, stream_delay_ms: int | None = None) -> bytes:
        self._check_owner()
        if type(capture) is not bytes or len(capture) % 2 or len(capture) > self.max_chunk_bytes:
            raise AudioProcessingError("Invalid PCM capture frame")
        if self.echo_cancellation:
            if type(render_reference) is not bytes or len(render_reference) != len(capture):
                raise AudioProcessingError("AEC requires an aligned equal-length playback reference")
        elif render_reference is not None:
            raise AudioProcessingError("Playback reference supplied while AEC is disabled")
        if stream_delay_ms is not None:
            if not self.echo_cancellation or type(stream_delay_ms) is not int or not 0 <= stream_delay_ms <= 500:
                raise AudioProcessingError("Invalid playback reference delay")
            if self._capture and stream_delay_ms != self._delay_ms:
                raise AudioProcessingError("AEC delay changed inside an incomplete frame")
        self._capture.extend(capture)
        if render_reference is not None:
            self._reference.extend(render_reference)
        output = []
        try:
            if stream_delay_ms is not None and stream_delay_ms != self._delay_ms:
                self._processor.stream_delay_ms = stream_delay_ms
                self._delay_ms = stream_delay_ms
            while len(self._capture) >= self.frame_bytes:
                near = bytes(self._capture[:self.frame_bytes])
                far = bytes(self._reference[:self.frame_bytes]) if self.echo_cancellation else None
                output.append(self._frame(near, far))
                del self._capture[:self.frame_bytes]
                if self.echo_cancellation:
                    del self._reference[:self.frame_bytes]
        except Exception:
            self.close()
            raise AudioProcessingError("本地音频处理失败，已停止录音") from None
        return b"".join(output)

    def _frame(self, capture, reference):
        near = np.frombuffer(capture, dtype="<i2").copy()
        far = np.frombuffer(reference, dtype="<i2").copy() if reference is not None else None
        result = self._processor.process(near, far)
        if result.shape != near.shape or result.dtype != np.dtype("<i2"):
            raise AudioProcessingError("Invalid native PCM result")
        return result.tobytes()

    def finish(self) -> bytes:
        self._check_owner()
        try:
            size = len(self._capture)
            if not size:
                return b""
            # Only the final incomplete frame is padded; ordinary chunks never insert silence.
            near = bytes(self._capture).ljust(self.frame_bytes, b"\0")
            far = bytes(self._reference).ljust(self.frame_bytes, b"\0") if self.echo_cancellation else None
            return self._frame(near, far)[:size]
        except Exception:
            raise AudioProcessingError("本地音频处理失败，已停止录音") from None
        finally:
            self.close()

    def close(self):
        if threading.get_ident() != self._owner:
            raise AudioProcessingError("Audio processor belongs to another worker")
        self._capture.clear()
        self._reference.clear()
        self._processor = None
