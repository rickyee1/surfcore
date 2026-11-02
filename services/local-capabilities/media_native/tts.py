from __future__ import annotations

import asyncio
import re
import threading
import time
from collections.abc import AsyncIterator, Callable
from contextlib import nullcontext
from dataclasses import dataclass
from uuid import UUID

from media_native.audio_devices import AudioDeviceError
from media_native.audio_endpoints import (EndpointAccess, EndpointLease, PORTAUDIO_LOCK,
    close_stream, retain_cleanup, cleanup_complete, retry_failed_cleanup, require_clean_audio)


PROTECTED_TEXT = re.compile(r"https?://[^\s<>\"'，。！？；、]+|[+-]?[A-Za-z0-9][A-Za-z0-9._:/@+%#?=&~,'-]*", re.I)


class ChineseSegmenter:
    def __init__(self, target_chars: int = 24, max_chars: int = 80):
        if type(target_chars) is not int or type(max_chars) is not int or not 1 <= target_chars <= max_chars <= 8000:
            raise ValueError("Invalid speech segment lengths")
        self.target_chars, self.max_chars, self.buffer = target_chars, max_chars, ""

    def feed(self, delta: str, final: bool = False) -> list[str]:
        if not isinstance(delta, str) or len(self.buffer) + len(delta) > 8000:
            raise ValueError("Speech text exceeds the bounded segment buffer")
        self.buffer += delta
        segments = []
        while self.buffer:
            protected = [match.span() for match in PROTECTED_TEXT.finditer(self.buffer)]
            def safe(index):
                return not any(start < index < end or start < index == end == len(self.buffer) and not final
                               for start, end in protected)
            boundary = next((i + 1 for i, char in enumerate(self.buffer[:self.max_chars])
                             if char in "。！？；\n，、," and i + 1 >= self.target_chars and safe(i + 1)), None)
            if boundary is None and len(self.buffer) >= self.max_chars:
                candidates = [i + 1 for i, char in enumerate(self.buffer[:self.max_chars])
                              if char in "，、, \t" and i + 1 >= self.target_chars and safe(i + 1)]
                boundary = max(candidates) if candidates else self.max_chars
                if not safe(boundary):
                    start, end = next((start, end) for start, end in protected if start < boundary <= end)
                    # A still-arriving token has no safe internal cut, even when longer than the target.
                    boundary = start if start >= self.target_chars else (end if end < len(self.buffer) or final else None)
            if boundary is None:
                if not final: break
                boundary = len(self.buffer)
            text, self.buffer = self.buffer[:boundary].strip(), self.buffer[boundary:]
            if text: segments.append(text)
        return segments


@dataclass(frozen=True)
class PcmChunk:
    generation_id: UUID
    sequence: int
    pcm: bytes
    sample_rate: int = 24000


class SapiTtsAdapter:
    """Explicit Windows local provider; synthesizes each safe segment into an in-memory PCM stream."""

    sample_rate = 24000

    def __init__(self, voice_contains: str = "Chinese", chunk_bytes: int = 4096, *, voice_name: str = "", rate: int = 0, voice_id: str = ""):
        if not isinstance(voice_name, str) or len(voice_name) > 200 or type(rate) is not int or not -5 <= rate <= 5:
            raise ValueError("本地声音配置无效")
        self.voice_contains, self.chunk_bytes = voice_contains, chunk_bytes
        self.voice_name, self.rate, self.voice_id = voice_name, rate, voice_id

    async def stream(self, text: str):
        cancel_event = threading.Event()
        try:
            pcm = await asyncio.to_thread(self._synthesize, text, cancel_event=cancel_event)
            for start in range(0, len(pcm), self.chunk_bytes):
                yield pcm[start:start + self.chunk_bytes]
        finally:
            cancel_event.set()

    def _synthesize(self, text: str, *, cancel_event=None, authorize=nullcontext) -> bytes:
        if cancel_event is not None and cancel_event.is_set():
            return b""
        with authorize():
            pass
        import pythoncom
        import win32com.client
        pythoncom.CoInitialize()
        voice = selected = stream = audio_format = None
        pending = False
        try:
            voice = win32com.client.Dispatch("SAPI.SpVoice")
            selected = next((item for item in voice.GetVoices() if
                ((item.GetDescription() == self.voice_name and (not self.voice_id or item.Id == self.voice_id)) if self.voice_name else
                 self.voice_contains.lower() in item.GetDescription().lower())), None)
            if self.voice_name and selected is None:
                raise ValueError("角色要求的 Windows 声音未安装")
            if selected is not None: voice.Voice = selected
            voice.Rate = self.rate
            stream = win32com.client.Dispatch("SAPI.SpMemoryStream")
            audio_format = win32com.client.Dispatch("SAPI.SpAudioFormat")
            audio_format.Type = 22  # SAFT24kHz16BitMono
            stream.Format = audio_format; voice.AudioOutputStream = stream
            with authorize():
                if cancel_event is not None and cancel_event.is_set():
                    return b""
                pending = True
                # Async + IsNotXML: cancellation stays responsive without interpreting model text as markup/files.
                voice.Speak(text, 17)
            deadline = time.monotonic() + 30
            while True:
                if cancel_event is not None and cancel_event.is_set():
                    return b""
                with authorize():
                    pass
                if time.monotonic() >= deadline:
                    raise TimeoutError("Windows speech synthesis timed out")
                if voice.WaitUntilDone(20):
                    with authorize():
                        if cancel_event is not None and cancel_event.is_set():
                            return b""
                        pcm = bytes(stream.GetData())
                        if len(pcm) > 1_440_000:
                            raise ValueError("Bounded PCM synthesis exceeded")
                        pending = False
                        return pcm
        finally:
            if pending and voice is not None:
                try:
                    voice.Speak("", 19)  # Async + PurgeBeforeSpeak + IsNotXML.
                except Exception:
                    pass
            voice = selected = stream = audio_format = None
            pythoncom.CoUninitialize()


class WasapiOutput:
    def __init__(self, device: int | None = None, *, sd=None, endpoint_sdk=None):
        if sd is None:
            import sounddevice as sd
        self.sd, self.device, self.stream = sd, device, None
        self.endpoints = EndpointAccess(sd, endpoint_sdk)
        self._lease = None
        self._control = threading.RLock()
        self._sync = threading.Condition(threading.RLock())
        self._pending = bytearray()
        self._finished, self._failed = threading.Event(), threading.Event()
        self._cancelled = None
        self._authorize=nullcontext
        self._draining = self._stopping = False
        self._generation = None
        self._expected = 0

    def write(self, chunk: PcmChunk) -> None:
        self.write_authorized(chunk)

    def pin(self, binding=None):
        with self._control, PORTAUDIO_LOCK:
            if self._lease is None:
                self._lease = EndpointLease(self.endpoints, [("output", self.device, binding)])
                self.device = self._lease.bindings[0].index
            self._lease.check()

    def check_endpoint(self):
        if self._lease is not None:
            self._lease.check()

    def _open(self, chunk, authorize):
        with self._control, PORTAUDIO_LOCK:
            self._open_locked(chunk, authorize)

    def _open_locked(self, chunk, authorize):
        require_clean_audio()
        self._rate = chunk.sample_rate
        self._frame_samples = self._rate // 100
        self._frame_bytes = self._frame_samples * 2
        self._capacity = self._rate * 2 // 5
        self._silence = b"\0" * self._frame_bytes
        self._finished.clear(); self._failed.clear()
        self._draining = self._stopping = False
        self._last_frame = time.monotonic()
        try:
            with authorize():
                self.pin()
                lease = self._lease
                extra_settings = self.sd.WasapiSettings(exclusive=False, auto_convert=True)
            # Pinning can outlive the original permission; never open on its stale check.
            with authorize():
                self.stream = self.sd.RawOutputStream(samplerate=self._rate, blocksize=self._frame_samples, channels=1,
                    dtype="int16", device=self.device, latency="low",
                    extra_settings=extra_settings,
                    callback=lambda *args: self._render(*args, lease=lease), finished_callback=self._on_finished)
                lease.verify()
            with authorize():
                self.stream.start()
                lease.verify()
        except BaseException:
            try:
                self.stop()
            except Exception:
                pass
            raise

    def _render(self, output, frames, _timing, status, *, lease=None):
        output[:] = self._silence if len(output) == self._frame_bytes else b"\0" * len(output)
        try:
            if self._stopping or self._failed.is_set() or self._cancelled is not None and self._cancelled.is_set():
                raise PermissionError('Playback cancelled')
            with self._authorize():pass
            (lease or self._lease).check()
            if status or frames != self._frame_samples or len(output) != self._frame_bytes:
                raise AudioDeviceError("Playback frame continuity was lost")
            done = False
            if self._sync.acquire(blocking=False):
                try:
                    count = min(len(self._pending), self._frame_bytes)
                    if count:
                        with self._authorize():
                            output[:count] = self._pending[:count]
                            del self._pending[:count]
                    done = self._draining and not self._pending
                    self._sync.notify_all()
                finally:
                    self._sync.release()
            self._last_frame = time.monotonic()
            (lease or self._lease).check()
            with self._authorize():pass
        except Exception:
            output[:] = b"\0" * len(output)
            if self._sync.acquire(blocking=False):
                try:self._pending.clear();self._sync.notify_all()
                finally:self._sync.release()
            self._failed.set()
            raise self.sd.CallbackAbort from None
        if done:
            raise self.sd.CallbackStop

    def _on_finished(self):
        if not self._draining and not self._stopping and not (self._cancelled and self._cancelled.is_set()):
            self._failed.set()
        self._finished.set()

    def write_authorized(self, chunk: PcmChunk, *, cancelled=None, authorize=nullcontext):
        generation = str(UUID(str(chunk.generation_id)))
        if (type(chunk.sample_rate) is not int or not 8000 <= chunk.sample_rate <= 48000 or chunk.sample_rate % 100
                or type(chunk.sequence) is not int or chunk.sequence < 0 or type(chunk.pcm) is not bytes
                or not 0 < len(chunk.pcm) <= chunk.sample_rate * 2 // 5 or len(chunk.pcm) % 2):
            raise ValueError("Playback requires bounded mono PCM16 chunks")
        if cancelled is not None and cancelled.is_set():
            return False
        self._cancelled = cancelled
        self._authorize=authorize
        if self.stream is None:
            if chunk.sequence != 0:
                raise AudioDeviceError("Playback must start at sequence zero")
            self._open(chunk,authorize)
            self._generation, self._expected = generation, 0
        if self._generation != generation or chunk.sequence != self._expected or chunk.sample_rate != self._rate:
            raise AudioDeviceError("Playback generation or sequence was interrupted")
        with self._sync:
            while True:
                self.check_endpoint()
                if self._stopping or cancelled is not None and cancelled.is_set():
                    return False
                if self._failed.is_set() or not self.stream.active or time.monotonic() - self._last_frame >= 1:
                    raise AudioDeviceError("Playback device stopped or stalled")
                with authorize():
                    if len(self._pending) + len(chunk.pcm) <= self._capacity:
                        if cancelled is not None and cancelled.is_set():
                            return False
                        self._pending.extend(chunk.pcm)
                        self._expected += 1
                        return True
                self._sync.wait(.02)

    def finish(self, *, cancelled=None, authorize=nullcontext):
        if self.stream is None:
            return
        with self._sync:
            self._draining = True
        deadline = time.monotonic() + 2
        while not self._finished.wait(.02):
            self.check_endpoint()
            if cancelled is not None and cancelled.is_set():
                return
            with authorize():
                pass
            if self._failed.is_set() or time.monotonic() >= deadline:
                raise AudioDeviceError("Playback did not finish draining")
        if cancelled is not None and cancelled.is_set():
            return
        with authorize():
            self.check_endpoint()
            if self._failed.is_set() or self._pending:
                raise AudioDeviceError("Playback stopped before its tail was played")
        with self._control, PORTAUDIO_LOCK:
            stream = self.stream
            try:
                close_stream(stream)
                self.stream = None
                if self._lease is not None:
                    self._lease.close()
                    self._lease = None
            except BaseException:
                if self._lease is not None:
                    self._lease.invalid = True
                self._stopping = True
                retain_cleanup(self, self._cleanup)
                raise
            cleanup_complete(self)

    def stop(self) -> None:
        self._cleanup()
        retry_failed_cleanup()

    def _cleanup(self):
        with self._control, PORTAUDIO_LOCK:
            self._stop_locked()

    def _stop_locked(self):
        lease = self._lease
        if lease is not None:
            lease.invalid = True
        with self._sync:
            self._stopping = True
            self._pending.clear()
            self._generation, self._expected = None, 0
            stream = self.stream
            self._sync.notify_all()
        error = None
        try:
            if stream is not None:
                error = close_stream(stream, "abort")
                self.stream = None
            if lease is not None:
                lease.close()
                self._lease = None
        except BaseException:
            retain_cleanup(self, self._cleanup)
            raise
        cleanup_complete(self)
        if error:
            raise error

