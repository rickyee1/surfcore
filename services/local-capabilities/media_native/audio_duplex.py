"""Bounded WASAPI duplex transport. Model work stays off the audio callback."""
from contextlib import nullcontext
from dataclasses import dataclass
import math
import queue
import threading
import time
from uuid import UUID

from media_native.audio_devices import AudioDeviceError, DeviceBinding
from media_native.audio_endpoints import (EndpointAccess, EndpointLease, PORTAUDIO_LOCK,
    close_stream, retain_cleanup, cleanup_complete, retry_failed_cleanup, require_clean_audio)


@dataclass(frozen=True)
class DuplexFrame:
    sequence: int
    capture: bytes
    render_reference: bytes
    capture_time: float
    render_time: float
    delay_ms: int
    render_generation_id: UUID | None


class WasapiDuplexBackend:
    sample_rate = 16000
    frame_samples = 160
    frame_bytes = 320
    max_render_bytes = 9600
    max_capture_frames = 50

    def __init__(self, *, clock=time.monotonic, sd=None, endpoint_sdk=None):
        if sd is None:
            import sounddevice as sd
        self.sd, self.stream, self._clock = sd, None, clock
        self.endpoints = EndpointAccess(sd, endpoint_sdk)
        self._lease = None
        self._control = threading.RLock()
        self._stopped = threading.Event()
        self._stopped.set()
        self._failed = threading.Event()
        self._output = threading.Condition(threading.RLock())
        self._pending = bytearray()
        self._captures = queue.Queue(maxsize=self.max_capture_frames)
        self._playback_id = None
        self._expected = self._sequence = 0
        self._last_callback = 0
        self._last_capture_time = None
        self._silence = b"\0" * self.frame_bytes
        self._authorize=self._playback_authorize=nullcontext

    def devices(self):
        return self.endpoints.devices()

    def start(self, capture: DeviceBinding, render: DeviceBinding, *, authorize=nullcontext):
        with self._control, PORTAUDIO_LOCK:
            self._start(capture, render, authorize)

    def _start(self, capture, render, authorize):
        self._authorize=authorize
        require_clean_audio()
        if self.stream is not None:
            raise AudioDeviceError("Duplex audio is already running")
        if self._lease is not None:
            raise AudioDeviceError("Previous audio endpoint cleanup must finish before restart")
        if not isinstance(capture, DeviceBinding) or capture.kind != "input" or not isinstance(render, DeviceBinding) or render.kind != "output":
            raise ValueError("Duplex audio requires pinned input and output devices")
        with authorize():
            listed = self.devices()
            capture.verify(listed)
            render.verify(listed)
        self._clear()
        self._failed.clear()
        self._sequence, self._last_capture_time = 0, None
        self._last_callback = self._clock()
        self._stopped.clear()
        try:
            with authorize():
                self._lease = EndpointLease(self.endpoints, [("input", capture.index, capture), ("output", render.index, render)])
                extra_settings = self.sd.WasapiSettings(exclusive=False, auto_convert=True)
            # Endpoint verification can block; recheck immediately before opening hardware.
            with authorize():
                self.stream = self.sd.RawStream(
                    samplerate=self.sample_rate, blocksize=self.frame_samples, channels=(1, 1), dtype="int16",
                    device=(capture.index, render.index), latency="low",
                    extra_settings=extra_settings,
                    callback=lambda *args, lease=self._lease: self._callback(*args, lease=lease), finished_callback=self._finished,
                )
                self._lease.verify()
            with authorize():
                self._lease.check()
            with authorize():
                self.stream.start()
                self._lease.verify()
        except BaseException:
            try:
                self.stop()
            except Exception:
                pass
            raise

    def _finished(self):
        if not self._stopped.is_set():
            self._failed.set()

    def _callback(self, capture, output, frames, timing, status, *, lease=None):
        output[:] = self._silence if len(output) == self.frame_bytes else b"\0" * len(output)
        if self._stopped.is_set() or self._failed.is_set():
            raise self.sd.CallbackAbort
        try:
            with self._authorize():pass
            (lease or self._lease).check()
            if status or frames != self.frame_samples or len(capture) != self.frame_bytes or len(output) != self.frame_bytes:
                raise AudioDeviceError("Duplex frame continuity was lost")
            adc, dac = float(timing.inputBufferAdcTime), float(timing.outputBufferDacTime)
            delay = (dac - adc) * 1000
            if not math.isfinite(adc) or not math.isfinite(dac) or not 0 <= delay <= 500:
                raise AudioDeviceError("Duplex timing cannot provide an AEC reference")
            if self._last_capture_time is not None and not .005 <= adc - self._last_capture_time <= .015:
                raise AudioDeviceError("Duplex capture timestamps are discontinuous")
            self._last_capture_time = adc
            generation = None
            # A busy control thread gets silence, never a blocking audio callback.
            if self._output.acquire(blocking=False):
                try:
                    if self._pending:
                        try:
                            with self._playback_authorize():
                                count = min(len(self._pending), self.frame_bytes)
                                output[:count] = self._pending[:count]
                                del self._pending[:count]
                                generation = self._playback_id
                        except PermissionError:
                            output[:]=self._silence
                            self.cancel_playback()
                    self._output.notify_all()
                finally:
                    self._output.release()
            frame = DuplexFrame(self._sequence, bytes(capture), bytes(output), adc, dac, round(delay), generation)
            (lease or self._lease).check()
            with self._authorize():pass
            self._captures.put_nowait(frame)
            self._sequence += 1
            self._last_callback = self._clock()
            (lease or self._lease).check()
        except Exception:
            output[:] = self._silence if len(output) == self.frame_bytes else b"\0" * len(output)
            self._failed.set()
            raise self.sd.CallbackAbort from None

    def check_health(self):
        try:
            if self._lease is not None:
                self._lease.check()
            healthy = (not self._stopped.is_set() and not self._failed.is_set() and self.stream is not None
                       and self.stream.active and self._clock() - self._last_callback < 1)
        except Exception:
            healthy = False
        if not healthy:
            self._failed.set()
            self._clear()
            raise AudioDeviceError("Duplex audio stopped or lost timing; explicit device selection is required")

    def read(self, timeout=.1):
        self.check_health()
        try:
            frame = self._captures.get(timeout=timeout)
        except queue.Empty:
            frame = None
        self.check_health()
        return frame

    def begin_playback(self, generation_id, *, authorize=nullcontext):
        generation_id = UUID(str(generation_id))
        with self._output:
            self.check_health()
            self._pending.clear()
            self._playback_authorize=authorize
            self._playback_id, self._expected = generation_id, 0
            self._output.notify_all()

    def enqueue(self, chunk, *, cancelled=None):
        generation_id = UUID(str(chunk.generation_id))
        if (chunk.sample_rate != self.sample_rate or type(chunk.sequence) is not int or chunk.sequence < 0
                or type(chunk.pcm) is not bytes or not 0 < len(chunk.pcm) <= self.max_render_bytes or len(chunk.pcm) % 2):
            raise ValueError("Duplex playback requires bounded, ordered 16 kHz mono PCM16")
        deadline = self._clock() + 1
        with self._output:
            while True:
                if self._stopped.is_set() or generation_id != self._playback_id:
                    return False
                if cancelled is not None and cancelled.is_set():
                    self.cancel_playback(generation_id)
                    return False
                self.check_health()
                if chunk.sequence != self._expected:
                    self.cancel_playback(generation_id)
                    raise AudioDeviceError("Duplex playback sequence was interrupted")
                if len(self._pending) + len(chunk.pcm) <= self.max_render_bytes:
                    self._pending.extend(chunk.pcm)
                    self._expected += 1
                    return True
                if self._clock() >= deadline:
                    self.cancel_playback(generation_id)
                    raise AudioDeviceError("Duplex playback queue stalled")
                self._output.wait(.02)

    def cancel_playback(self, generation_id=None):
        with self._output:
            if generation_id is None or UUID(str(generation_id)) == self._playback_id:
                self._pending.clear()
                self._playback_id = None
                self._expected = 0
                self._output.notify_all()

    def finish_playback(self, generation_id, *, cancelled=None):
        generation_id = UUID(str(generation_id))
        deadline = self._clock() + 2
        with self._output:
            while generation_id == self._playback_id and not self._stopped.is_set():
                if cancelled is not None and cancelled.is_set():
                    return False
                self.check_health()
                if not self._pending:
                    # The duplex stream stays open: its last copied frame still reaches the DAC.
                    return True
                if self._clock() >= deadline:
                    raise AudioDeviceError("Duplex playback drain timed out")
                self._output.wait(.02)
        return False

    def _clear(self):
        self.cancel_playback()
        while True:
            try:
                self._captures.get_nowait()
            except queue.Empty:
                break

    def stop(self):
        self._cleanup()
        retry_failed_cleanup()

    def _cleanup(self):
        with self._control, PORTAUDIO_LOCK:
            self._stopped.set()
            lease = self._lease
            if lease is not None:
                lease.invalid = True
            stream = self.stream
            self._clear()
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
