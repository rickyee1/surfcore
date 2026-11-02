"""One local wake/VAD/ASR loop. Only recognized text leaves this process."""
from collections import deque
from contextlib import contextmanager,nullcontext
import queue
import threading
import time
from uuid import uuid4

import numpy as np

from media_native.wire import SpeechWorkerEvent
from media_native.asr import SherpaOnlineEngine
from media_native.audio_duplex import WasapiDuplexBackend
from media_native.audio_processing import WebRtcAudioProcessor
from media_native.reply_speech import ReplySpeechBuffer
from media_native.speech_detectors import SherpaWakeDetector, SileroVadDetector
from media_native.tts import PcmChunk, SapiTtsAdapter


class DuplexSapiAdapter(SapiTtsAdapter):
    sample_rate = 16000

    def _synthesize(self, text, **options):
        from scipy.signal import resample_poly
        pcm = super()._synthesize(text, **options)
        if not pcm:
            return b""
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32)
        return np.clip(np.rint(resample_poly(samples, 2, 3)), -32768, 32767).astype("<i2").tobytes()


class SpeechLoop:
    def __init__(self, settings, commands, emit, stopped, *, backend_factory=WasapiDuplexBackend,
                 engine_factory=SherpaOnlineEngine.from_profile, wake_factory=SherpaWakeDetector.from_profile,
                 vad_factory=SileroVadDetector.from_profile, processor_factory=WebRtcAudioProcessor,
                 adapter_factory=DuplexSapiAdapter, clock=time.monotonic):
        self.settings, self.commands, self.emit, self.stopped = settings, commands, emit, stopped
        self.backend_factory, self.engine_factory = backend_factory, engine_factory
        self.wake_factory, self.vad_factory = wake_factory, vad_factory
        self.processor_factory, self.adapter_factory, self.clock = processor_factory, adapter_factory, clock
        self.backend = self.engine = self.wake = self.vad = self.processor = None
        self.state, self.generation = "loading", None
        self.source, self.player = None, None
        self.playing_source = None
        self.play_progress, self.play_cancelled_at = 0, None
        self.play_result = queue.Queue(maxsize=1)
        self.pre_roll = deque(maxlen=32)
        self.parts, self.partial = [], ""
        self.turns, self.level = 0, 0.0
        self.last_partial = self.started = self.utterance_started = 0
        self.heard_speech = False
        self.reply_deadline = None
        self.failed_sent = False

    def event(self, kind, **values):
        if kind in {"asr.partial", "asr.final"} and self.backend:
            self.backend.check_health()
        if kind == "failed":
            self.failed_sent = True
        self.emit(SpeechWorkerEvent(type=kind, state=self.state, voice_level=self.level, **values))

    def cancel_reply(self):
        if self.source:
            self.source.cancel()
            if self.source is self.playing_source and self.play_cancelled_at is None:
                self.play_cancelled_at = self.clock()
        if self.backend:
            self.backend.cancel_playback()
        self.source = None
        self.reply_deadline = None

    def begin_utterance(self, *, barge=False):
        old = self.generation
        self.cancel_reply()
        if barge and old:
            self.event("interrupted", generation_id=old)
        if self.turns >= self.settings.max_turns:
            self.event("failed", code="SESSION_LIMIT")
            self.stopped.set()
            return
        self.turns += 1
        self.generation = uuid4()
        self.state = "listening"
        self.parts, self.partial = [], ""
        self.utterance_started = self.clock()
        self.heard_speech = barge
        self.engine.new_utterance()
        self.event("wake", generation_id=self.generation)
        if barge:
            for pcm in self.pre_roll:
                self.accept_asr(pcm)
        else:
            self.vad.reset()
        self.pre_roll.clear()

    def accept_asr(self, pcm):
        result = self.engine.accept(pcm)
        if result is None:
            return
        if result.final:
            self.parts.append(result.text)
            self.partial = ""
        else:
            self.partial = result.text
        text = "".join(self.parts) + self.partial
        if len(text) > 4000:
            raise ValueError("ASR utterance exceeds its text budget")
        if text and self.clock() - self.last_partial >= .2:
            self.event("asr.partial", generation_id=self.generation, text=text)
            self.last_partial = self.clock()

    def finish_utterance(self):
        result = self.engine.finish()
        if result:
            self.parts.append(result.text)
        text = "".join(self.parts).strip()
        self.parts, self.partial = [], ""
        self.pre_roll.clear()
        self.vad.reset()
        if len(text) > 4000:
            raise ValueError("ASR utterance exceeds its text budget")
        if text:
            self.state = "thinking"
            self.reply_deadline = self.clock() + 90
            self.event("asr.final", generation_id=self.generation, text=text)
        else:
            self.arm()

    def arm(self):
        self.cancel_reply()
        self.state, self.generation = "armed", None
        self.parts, self.partial = [], ""
        self.pre_roll.clear()
        self.vad.reset()
        self.wake.reset()

    def _play(self, source):
        error = False
        try:
            @contextmanager
            def allowed():
                with getattr(self.settings,'authorize',nullcontext)(),getattr(self.settings,'speech_authorize',lambda generation:nullcontext())(source.generation_id):
                    if self.stopped.is_set() or source.cancelled.is_set():raise PermissionError("Reply was cancelled")
                    yield
                    if source.cancelled.is_set():raise PermissionError("Reply was cancelled")
            adapter = self.adapter_factory(voice_name=self.settings.voice_name, rate=self.settings.voice_rate, voice_id=self.settings.voice_id)
            sequence = 0
            for text in source.segments(allowed):
                pcm = adapter._synthesize(text, cancel_event=source.cancelled, authorize=allowed)
                for offset in range(0, len(pcm), 2048):
                    chunk = PcmChunk(source.generation_id, sequence, pcm[offset:offset + 2048], sample_rate=16000)
                    with allowed():
                        if not self.backend.enqueue(chunk, cancelled=source.cancelled):return
                    self.play_progress = self.clock()
                    sequence += 1
            if not source.cancelled.is_set():
                with allowed():self.backend.finish_playback(source.generation_id, cancelled=source.cancelled)
            error = bool(source.error)
        except PermissionError:
            error = not source.cancelled.is_set() and not self.stopped.is_set()
        except Exception:
            error = True
        finally:
            self.backend.cancel_playback(source.generation_id)
            source.cancel()
            self.play_result.put_nowait((source, error))

    def command(self, command):
        if command.type == "stop":
            self.stopped.set()
            return
        if not command.type.startswith("reply."):
            raise ValueError("Unexpected speech control transition")
        if command.generation_id != self.generation or self.state not in {"thinking", "speaking"}:
            return
        if command.type == "reply.cancel":
            self.arm()
        elif command.type == "reply.begin":
            if self.source:
                raise ValueError("Reply cannot be replayed")
            self.source = ReplySpeechBuffer(self.generation)
            self.state, self.reply_deadline = "speaking", None
        elif self.source is None:
            raise ValueError("Reply text arrived before begin")
        elif command.type == "reply.delta":
            if not self.source.append(command.text):
                raise ValueError("Reply exceeded its text budget")
        elif command.type == "reply.finish":
            self.source.finish()

    def start_playback(self):
        if self.source is None or self.source is self.playing_source or self.player and self.player.is_alive():
            return
        self.backend.begin_playback(self.source.generation_id,authorize=lambda generation=self.source.generation_id:getattr(self.settings,'speech_authorize',lambda generation:nullcontext())(generation))
        self.playing_source = self.source
        self.play_progress, self.play_cancelled_at = self.clock(), None
        self.player = threading.Thread(target=self._play, args=(self.source,), daemon=True, name="speech-render")
        self.player.start()

    def collect_playback(self):
        try:
            source, error = self.play_result.get_nowait()
        except queue.Empty:
            return
        if source is self.source:
            if error:
                self.event("failed", code="REPLY_FAILED")
                self.stopped.set()
            else:
                generation = self.generation
                self.arm()
                self.event("reply.finished", generation_id=generation)

    def frame(self, frame):
        pcm = self.processor.process(frame.capture, frame.render_reference, stream_delay_ms=frame.delay_ms)
        if not pcm:
            return
        samples = np.frombuffer(pcm, dtype="<i2").astype(np.float32)
        self.level = min(1.0, float(np.sqrt(np.mean(samples * samples))) / 32768)
        if self.state == "armed":
            if self.wake.accept(pcm):
                self.begin_utterance()
            return
        transition = self.vad.accept(pcm)
        if self.state in {"thinking", "speaking"}:
            self.pre_roll.append(pcm)
            if transition.started:
                self.begin_utterance(barge=True)
            return
        self.heard_speech = self.heard_speech or transition.active or transition.started
        self.accept_asr(pcm)
        elapsed = self.clock() - self.utterance_started
        if transition.ended or elapsed >= 15:
            self.finish_utterance()
        elif not self.heard_speech and elapsed >= 8:
            self.arm()

    def run(self):
        stage = "LOCAL_MODEL_UNAVAILABLE"
        try:
            asr, wake, vad = self.settings.profiles()
            with getattr(self.settings,'authorize',nullcontext)():pass
            self.engine = self.engine_factory(asr)
            with getattr(self.settings,'authorize',nullcontext)():pass
            if self.stopped.is_set():
                return
            self.wake = self.wake_factory(wake)
            with getattr(self.settings,'authorize',nullcontext)():pass
            self.vad = self.vad_factory(vad)
            with getattr(self.settings,'authorize',nullcontext)():pass
            self.processor = self.processor_factory(echo_cancellation=True,
                noise_suppression=self.settings.noise_suppression)
            if self.stopped.is_set():
                return
            self.event("prepared")
            stage = "CONTROL_FAILED"
            deadline = self.clock() + 10
            while not self.stopped.is_set():
                if self.clock() >= deadline:
                    raise TimeoutError("Prepared session was not started")
                try:
                    command = self.commands.get(timeout=.05)
                except queue.Empty:
                    continue
                if command.type == "stop":
                    return
                if command.type != "start":
                    raise ValueError("Expected explicit start")
                break
            if self.stopped.is_set():
                return
            stage = "AUDIO_UNAVAILABLE"
            self.backend = self.backend_factory()
            with getattr(self.settings,'authorize',nullcontext)():
                self.backend.start(self.settings.capture.binding(), self.settings.render.binding(),authorize=getattr(self.settings,'authorize',nullcontext))
            self.started = self.clock()
            self.state = "armed"
            self.event("ready")
            heartbeat = self.started
            stage = "AUDIO_FAILED"
            while not self.stopped.is_set():
                with getattr(self.settings,'authorize',nullcontext)():pass
                if self.clock() - self.started >= self.settings.duration_seconds:
                    self.event("failed", code="SESSION_LIMIT")
                    break
                # Bounded work per iteration prevents text producers starving the audio reader.
                for _ in range(16):
                    try:
                        command = self.commands.get_nowait()
                    except queue.Empty:
                        break
                    self.command(command)
                if self.stopped.is_set():
                    break
                self.collect_playback()
                self.start_playback()
                if self.player and self.player.is_alive() and (
                    self.clock() - self.play_progress >= 32 or
                    self.play_cancelled_at is not None and self.clock() - self.play_cancelled_at >= 1
                ):
                    self.event("failed", code="REPLY_FAILED")
                    break
                if self.reply_deadline is not None and self.clock() >= self.reply_deadline:
                    self.event("failed", code="REPLY_FAILED")
                    break
                frame = self.backend.read(timeout=.02)
                if frame is not None:
                    self.frame(frame)
                if self.clock() - heartbeat >= .5:
                    self.event("heartbeat", generation_id=self.generation)
                    heartbeat = self.clock()
        except Exception:
            if not self.stopped.is_set():
                self.event("failed", code=stage)
        finally:
            self.stopped.set()
            self.cancel_reply()
            if self.backend:
                try:
                    self.backend.stop()
                except Exception:
                    if not self.failed_sent:
                        self.event("failed", code="AUDIO_FAILED")
            if self.player:
                self.player.join(timeout=1)
            for resource in (self.processor, self.vad, self.wake):
                if resource:
                    resource.close()
            self.engine = None
            self.parts, self.partial = [], ""
            self.pre_roll.clear()
            self.state, self.level = "idle", 0
            self.event("stopped")
