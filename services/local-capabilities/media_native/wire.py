"""Internal worker data only; the main authority validates all public inputs."""
import json
from contextlib import contextmanager
import threading
import time
from types import SimpleNamespace
from uuid import UUID
from media_native.audio_devices import DeviceBinding


class SpeechWorkerEvent:
    def __init__(self, **values):
        self.__dict__.update(values)


class Binding:
    def __init__(self, data):
        self.data=data

    def binding(self):
        return DeviceBinding(self.data['index'],self.data['kind'],self.data['fingerprint'])


class WorkerPermit:
    """Original parent deadlines; the pipe can revoke, never renew signed authority."""
    def __init__(self,data,stopped):
        self.data=dict(data);self.stopped=stopped;self.lock=threading.RLock();self.speeches={}

    def check(self,generation=None):
        with self.lock:
            if (self.stopped.is_set() or time.time()*1000>=self.data['expires_at'] or
                time.monotonic()>=self.data['deadline'] or time.monotonic()>=self.data['visibility_deadline']):
                self.stopped.set()
                raise PermissionError('MEDIA_LEASE_STALE')
            if generation is not None:
                item=self.speeches.get(str(generation))
                if (not item or item['cancel'].is_set() or time.time()*1000>=item['expires_at'] or
                    time.monotonic()>=item['deadline'] or time.monotonic()>=item['source_visibility_deadline']):
                    if item:item['cancel'].set()
                    raise PermissionError('MEDIA_DELIVERY_STALE')

    @contextmanager
    def authorize(self,generation=None):
        self.check(generation)
        yield
        self.check(generation)

    def control(self,cmd):
        with self.lock:
            kind=cmd['type'];generation=str(cmd.get('generation_id'))
            if kind=='speech.stop':
                item=self.speeches.get(generation)
                if item:item['cancel'].set()
                return
            self.check()
            if kind=='pulse':
                self.data['visibility_deadline']=min(cmd['visibility_deadline'],time.monotonic()+3,self.data['deadline'])
            elif kind=='speak':
                # One immutable attempt per source generation. No queue replays.
                if generation in self.speeches:raise PermissionError('MEDIA_SPEECH_USED')
                self.speeches[generation]=dict(cmd,cancel=threading.Event())
                self.check(generation)
            elif kind=='speech.pulse':
                self.check(generation)  # Late source pulses cannot revive expired speech.
                self.speeches[generation]['source_visibility_deadline']=min(cmd['source_visibility_deadline'],time.monotonic()+3,self.speeches[generation]['deadline'])

    def cancelled(self,generation):return self.speeches[str(generation)]['cancel']


class Settings:
    def __init__(self, data, permit):
        self.capture=Binding(data['input'])
        self.render=Binding(data['output'])
        self.voice_name=data['voice']['name']
        self.voice_id=data['voice']['token_id']
        self.voice_rate=0
        self.noise_suppression=True
        permit.check()
        self.duration_seconds=min(900,(data['expires_at']/1000-time.time()),data['deadline']-time.monotonic())
        self.authorize=permit.authorize
        self.speech_authorize=lambda generation:permit.authorize(str(generation))
        self.max_turns=40

    def profiles(self):
        from media_assets import profiles
        return profiles()


def command(value):
    if 'generation_id' in value:
        value=dict(value,generation_id=UUID(value['generation_id']))
    return SimpleNamespace(**value)
