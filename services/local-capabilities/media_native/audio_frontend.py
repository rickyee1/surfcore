from __future__ import annotations
from contextlib import nullcontext
import threading
import time
from typing import Callable
from media_native.audio_devices import AudioDeviceError
from media_native.audio_endpoints import (EndpointAccess, EndpointLease, PORTAUDIO_LOCK, close_stream, retain_cleanup, cleanup_complete, retry_failed_cleanup, require_clean_audio)

class WasapiBackend:
    def __init__(self, *, sd=None, endpoint_sdk=None):
        if sd is None:
            import sounddevice as sd
        self.sd, self.stream = sd, None
        self.endpoints = EndpointAccess(sd, endpoint_sdk)
        self._lease = None
        self._control = threading.RLock()
        self._quiesced = False
        self._capturing = False

    def devices(self) -> list[dict]:
        return self.endpoints.devices()

    def start(self, callback: Callable[[bytes], None], device: int | None = None, *, binding=None, authorize=nullcontext) -> None:
        with self._control, PORTAUDIO_LOCK:
            self._start(callback, device, binding, authorize)

    def _start(self, callback, device, binding, authorize):
        require_clean_audio()
        if self.stream is not None:
            return
        if self._lease is not None:
            raise AudioDeviceError("上次音频资源尚未释放，请先停止或显式重启 Core")
        with authorize():self._lease = EndpointLease(self.endpoints, [("input", device, binding)])
        lease = self._lease
        device = lease.bindings[0].index
        self._failed = threading.Event()
        self._quiesced = False
        self._capturing = True
        self._last_frame_at = time.monotonic()
        def capture(data, frames, _time, status):
            if not self._capturing:
                raise self.sd.CallbackAbort
            try:
                with authorize():pass
                lease.check()
                if status or len(data) != frames * 2:
                    raise AudioDeviceError("Capture frame continuity was lost")
                lease.check()
                with authorize():callback(bytes(data))
                lease.check()
                self._last_frame_at = time.monotonic()
            except Exception:
                self._failed.set()
                raise self.sd.CallbackAbort from None
        try:
            with authorize():
                self.stream = self.sd.RawInputStream(samplerate=16000, blocksize=320, channels=1,
                    dtype="int16", device=device, latency="low",
                    extra_settings=self.sd.WasapiSettings(exclusive=False, auto_convert=True),
                    callback=capture)
            lease.verify()
            with authorize():self.stream.start()
            lease.verify()
        except BaseException:
            try:
                self._cleanup()
            except Exception:
                require_clean_audio()
            raise

    def check_health(self) -> None:
        try:
            if self._lease is not None:
                self._lease.check()
            healthy = (not self._failed.is_set() and (self._quiesced or self.stream is not None and self.stream.active
                       and time.monotonic() - self._last_frame_at < 1))
        except Exception:
            healthy = False
        if not healthy:
            raise AudioDeviceError("录音设备中断或音频丢帧，本次识别已丢弃；请检查设备后重新录音")

    def quiesce(self):
        """Stop capture before ASR finalization, retaining endpoint notifications."""
        with self._control, PORTAUDIO_LOCK:
            self._capturing = False
            stream = self.stream
            if stream is not None:
                try:
                    error = close_stream(stream, "stop")
                except BaseException:
                    if self._lease is not None:
                        self._lease.invalid = True
                    retain_cleanup(self, self._cleanup)
                    raise
                self.stream = None
                self._quiesced = True
                if error:
                    raise error
            if self._lease is not None and not self._lease.closed:
                self._lease.check()
            if stream is not None and self._failed.is_set():
                raise AudioDeviceError("录音设备中断或音频丢帧，本次识别已丢弃；请检查设备后重新录音")

    def stop(self) -> None:
        self._cleanup()
        retry_failed_cleanup()

    def _cleanup(self):
        with self._control, PORTAUDIO_LOCK:
            error = None
            try:
                self.quiesce()
            except Exception as exc:
                error = exc
            self._quiesced = False
            if self.stream is not None:
                raise error
            try:
                if self._lease is not None:
                    self._lease.close()
                    self._lease = None
            except BaseException:
                retain_cleanup(self, self._cleanup)
                raise
            cleanup_complete(self)
            if error:
                raise error

