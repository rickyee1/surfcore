"""Bounded JSONL stdio transport. stdout contains protocol responses only."""
import argparse
import json
import queue
import sys
import threading
from core import CapabilityService
from storage import ServiceError

MAX_LINE = 1_048_576


def read_requests(stream, incoming):
    """Only input I/O is threaded. Bounded queue; no SQLite or protocol output here."""
    try:
        while True:
            line = stream.readline(MAX_LINE + 1)
            if not line:
                break
            oversized = len(line) > MAX_LINE
            if oversized:
                while line and not line.endswith(b'\n'):
                    line = stream.readline(MAX_LINE + 1)
            incoming.put((line, oversized))
    finally:
        incoming.put(None)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--data-dir", required=True)
    args = parser.parse_args()
    if hasattr(sys.stdin, "reconfigure"):
        sys.stdin.reconfigure(encoding="utf-8")
        sys.stdout.reconfigure(encoding="utf-8", errors="strict")
    service = None
    startup_error = None
    try:
        service = CapabilityService(args.data_dir)
    except ServiceError as error:
        startup_error = error
    incoming = queue.Queue(maxsize=32)
    threading.Thread(target=read_requests, args=(sys.stdin.buffer, incoming), daemon=True, name='local-jsonl-input').start()
    try:
        while True:
            try:
                item = incoming.get(timeout=0.05)
            except queue.Empty:
                if service and not startup_error:
                    try:
                        service.poll()
                    except Exception:
                        # Failure to persist authority state closes tools; never run fail-open.
                        service.close()
                        startup_error = ServiceError('SERVICE_UNAVAILABLE', '本机工具状态无法持久化。', '暂停工具和发送，检查磁盘与服务后重启。')
                continue
            if item is None:
                break
            line, oversized = item
            request = None
            try:
                if oversized:
                    raise ValueError("oversized")
                request = json.loads(line.decode("utf-8"), parse_constant=lambda _: (_ for _ in ()).throw(ValueError("constant")))
                if startup_error:
                    response = dict(protocol_version=1, request_id=request.get("request_id") if isinstance(request, dict) else None,
                                    ok=False, code=startup_error.code, error=startup_error.error, hint=startup_error.hint)
                else:
                    response = service.handle(request)
            except (ValueError, UnicodeError):
                response = dict(protocol_version=1, request_id=None, ok=False, code="INVALID_REQUEST", error="JSON 请求无效或超过大小限制。", hint="发送至多 1 MiB 的单行 JSON 对象。")
            print(json.dumps(response, ensure_ascii=False, allow_nan=False), flush=True)
    finally:
        if service:
            service.close()


if __name__ == "__main__":
    main()
