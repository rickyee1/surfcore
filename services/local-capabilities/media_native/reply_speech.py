"""Bounded, generation-owned text handoff from async chat to a speech thread."""
import asyncio
from contextlib import nullcontext
import queue
import threading
import time
from uuid import UUID

from media_native.tts import ChineseSegmenter


class ReplySpeechBuffer:
    def __init__(self, generation_id, *, max_pending=8000, clock=time.monotonic):
        if type(max_pending) is not int or not 1 <= max_pending <= 8000:
            raise ValueError("Invalid speech buffer capacity")
        self.generation_id = UUID(str(generation_id))
        self.cancelled = threading.Event()
        self._queue = queue.Queue(maxsize=max_pending)
        self._lock = threading.Lock()
        self._clock, self._updated = clock, clock()
        self._characters = 0
        self._finished = self._consuming = False
        self.error = None

    @property
    def pending(self):
        return self._queue.qsize()

    def _clear(self):
        while not self._queue.empty():
            try:
                self._queue.get_nowait()
            except queue.Empty:
                break

    def append(self, text):
        if not isinstance(text, str):
            raise ValueError("Speech delta must be text")
        with self._lock:
            if self.cancelled.is_set() or self._finished:
                return False
            if not text:
                return True
            if self._characters + len(text) > 8000 or self._queue.full():
                self.error = "SPEECH_BUFFER_LIMIT"
                self.cancelled.set()
                self._clear()
                return False
            self._characters += len(text)
            self._updated = self._clock()
            self._queue.put_nowait(text)
            return True

    def finish(self):
        with self._lock:
            self._finished = True

    def cancel(self):
        with self._lock:
            self.cancelled.set()
            self._clear()

    def fail(self):
        with self._lock:
            self.error = "SPEECH_REPLY_FAILED"
            self.cancelled.set()
            self._clear()

    def segments(self, authorize=nullcontext):
        with self._lock:
            if self._consuming:
                raise ValueError("Speech buffer cannot be replayed")
            self._consuming = True
        segmenter = ChineseSegmenter()
        completed = False
        try:
            while not self.cancelled.is_set():
                with authorize():
                    pass
                with self._lock:
                    if self._finished and self._queue.empty():
                        break
                    if self._queue.empty() and self._clock() - self._updated >= 30:
                        self.error = "SPEECH_REPLY_TIMEOUT"
                        self.cancelled.set()
                        break
                try:
                    text = self._queue.get(timeout=.05)
                except queue.Empty:
                    continue
                if self.cancelled.is_set():
                    return
                for segment in segmenter.feed(text):
                    if self.cancelled.is_set():
                        return
                    yield segment
            if not self.cancelled.is_set():
                yield from segmenter.feed("", final=True)
                completed = True
        finally:
            segmenter.buffer = ""
            if not completed:
                self.cancel()


class ReplySpeechController:
    """The session loop owns configuration; the runtime alone owns audio devices."""

    def __init__(self):
        self.enabled = False
        self.error = ""
        self._start = self._current = None
        self._tasks = set()

    def configure(self, start=None):
        self.disable()
        self._start = start
        self.enabled = start is not None
        self.error = ""

    def disable(self):
        self.enabled = False
        self._start = None
        self.cancel_active()

    def cancel_active(self):
        if self._current:
            self._current.cancel()
        self._current = None
        for task in tuple(self._tasks):
            task.cancel()

    def begin_turn(self, generation_id):
        if not self.enabled:
            return
        if self._current:
            self._current.cancel()
        self.error = ""
        source = ReplySpeechBuffer(generation_id)
        self._current = source
        task = asyncio.create_task(self._prepare(source, self._start), name="reply-speech-prepare")
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _prepare(self, source, start):
        try:
            if source.cancelled.is_set():
                return
            await start(source)
        except asyncio.CancelledError:
            source.cancel()
        except Exception:
            source.cancel()
            if self._current is source:
                self.error = "本轮自动朗读不可用，文字回复不受影响"

    def _matching(self, generation_id):
        source = self._current
        return source if source and str(source.generation_id) == str(generation_id) else None

    def feed(self, generation_id, delta):
        source = self._matching(generation_id)
        if source and not source.append(delta) and source.error:
            self.error = "本轮自动朗读已停止，文字回复不受影响"

    def finish(self, generation_id):
        source = self._matching(generation_id)
        if source:
            source.finish()

    def cancel(self, generation_id, *, failed=False):
        source = self._matching(generation_id)
        if source:
            source.fail() if failed else source.cancel()

    async def close(self):
        self.disable()
        await asyncio.gather(*tuple(self._tasks), return_exceptions=True)
