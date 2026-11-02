"""Bounded media pipes and parent-owned Windows process lifetime containment."""
import json
import os
from pathlib import Path
import queue
import subprocess
import sys
import threading
from tool_broker import CompletionQueue


class MediaEvents(CompletionQueue):
    def __init__(self):
        super().__init__(maxsize=64)
        self.bytes=0
        self.accounting=threading.Lock()

    def emit(self, identifier, event):
        size=len(json.dumps(event,ensure_ascii=False).encode('utf-8'))
        with self.accounting:
            if self.bytes+size>8*1024*1024:raise queue.Full()
            self.bytes+=size
            try:self.put_nowait((identifier,event,size))
            except BaseException:self.bytes-=size;raise

    def acknowledge(self,batch):
        super().acknowledge(batch)
        with self.accounting:self.bytes-=sum(item[2] for item in batch)


class MediaRuntime:
    def __init__(self):
        self.events=MediaEvents()
        self.jobs={};self.lock=threading.RLock();self.closed=False
        self.overflow=threading.Event();self.job_object=None

    def _contain(self, process):
        import win32job
        with self.lock:
            if self.closed:raise RuntimeError('closed')
            if self.job_object is None:
                self.job_object=win32job.CreateJobObject(None,'')
                limits=win32job.QueryInformationJobObject(self.job_object,win32job.JobObjectExtendedLimitInformation)
                limits['BasicLimitInformation']['LimitFlags']|=win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                win32job.SetInformationJobObject(self.job_object,win32job.JobObjectExtendedLimitInformation,limits)
            win32job.AssignProcessToJobObject(self.job_object,int(process._handle))

    def emit(self,identifier,event):
        try:self.events.emit(identifier,event)
        except queue.Full:
            self.overflow.set();self.stop_all()

    def active(self, modes):
        with self.lock:
            return any(job['settings']['mode'] in modes and not job['finished'].is_set() for job in self.jobs.values())

    def start(self,identifier,settings):
        with self.lock:
            if self.closed or len(self.jobs)>=4:raise RuntimeError('MEDIA_BUSY')
            job=dict(settings=settings,commands=queue.Queue(maxsize=32),stop=threading.Event(),finished=threading.Event(),process=None)
            self.jobs[identifier]=job
        def run():
            process=None;writer=None
            try:
                if job['stop'].is_set():return
                environment={k:v for k,v in os.environ.items() if k.upper() in ('PATH','SYSTEMROOT','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','PROGRAMDATA','PROGRAMFILES','PROGRAMFILES(X86)','COMMONPROGRAMFILES','OS')}
                environment.update(OMP_NUM_THREADS='2',MKL_NUM_THREADS='2',PYTHONUTF8='1',HF_HUB_OFFLINE='1',HF_HUB_DISABLE_TELEMETRY='1')
                process=subprocess.Popen([sys.executable,'-u',str(Path(__file__).with_name('media_worker.py'))],stdin=subprocess.PIPE,stdout=subprocess.PIPE,
                    stderr=subprocess.DEVNULL,env=environment,cwd=str(Path(__file__).parent),creationflags=0x08000000 if os.name=='nt' else 0)
                job['process']=process
                self._contain(process)  # Before sending any configuration that can open a device.
                if job['stop'].is_set():return
                def send():
                    try:
                        process.stdin.write((json.dumps(settings,ensure_ascii=False)+'\n').encode('utf-8'));process.stdin.flush()
                        while not job['stop'].is_set():
                            try:command=job['commands'].get(timeout=.05)
                            except queue.Empty:continue
                            process.stdin.write((json.dumps(command,ensure_ascii=False)+'\n').encode('utf-8'));process.stdin.flush()
                    except Exception:
                        job['stop'].set()
                        if process.poll() is None:process.terminate()
                writer=threading.Thread(target=send,daemon=True,name='media-control');writer.start()
                while not job['stop'].is_set():
                    line=process.stdout.readline(2_100_001)
                    if not line:break
                    if len(line)>2_100_000:raise ValueError('MEDIA_PROTOCOL_FAILED')
                    event=json.loads(line)
                    if not isinstance(event,dict):raise ValueError('MEDIA_PROTOCOL_FAILED')
                    self.emit(identifier,event)
                if not job['stop'].is_set():self.emit(identifier,dict(type='process.exited'))
            except Exception:
                self.emit(identifier,dict(type='failed',code='MEDIA_WORKER_FAILED'))
            finally:
                job['stop'].set()
                if process:
                    if process.poll() is None:process.terminate()
                    try:process.wait(timeout=2)
                    except subprocess.TimeoutExpired:process.kill();process.wait(timeout=2)
                    for stream in (process.stdin,process.stdout):
                        try:stream.close()
                        except (OSError,ValueError):pass
                if writer:writer.join(timeout=.2)
                job['finished'].set()
        threading.Thread(target=run,daemon=True,name='media-result').start()

    def command(self, identifier, value):
        with self.lock:
            job=self.jobs.get(identifier)
            if not job or job['stop'].is_set() or job['finished'].is_set():raise RuntimeError('MEDIA_WORKER_STOPPED')
            try:job['commands'].put_nowait(value)
            except queue.Full:
                self.overflow.set();self.stop_all();raise

    def stop(self,identifier):
        with self.lock:
            job=self.jobs.get(identifier)
            if job:
                job['stop'].set()
                process=job['process']
                if process and process.poll() is None:
                    try:process.terminate()
                    except OSError:pass

    def stop_all(self):
        with self.lock:
            for identifier in list(self.jobs):self.stop(identifier)

    def collect(self):
        with self.lock:
            for identifier in list(self.jobs):
                if self.jobs[identifier]['finished'].is_set():del self.jobs[identifier]

    def close(self):
        with self.lock:
            self.closed=True
            self.stop_all()
            if self.job_object:
                self.job_object.Close();self.job_object=None
