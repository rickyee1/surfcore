"""One bounded subprocess transport; authority never loads torch or blocks on pipes."""
import json
import math
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
from semantic_model import DIMENSION, ERRORS, FINGERPRINT, ModelFailure


def normalized(vector):
    if not isinstance(vector,list) or len(vector)!=DIMENSION or any(type(v) not in (int,float) or not math.isfinite(v) for v in vector):
        raise ModelFailure('SEMANTIC_INVALID_VECTOR')
    length = math.sqrt(sum(v*v for v in vector))
    if not .999 <= length <= 1.001:
        raise ModelFailure('SEMANTIC_INVALID_VECTOR')
    return [v/length for v in vector]


class SemanticRuntime:
    def __init__(self):
        self.lock = threading.Lock()
        self.process = None
        self.closed = False
        self.retired = queue.Queue(maxsize=2)
        self.retired_count = 0
        self.reaper = None

    def _process(self, cancel):
        with self.lock:
            if self.closed or cancel.is_set():
                raise ModelFailure('SEMANTIC_WORKER_FAILED')
            if self.process is not None and self.process.poll() is not None:
                self._retire(self.process)
                self.process = None
            if self.process is None or self.process.poll() is not None:
                if self.retired_count>=2:
                    raise ModelFailure('SEMANTIC_WORKER_FAILED')
                # Deliberate allowlist: no database key, DSH config, provider credentials or user content.
                environment = {k:v for k,v in os.environ.items() if k.upper() in ('PATH','SYSTEMROOT','WINDIR','TEMP','TMP','OS','USERPROFILE','LOCALAPPDATA','APPDATA','PROGRAMDATA','PROGRAMFILES','PROGRAMFILES(X86)','COMMONPROGRAMFILES')}
                environment.update(HF_HUB_OFFLINE='1',TRANSFORMERS_OFFLINE='1',HF_HUB_DISABLE_TELEMETRY='1',TOKENIZERS_PARALLELISM='false',OMP_NUM_THREADS='2',MKL_NUM_THREADS='2',PYTHONUTF8='1')
                self.process = subprocess.Popen([sys.executable,'-u',str(Path(__file__).with_name('semantic_worker.py'))],
                    stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,cwd=str(Path(__file__).parent),env=environment,
                    creationflags=0x08000000 if os.name=='nt' else 0)
            return self.process

    def encode(self, items, cancel):
        process = self._process(cancel)
        vectors = []
        try:
            for offset in range(0,len(items),32):
                if cancel.is_set():
                    raise ModelFailure('SEMANTIC_WORKER_FAILED')
                batch = items[offset:offset+32]
                process.stdin.write((json.dumps(dict(items=batch),ensure_ascii=False,separators=(',',':'))+'\n').encode('utf-8'))
                process.stdin.flush()
                line = process.stdout.readline(1_048_577)
                if not line or len(line)>1_048_576:
                    raise ModelFailure('SEMANTIC_WORKER_FAILED')
                result = json.loads(line)
                if not result.get('ok'):
                    raise ModelFailure(result.get('code') if result.get('code') in ERRORS else 'SEMANTIC_WORKER_FAILED')
                if result.get('fingerprint')!=FINGERPRINT or not isinstance(result.get('vectors'),list) or len(result['vectors'])!=len(batch):
                    raise ModelFailure('SEMANTIC_INVALID_VECTOR')
                vectors.extend(normalized(vector) for vector in result['vectors'])
            return vectors
        except BaseException:
            self.cancel()
            raise

    def cancel(self):
        with self.lock:
            process,self.process = self.process,None
            if process:
                if process.poll() is None:
                    try:
                        process.terminate()  # No wait on authority; blocked reader receives EOF.
                    except OSError:
                        pass
                self._retire(process)

    def _retire(self, process):
        # Caller holds self.lock; references survive until pipes/process are reaped.
        self.retired_count += 1
        self.retired.put_nowait(process)
        if self.reaper is None:
            self.reaper = threading.Thread(target=self._reap,daemon=True,name='semantic-worker-cleanup')
            self.reaper.start()

    def _reap(self):
        # One bounded cleanup consumer, never a thread per cancelled process.
        while True:
            process = self.retired.get()
            try:
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
                finally:
                    for stream in (process.stdin,process.stdout):
                        try:
                            stream.close()
                        except (OSError,ValueError):
                            pass
            except (OSError,ValueError,subprocess.TimeoutExpired):
                pass
            finally:
                with self.lock:
                    self.retired_count -= 1
                self.retired.task_done()

    def close(self):
        with self.lock:
            self.closed = True
        self.cancel()
