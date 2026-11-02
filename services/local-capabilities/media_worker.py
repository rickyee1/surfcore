"""Contained local device worker. No DB, credentials, model chat or image persistence."""
import base64
from contextlib import contextmanager
from dataclasses import asdict
import hashlib
import json
import os
import queue
import sys
import threading
import time
from uuid import UUID,uuid4


def catalog():
    import sounddevice as sd
    import pythoncom
    import win32com.client
    from media_native.audio_endpoints import EndpointAccess
    from media_native.audio_devices import fingerprint
    from media_native.window_targets import list_windows
    devices=[]
    for item in EndpointAccess(sd).devices():
        for kind in ('input','output'):
            if item[f'max_{kind}_channels']:
                devices.append(dict(index=item['id'],kind=kind,fingerprint=fingerprint(item),name=item['name'],
                                    sample_rate=item['default_samplerate'],hostapi=item['hostapi_name']))
    pythoncom.CoInitialize()
    try:
        voices=[dict(name=v.GetDescription(),token_id=v.Id) for v in win32com.client.Dispatch('SAPI.SpVoice').GetVoices()]
    finally:
        pythoncom.CoUninitialize()
    return dict(devices=devices,voices=voices,windows=[asdict(w) for w in list_windows((os.getpid(),os.getppid()))])


def ptt(settings, commands, emit, stopped, permit=None):
    from media_native.wire import WorkerPermit
    permit=permit or WorkerPermit(settings,stopped)
    from media_assets import verify,profiles
    from media_native.asr import SherpaOnlineEngine
    from media_native.audio_devices import DeviceBinding
    from media_native.audio_frontend import WasapiBackend
    from media_native.audio_processing import WebRtcAudioProcessor
    verify(('asr',))
    permit.check()
    engine=SherpaOnlineEngine.from_profile(profiles()[0])
    permit.check()
    backend,processor=WasapiBackend(),WebRtcAudioProcessor(noise_suppression=True)
    frames=queue.Queue(maxsize=50)
    generation=str(uuid4());parts=[];final=False;last_partial='';last_partial_at=0
    try:
        permit.check()
        if not commands.empty():
            raise ValueError('MEDIA_CAPTURE_NOT_STARTED')
        binding=DeviceBinding(**{k:settings['input'][k] for k in ('index','kind','fingerprint')})
        backend.start(lambda pcm:frames.put_nowait(pcm),binding.index,binding=binding,authorize=permit.authorize)
        emit(dict(type='ready',state='listening',generation_id=generation))
        heartbeat=time.monotonic()
        while not stopped.is_set() and time.time()*1000<settings['expires_at']:
            permit.check()
            backend.check_health()
            try:
                cmd=commands.get_nowait()
                if cmd['type']=='finish' and not final:
                    backend.quiesce()
                    while not frames.empty():
                        result=engine.accept(processor.process(frames.get_nowait()))
                        if result and result.final:parts.append(result.text)
                    result=engine.finish()
                    permit.check()
                    if result:parts.append(result.text)
                    text=''.join(parts).strip()
                    if not text or len(text)>4000:
                        raise ValueError('MEDIA_NO_SPEECH')
                    emit(dict(type='asr.final',state='preview',generation_id=generation,text=text))
                    final=True
            except queue.Empty:
                pass
            if not final:
                try:
                    pcm=frames.get(timeout=.02)
                    result=engine.accept(processor.process(pcm))
                    if result:
                        if result.final:parts.append(result.text)
                        text=''.join(parts)+('' if result.final else result.text)
                        if len(text)>4000:raise ValueError('MEDIA_TRANSCRIPT_LIMIT')
                        if text and text!=last_partial and time.monotonic()-last_partial_at>=.2:
                            emit(dict(type='asr.partial',state='listening',generation_id=generation,text=text))
                            last_partial,last_partial_at=text,time.monotonic()
                except queue.Empty:
                    pass
            else:
                stopped.wait(.05)
            if time.monotonic()-heartbeat>=.5:
                emit(dict(type='heartbeat',state='preview' if final else 'listening'))
                heartbeat=time.monotonic()
    finally:
        backend.stop();processor.close()


def output(settings, commands, emit, stopped, permit=None):
    from media_native.wire import WorkerPermit
    permit=permit or WorkerPermit(settings,stopped)
    permit.check()
    from media_native.audio_devices import DeviceBinding
    from media_native.audio_endpoints import EndpointAccess,EndpointLease
    from media_native.tts import SapiTtsAdapter,WasapiOutput,PcmChunk,ChineseSegmenter
    import sounddevice as sd
    binding=DeviceBinding(**{k:settings['output'][k] for k in ('index','kind','fingerprint')})
    with permit.authorize():monitor=EndpointLease(EndpointAccess(sd),[('output',binding.index,binding)])
    sink=WasapiOutput(binding.index)
    current=None;player=None;results=queue.Queue(maxsize=1)
    def play(cmd,cancel):
        try:
            @contextmanager
            def authorize():
                with permit.authorize(cmd['generation_id']):
                    if cancel.is_set():raise PermissionError('cancelled')
                    monitor.check();permit.check(cmd['generation_id']);yield;monitor.check()
            synth=SapiTtsAdapter(voice_name=settings['voice']['name'],voice_id=settings['voice']['token_id'])
            segmenter=ChineseSegmenter();sequence=0
            with authorize():sink.pin(binding)
            for segment in segmenter.feed(cmd['text'],final=True):
                pcm=synth._synthesize(segment,cancel_event=cancel,authorize=authorize)
                for offset in range(0,len(pcm),4096):
                    if not sink.write_authorized(PcmChunk(UUID(cmd['generation_id']),sequence,pcm[offset:offset+4096]),cancelled=cancel,authorize=authorize):
                        return
                    sequence+=1
            sink.finish(cancelled=cancel,authorize=authorize)
            if not cancel.is_set():results.put_nowait(dict(type='reply.finished',generation_id=cmd['generation_id']))
        except Exception:
            if not cancel.is_set():results.put_nowait(dict(type='failed',code='MEDIA_PLAYBACK_FAILED'))
    try:
        if stopped.is_set():return
        permit.check()
        emit(dict(type='ready',state='idle'))
        heartbeat=time.monotonic()
        while not stopped.is_set() and time.time()*1000<settings['expires_at']:
            permit.check()
            monitor.check()
            try:
                cmd=commands.get(timeout=.05)
                if cmd['type']=='speak':
                    if player and player.is_alive():raise ValueError('MEDIA_OUTPUT_BUSY')
                    if len(cmd['text'])>4000:raise ValueError('MEDIA_TRANSCRIPT_LIMIT')
                    if str(cmd['generation_id']) not in permit.speeches:permit.control(cmd)
                    current=permit.cancelled(cmd['generation_id'])
                    player=threading.Thread(target=play,args=(cmd,current),daemon=True)
                    player.start()
                elif cmd['type']=='speech.stop':
                    permit.control(cmd)
                    if current:current.set()
                    sink.stop()
                elif cmd['type'] in ('pulse','speech.pulse'):permit.control(cmd)
            except queue.Empty:
                pass
            try:emit(results.get_nowait())
            except queue.Empty:pass
            if time.monotonic()-heartbeat>=.5:
                emit(dict(type='heartbeat',state='speaking' if player and player.is_alive() else 'idle'))
                heartbeat=time.monotonic()
    finally:
        if current:current.set()
        sink.stop();monitor.close()


def serve(reader,writer):
    stopped=threading.Event();commands=queue.Queue(maxsize=32);events=queue.Queue(maxsize=64)
    overflow=threading.Event()
    def emit(event):
        try:events.put_nowait(event)
        except queue.Full:overflow.set();stopped.set()
    def transmit():
        try:
            while True:
                event=events.get()
                if event is None:return
                writer.write((json.dumps(event,ensure_ascii=False,default=str,separators=(',',':'))+'\n').encode('utf-8'));writer.flush()
        except Exception:stopped.set()
    outgoing=threading.Thread(target=transmit,daemon=True);outgoing.start()
    raw=reader.readline(65537)
    settings=json.loads(raw)
    mode=settings['mode']
    from media_native.wire import WorkerPermit
    permit=WorkerPermit(settings,stopped) if mode!='catalog' else None
    def receive():
        try:
            while not stopped.is_set():
                line=reader.readline(65537)
                if not line:stopped.set();return
                if len(line)>65536:raise ValueError()
                cmd=json.loads(line)
                if cmd['type']=='stop':stopped.set();return
                if permit and cmd['type'] in ('pulse','speech.pulse','speak','speech.stop'):
                    permit.control(cmd)  # Cancel immediately, even while SAPI/model work is blocked.
                    if cmd['type'] in ('pulse','speech.pulse'):continue
                if mode=='handsfree':
                    from media_native.wire import command
                    if cmd['type']=='speak':
                        for kind in ('reply.begin','reply.delta','reply.finish'):
                            commands.put_nowait(command(dict(type=kind,generation_id=cmd['generation_id'],**({'text':cmd['text']} if kind=='reply.delta' else {}))))
                    elif cmd['type']=='speech.stop':commands.put_nowait(command(dict(type='reply.cancel',generation_id=cmd['generation_id'])))
                else:commands.put_nowait(cmd)
        except Exception:overflow.set();stopped.set()
    threading.Thread(target=receive,daemon=True).start()
    try:
        if stopped.is_set():return
        if permit:permit.check()
        if mode=='catalog':emit(dict(type='catalog',data=catalog()))
        elif mode=='window':
            from media_native.window_targets import WindowTarget
            from media_native.wgc_worker import capture
            target=WindowTarget(**settings['window'])
            with permit.authorize():data=capture(target,authorize=permit.authorize)
            emit(dict(type='frame',png=base64.b64encode(data).decode('ascii'),sha256=hashlib.sha256(data).hexdigest()))
        elif mode=='ptt':ptt(settings,commands,emit,stopped,permit)
        elif mode=='output':output(settings,commands,emit,stopped,permit)
        elif mode=='handsfree':
            from media_assets import verify
            from media_native.speech_loop import SpeechLoop
            from media_native.wire import Settings,command
            verify()
            permit.check()
            commands.put_nowait(command(dict(type='start')))
            SpeechLoop(Settings(settings,permit),commands,lambda event:emit(event.__dict__),stopped).run()
        else:raise ValueError('MEDIA_PROTOCOL_FAILED')
    except ImportError:
        emit(dict(type='failed',code='MEDIA_DEPENDENCY_MISSING'))
    except FileNotFoundError:
        emit(dict(type='failed',code='MEDIA_MODEL_MISSING'))
    except Exception as failure:
        allowed={'MEDIA_NO_SPEECH','MEDIA_CAPTURE_NOT_STARTED','MEDIA_TRANSCRIPT_LIMIT','MEDIA_OUTPUT_BUSY','MEDIA_MODEL_INVALID'}
        emit(dict(type='failed',code=str(failure) if str(failure) in allowed else 'MEDIA_WORKER_FAILED'))
    finally:
        stopped.set()
        if overflow.is_set():emit(dict(type='failed',code='MEDIA_QUEUE_OVERFLOW'))
        emit(dict(type='stopped'))
        try:events.put(None,timeout=.5)
        except queue.Full:pass
        outgoing.join(timeout=1)


if __name__=='__main__':
    # Native-library messages never enter the result protocol or logs.
    with os.fdopen(os.dup(sys.stdout.fileno()),'wb',buffering=0) as protocol:
        os.dup2(sys.stderr.fileno(),sys.stdout.fileno())
        serve(sys.stdin.buffer,protocol)
