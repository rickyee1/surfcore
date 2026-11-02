"""One bounded native WGC frame in a disposable worker; never writes images."""
from dataclasses import fields
from contextlib import nullcontext
import io
import json
from pathlib import Path
import sys


def capture(target, *, authorize=nullcontext):
    from PIL import Image
    from windows_capture import WindowsCapture
    from media_native.window_targets import verify_window

    with authorize():verify_window(target)
    result = []
    with authorize():
        capture = WindowsCapture(window_hwnd=target.hwnd, cursor_capture=False,
                                 draw_border=True, secondary_window=False)

    @capture.event
    def on_frame_arrived(frame, control):
        try:
            if result or not 0 < frame.width <= 8192 or not 0 < frame.height <= 8192 or frame.width * frame.height > 16_000_000:
                return
            with authorize():verify_window(target)
            # Copy before returning the mapped D3D11 frame to the native pool.
            with Image.fromarray(frame.frame_buffer[:, :, [2, 1, 0]]) as image:
                image.thumbnail((640, 640), Image.Resampling.LANCZOS)
                with io.BytesIO() as stream:
                    image.save(stream, format="PNG")
                    data = stream.getvalue()
                    if len(data) > 1_500_000:
                        raise ValueError("encoded frame too large")
                    with authorize():result.append(data)
        finally:
            control.stop()

    @capture.event
    def on_closed():
        pass

    with authorize():verify_window(target)
    with authorize():capture.start()
    with authorize():verify_window(target)
    if len(result) != 1:
        raise ValueError("frame unavailable")
    return result.pop()


def main():
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from media_native.window_targets import WindowTarget
    try:
        raw = sys.stdin.buffer.read(64001)
        if len(raw) > 64000:
            raise ValueError()
        value = json.loads(raw)
        if not isinstance(value, dict) or set(value) != {item.name for item in fields(WindowTarget)}:
            raise ValueError()
        data = capture(WindowTarget(**value))
        sys.stdout.buffer.write(b"LUYAOWGC1\n" + data)
        sys.stdout.buffer.flush()
    except Exception:
        # Native errors can contain window titles/paths. Do not log exceptions.
        raise SystemExit(2) from None


if __name__ == "__main__":
    main()
