"""Bounded JSONL stdio transport. stdout contains protocol responses only."""
import argparse
import json
import sys
from core import CapabilityService
from storage import ServiceError

MAX_LINE = 1_048_576


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
    try:
        while True:
            line = sys.stdin.buffer.readline(MAX_LINE + 1)
            if not line:
                break
            request = None
            try:
                if len(line) > MAX_LINE:
                    while line and not line.endswith(b"\n"):
                        line = sys.stdin.buffer.readline(MAX_LINE + 1)
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
