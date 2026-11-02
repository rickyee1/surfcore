"""T4 authority/worker tests. No microphone, speaker, screenshot or real user content."""
import base64
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import queue
import struct
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import patch
from uuid import uuid4

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('media_service_fixtures',ROOT/'scripts/test-local-capabilities-service.py')
fixtures=importlib.util.module_from_spec(spec);spec.loader.exec_module(fixtures)
from media_runtime import MediaEvents,MediaRuntime
from media_native.audio_devices import DeviceBinding,fingerprint

PNG=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=')
MODEL=dict(provider='fixture',model='fixed-fixture',config_revision='config1',endpoint_identity='ab'*32,adapter_id='audited-fixture',adapter_revision='1',image_capable=True)
WINDOW=dict(hwnd=123,pid=456,created='synthetic-process-creation',executable=r'C:\synthetic\fixture.exe',title='Synthetic document')


class FixtureRuntime:
    def __init__(self):
        self.events=MediaEvents();self.overflow=threading.Event();self.jobs={};self.commands=[];self.stopped=[];self.closed=False

    def start(self,identifier,settings):
        self.jobs[identifier]=copy.deepcopy(settings)
        if settings['mode']=='catalog':
            data=dict(devices=[dict(index=1,kind='input',fingerprint='11'*32,name='Synthetic mic',sample_rate=16000,hostapi='WASAPI'),
                              dict(index=2,kind='output',fingerprint='22'*32,name='Synthetic speaker',sample_rate=16000,hostapi='WASAPI')],
                      voices=[dict(name='Synthetic Chinese voice',token_id='synthetic-voice-id')],windows=[WINDOW.copy()])
            self.events.emit(identifier,dict(type='catalog',data=data))
        else:self.events.emit(identifier,dict(type='ready',state='idle'))

    def active(self,modes):return any(value['mode'] in modes for value in self.jobs.values())
    def command(self,identifier,cmd):self.commands.append((identifier,cmd))
    def stop(self,identifier):self.stopped.append(identifier);self.jobs.pop(identifier,None)
    def stop_all(self):
        for identifier in list(self.jobs):self.stop(identifier)
    def collect(self):pass
    def close(self):self.closed=True;self.stop_all()


class Media(unittest.TestCase):
    for name in ('tearDown','call','good','bad','activate','bind','epoch','ingest'):
        locals()[name]=getattr(fixtures.Behavior,name)

    def setUp(self):
        self.lock='unlocked';self.lock_patch=patch('tool_broker.lockscreen_state',side_effect=lambda:self.lock);self.lock_patch.start();self.addCleanup(self.lock_patch.stop)
        fixtures.Behavior.setUp(self)
        self.pet=self.good(self.call('session.bind',dict(platform='pet',account_id='fixture',conversation_id='local',principal_id='owner',audience_scope='pet:local',is_owner=True,management=False)))['session_binding']
        self.runtime=FixtureRuntime();self.service.media.runtime=self.runtime
        self.window=WINDOW.copy()
        def guard(target):
            if target!=self.window:raise PermissionError('synthetic window replacement')
        self.service.media.window_guard=guard
        self.good(self.call('media.configure',dict(enabled=True,output_provider='sapi'),self.owner))
        catalog=self.good(self.call('media.catalog.start',{},self.owner))
        data=self.good(self.call('media.catalog.status',dict(catalog_id=catalog['catalog_id']),self.owner))
        self.refs=dict(input_ref=next(v['ref'] for v in data['devices'] if v['kind']=='input'),output_ref=next(v['ref'] for v in data['devices'] if v['kind']=='output'),voice_ref=data['voices'][0]['ref'],window_ref=data['windows'][0]['ref'])

    def prepare(self,mode='ptt',**extra):
        keys={'ptt':('input_ref',),'handsfree':('input_ref','output_ref','voice_ref'),'window':('window_ref',),'output':('output_ref','voice_ref')}[mode]
        return self.good(self.call('media.lease.prepare',dict(subject_binding=self.pet,mode=mode,model_selection=MODEL.copy(),**{key:self.refs[key] for key in keys},**extra),self.owner))

    def confirm(self,lease):
        return self.good(self.call('media.lease.confirm',dict(lease_id=lease['lease_id'],expected_revision=lease['revision'],confirmation_digest=lease['confirmation_digest']),self.owner))

    def start(self,mode='ptt',**extra):
        lease=self.prepare(mode,**extra);self.confirm(lease)
        self.good(self.call('media.lease.start',dict(lease_id=lease['lease_id']),self.owner))
        self.good(self.call('media.status',{},self.owner))
        return lease

    def result(self,lease,text='synthetic transcript',kind='transcript'):
        identifier=lease['lease_id'];generation=str(uuid4())
        if kind=='frame':
            self.runtime.events.emit(identifier,dict(type='frame',png=base64.b64encode(PNG).decode(),sha256=hashlib.sha256(PNG).hexdigest()))
        else:self.runtime.events.emit(identifier,dict(type='asr.final',generation_id=generation,text=text))
        self.good(self.call('media.status',{},self.owner))
        return next(item for item in self.service.media.state['results'].values() if item['lease_id']==identifier)

    def delivery(self,lease,result,**extra):
        return self.good(self.call('media.delivery.prepare',dict(lease_id=lease['lease_id'],result_id=result['result_id'],result_hash=result['hash'],host_request_id='host-fixture',turn_id='turn-fixture',context_ref='context-fixture',expected_memory_epoch=self.epoch(),**extra),self.owner))

    def confirm_delivery(self,delivery):
        return self.good(self.call('media.delivery.confirm',dict(delivery_id=delivery['delivery_id'],expected_revision=delivery['revision'],confirmation_digest=delivery['confirmation_digest']),self.owner))

    def context(self,delivery,**extra):
        return dict(delivery_id=delivery['delivery_id'],subject_binding=self.pet,host_request_id=delivery['host_request_id'],turn_id=delivery['turn_id'],context_ref=delivery['context_ref'],model_selection=MODEL.copy())|extra

    def test_management_and_original_pet_only_no_shared_owner_inheritance(self):
        for binding in (self.pet,self.alice,self.group1,self.public):
            self.bad(self.call('media.catalog.start',{},binding),'PERMISSION_DENIED')
            self.bad(self.call('media.configure',dict(enabled=True),binding),'PERMISSION_DENIED')
        shared=self.good(self.call('session.bind',dict(platform='qq',account_id='bot',conversation_id='alice',principal_id='alice',audience_scope='owner:local',is_owner=True,management=False)))['session_binding']
        self.bad(self.call('media.lease.prepare',dict(subject_binding=shared,mode='ptt',model_selection=MODEL,input_ref=self.refs['input_ref']),self.owner),'PERMISSION_DENIED')

    def test_confirm_is_not_start_and_parameters_cannot_change(self):
        lease=self.prepare()
        self.bad(self.call('media.lease.start',dict(lease_id=lease['lease_id']),self.owner),'INVALID_STATE')
        self.bad(self.call('media.lease.confirm',dict(lease_id=lease['lease_id'],expected_revision=1,confirmation_digest=lease['confirmation_digest'],input_ref='other'),self.owner),'INVALID_REQUEST')
        self.confirm(lease)
        self.assertNotIn(lease['lease_id'],self.runtime.jobs)
        self.assertEqual(self.good(self.call('media.lease.status',dict(lease_id=lease['lease_id']),self.owner))['state'],'confirmed')

    def test_ptt_finish_preview_needs_send_confirmation_and_one_consume(self):
        lease=self.start()
        self.good(self.call('media.lease.stop',dict(lease_id=lease['lease_id'],discard=False),self.owner))
        self.assertEqual(self.runtime.commands[-1][1]['type'],'finish')
        result=self.result(lease)
        delivery=self.delivery(lease,result)
        self.bad(self.call('media.delivery.consume',self.context(delivery),self.owner),'CONFIRMATION_REQUIRED')
        self.confirm_delivery(delivery)
        consumed=self.good(self.call('media.delivery.consume',self.context(delivery),self.owner))
        self.assertEqual(consumed['text'],'synthetic transcript');self.assertFalse(consumed['memory_write']);self.assertTrue(consumed['history_write'])
        self.bad(self.call('media.delivery.consume',self.context(delivery),self.owner),'MEDIA_DELIVERY_CONSUMED')
        self.assertEqual(self.service.db.execute('SELECT count(*) FROM memories').fetchone()[0],0)

    def test_window_same_hash_chunk_preview_and_no_history(self):
        lease=self.start('window')
        result=self.result(lease,kind='frame')
        params=dict(lease_id=lease['lease_id'],result_id=result['result_id'],result_hash=result['hash'])
        chunk=self.good(self.call('media.frame.read',params,self.owner))
        self.assertEqual(base64.b64decode(chunk['base64']),PNG);self.assertFalse(chunk['memory_write']);self.assertFalse(chunk['history_write'])
        self.bad(self.call('media.frame.read',params|dict(result_hash='wrong'),self.owner),'PERMISSION_DENIED')
        delivery=self.delivery(lease,result);self.confirm_delivery(delivery)
        payload=self.good(self.call('media.delivery.consume',self.context(delivery),self.owner))
        self.assertEqual(payload['frame']['result_hash'],result['hash']);self.assertIsNone(payload['text']);self.assertFalse(payload['history_write'])
        self.assertNotIn(PNG,self.service.store.directory.joinpath('memory.db').read_bytes())

    def test_window_replace_same_handle_cannot_read_or_deliver(self):
        lease=self.start('window');result=self.result(lease,kind='frame')
        delivery=self.delivery(lease,result);self.confirm_delivery(delivery)
        self.window=dict(WINDOW,pid=999)
        self.bad(self.call('media.delivery.consume',self.context(delivery),self.owner),'MEDIA_LEASE_REVOKED')
        self.assertIn(lease['lease_id'],self.runtime.stopped)
        self.assertEqual(self.service.media.state['results'],{})

    def test_context_epoch_model_and_role_never_refresh_old_delivery(self):
        lease=self.start();result=self.result(lease);delivery=self.delivery(lease,result);self.confirm_delivery(delivery)
        self.bad(self.call('media.delivery.consume',self.context(delivery,context_ref='new-context'),self.owner),'PERMISSION_DENIED')
        self.good(self.ingest(self.pet,'epoch-change','synthetic new memory'))
        self.bad(self.call('media.delivery.consume',self.context(delivery),self.owner),'MEDIA_DELIVERY_STALE')
        self.bad(self.call('media.delivery.prepare',dict(lease_id=lease['lease_id'],result_id=result['result_id'],result_hash=result['hash'],host_request_id='host-fixture',turn_id='turn-fixture',context_ref='new-context',expected_memory_epoch=self.epoch()),self.owner),'MEDIA_RESULT_USED')
        self.assertNotIn(lease['lease_id'],self.runtime.stopped)  # Memory update does not close the microphone lease.

    def test_model_selection_change_closes_not_fallback(self):
        lease=self.start();result=self.result(lease);delivery=self.delivery(lease,result);self.confirm_delivery(delivery)
        changed=dict(MODEL,endpoint_identity='cd'*32)
        self.bad(self.call('media.delivery.consume',self.context(delivery,model_selection=changed),self.owner),'MEDIA_MODEL_CHANGED')
        self.assertEqual(self.service.media.state['leases'][lease['lease_id']]['state'],'revoked');self.assertEqual(self.service.media.state['results'],{})
        self.assertIn(lease['lease_id'],self.runtime.stopped)

    def test_handsfree_new_turn_cancels_old_text_and_speech(self):
        lease=self.start('handsfree');first=self.result(lease)
        delivery=self.delivery(lease,first)
        self.assertEqual(delivery['state'],'authorized')
        self.good(self.call('media.delivery.consume',self.context(delivery),self.owner))
        self.good(self.call('media.speech.start',self.context(delivery)|dict(lease_id=lease['lease_id'],text='synthetic reply'),self.owner))
        self.assertEqual(self.runtime.commands[-1][1]['type'],'speak')
        self.bad(self.call('media.speech.start',self.context(delivery)|dict(lease_id=lease['lease_id'],text='synthetic reply'),self.owner),'MEDIA_SPEECH_USED')
        self.runtime.events.emit(lease['lease_id'],dict(type='wake',generation_id=str(uuid4())))
        self.bad(self.call('media.delivery.validate',self.context(delivery),self.owner),'MEDIA_DELIVERY_STALE')
        self.assertEqual(self.service.media.state['results'],{})

    def test_single_output_owner_and_external_preference_never_fallback(self):
        lease=self.start('output')
        other=self.prepare('output')
        self.bad(self.call('media.lease.confirm',dict(lease_id=other['lease_id'],expected_revision=1,confirmation_digest=other['confirmation_digest']),self.owner),'MEDIA_OUTPUT_BUSY')
        status=self.good(self.call('media.status',{},self.owner));self.assertEqual(status['output_owner'],lease['lease_id']);self.assertTrue(status['legacy_playback_suppressed'])
        self.good(self.call('media.configure',dict(enabled=True,output_provider='external'),self.owner))
        self.bad(self.call('media.lease.prepare',dict(subject_binding=self.pet,mode='handsfree',model_selection=MODEL,**{key:self.refs[key] for key in ('input_ref','output_ref','voice_ref')}),self.owner),'MEDIA_OUTPUT_PROVIDER')

    def test_stop_lock_expiry_and_restart_discard_previews_and_late_results(self):
        lease=self.start();result=self.result(lease)
        delivery=self.delivery(lease,result);self.confirm_delivery(delivery)
        self.lock='locked';self.service.tools.next_lock_check=0
        self.good(self.call('media.status',{},self.owner))
        self.assertEqual(self.service.media.state['results'],{})
        self.runtime.events.emit(lease['lease_id'],dict(type='asr.final',generation_id=str(uuid4()),text='LATE-SECRET'))
        self.lock='unlocked';self.service.tools.next_lock_check=0
        self.good(self.call('media.status',{},self.owner))
        self.assertEqual(self.service.media.state['results'],{})
        self.bad(self.call('media.lease.stop',dict(lease_id=lease['lease_id'],discard=False),self.owner),'MEDIA_LEASE_STALE')
        self.service.close();self.assertTrue(self.runtime.closed)
        self.service=fixtures.CapabilityService(self.directory,clock=lambda:self.now)
        self.activate('a');self.owner=self.bind('owner:local',owner=True,management=True)
        status=self.good(self.call('media.status',{},self.owner));self.assertEqual(status['leases'],[]);self.assertIsNone(status['output_owner'])

    def test_deadline_bounds_and_image_capability_are_explicit(self):
        self.bad(self.call('media.lease.prepare',dict(subject_binding=self.pet,mode='ptt',model_selection=MODEL,input_ref=self.refs['input_ref'],duration_seconds=31),self.owner),'INVALID_REQUEST')
        self.bad(self.call('media.lease.prepare',dict(subject_binding=self.pet,mode='window',model_selection=dict(MODEL,image_capable=False),window_ref=self.refs['window_ref']),self.owner),'MEDIA_IMAGE_UNSUPPORTED')
        lease=self.start();self.now+=31
        self.good(self.call('media.status',{},self.owner));self.assertIn(lease['lease_id'],self.runtime.stopped)
        self.assertEqual(self.good(self.call('media.lease.status',dict(lease_id=lease['lease_id']),self.owner))['state'],'revoked')

    def test_device_fingerprint_not_index_and_aec_no_fallback(self):
        device=dict(id=2,_endpoint_id='synthetic-A',_endpoint_active=True,name='Same visible name',hostapi_name='WASAPI',max_input_channels=1,max_output_channels=0,default_samplerate=16000)
        binding=DeviceBinding(2,'input',fingerprint(device));binding.verify([device])
        with self.assertRaises(ValueError):binding.verify([dict(device,_endpoint_id='synthetic-B')])

    def test_queues_and_commit_failure_close_before_raw_result_can_escape(self):
        lease=self.start();result=self.result(lease)
        delivery=self.delivery(lease,result);self.confirm_delivery(delivery)
        from sqlcipher3 import dbapi2
        self.service.db.set_authorizer(lambda op,a,b,c,d:dbapi2.SQLITE_DENY if op==dbapi2.SQLITE_TRANSACTION and a=='COMMIT' else dbapi2.SQLITE_OK)
        try:self.bad(self.call('media.delivery.consume',self.context(delivery),self.owner),'SERVICE_UNAVAILABLE')
        finally:self.service.db.set_authorizer(None)
        self.assertTrue(self.service.media.fault);self.assertEqual(self.service.media.state['results'],{});self.assertIn(lease['lease_id'],self.runtime.stopped)
        self.bad(self.call('media.delivery.consume',self.context(delivery),self.owner),'MEDIA_STORAGE_FAULT')

    def test_events_overflow_is_visible_and_does_not_replay(self):
        lease=self.start()
        for index in range(64):self.runtime.events.emit(lease['lease_id'],dict(type='heartbeat',sequence=index))
        with self.assertRaises(queue.Full):self.runtime.events.emit(lease['lease_id'],dict(type='heartbeat'))
        self.runtime.overflow.set()
        status=self.good(self.call('media.status',{},self.owner));self.assertEqual(status['code'],'MEDIA_QUEUE_OVERFLOW');self.assertTrue(status['hint'])

    def test_emergency_and_retire_cannot_use_ptt_finish_to_recover_old_preview(self):
        lease=self.start();self.result(lease)
        self.good(self.call('tool.emergency.stop',{},self.owner))
        self.assertIn(lease['lease_id'],self.runtime.stopped)
        self.bad(self.call('media.lease.stop',dict(lease_id=lease['lease_id'],discard=False),self.owner),'TOOL_STOPPED')
        self.assertEqual(self.service.media.state['results'],{})
        self.good(self.call('tool.emergency.reset',{},self.owner))
        self.bad(self.call('media.lease.start',dict(lease_id=lease['lease_id']),self.owner),'MEDIA_LEASE_STALE')
        self.good(self.call('lifecycle.retire'))
        self.activate('a');self.owner=self.bind('owner:local',owner=True,management=True)
        self.assertFalse(any(item['state'] in ('confirmed','starting','running','preview') for item in self.good(self.call('media.status',{},self.owner))['leases']))

    def test_monotonic_expiry_and_wall_clock_rollback_do_not_renew(self):
        lease=self.start()
        self.service.media.state['leases'][lease['lease_id']]['deadline']=time.monotonic()-1
        self.now-=10000
        self.good(self.call('media.status',{},self.owner))
        self.assertIn(lease['lease_id'],self.runtime.stopped)

    def test_visibility_pulse_never_renews_permission_or_revives_expired_lease(self):
        prepared=self.prepare()
        self.confirm(prepared)
        self.bad(self.call('media.lease.pulse',dict(lease_id=prepared['lease_id']),self.owner),'INVALID_STATE')
        self.good(self.call('media.lease.start',dict(lease_id=prepared['lease_id']),self.owner))
        before=self.service.media.state['leases'][prepared['lease_id']].copy()
        pulsed=self.good(self.call('media.lease.pulse',dict(lease_id=prepared['lease_id']),self.owner))
        after=self.service.media.state['leases'][prepared['lease_id']]
        self.assertEqual(before['expires_at'],after['expires_at']);self.assertEqual(before['deadline'],after['deadline'])
        self.assertEqual(before['model_selection'],after['model_selection']);self.assertEqual(before['policy_generation'],after['policy_generation'])
        self.assertLessEqual(after['visibility_deadline'],time.monotonic()+3)
        self.assertEqual(pulsed['expires_at'],prepared['expires_at'])
        self.result(prepared)
        self.service.media.state['leases'][prepared['lease_id']]['visibility_deadline']=time.monotonic()-1
        self.good(self.call('media.status',{},self.owner))
        terminal=self.good(self.call('media.lease.status',dict(lease_id=prepared['lease_id']),self.owner))
        self.assertEqual(terminal['code'],'MEDIA_VISIBILITY_LOST');self.assertEqual(terminal['state'],'revoked')
        self.assertEqual(self.service.media.state['results'],{})
        self.bad(self.call('media.lease.pulse',dict(lease_id=prepared['lease_id']),self.owner),'MEDIA_LEASE_REVOKED')
        self.assertIn(prepared['lease_id'],self.runtime.stopped)

    def test_original_speech_loop_barge_in_and_late_tts_completion(self):
        from types import SimpleNamespace
        from media_native.speech_loop import SpeechLoop
        from media_native.reply_speech import ReplySpeechBuffer
        settings=SimpleNamespace(max_turns=40,voice_name='fixture',voice_rate=0)
        events=[];loop=SpeechLoop(settings,queue.Queue(),events.append,threading.Event())
        class Backend:
            def __init__(self):self.pending=bytearray(b'synthetic old PCM')
            def cancel_playback(self,*args):self.pending.clear()
            def check_health(self):pass
        loop.backend=Backend();loop.engine=SimpleNamespace(new_utterance=lambda:None,accept=lambda pcm:None)
        loop.vad=SimpleNamespace(reset=lambda:None)
        old=uuid4();loop.generation=old;loop.state='speaking';loop.source=ReplySpeechBuffer(old)
        source=loop.source;source.append('synthetic old reply')
        loop.playing_source=source
        loop.begin_utterance(barge=True)
        self.assertTrue(source.cancelled.is_set());self.assertEqual(loop.backend.pending,b'');self.assertNotEqual(loop.generation,old)
        loop.play_result.put((source,False));loop.collect_playback()
        self.assertFalse(any(e.type=='reply.finished' and e.generation_id==old for e in events))
        self.assertTrue(any(e.type=='interrupted' for e in events))

    def speaking(self,mode='ptt'):
        output=self.start('output') if mode=='ptt' else None
        source=self.start(mode);result=self.result(source);delivery=self.delivery(source,result)
        if mode=='ptt':self.confirm_delivery(delivery)
        self.good(self.call('media.delivery.consume',self.context(delivery),self.owner))
        output=output or source
        self.good(self.call('media.speech.start',self.context(delivery)|dict(lease_id=output['lease_id'],text='Synthetic reply'),self.owner))
        return source,output,delivery

    def test_speech_dependencies_revoke_both_separate_and_same_output(self):
        for mode,reason in [('ptt','revoke'),('ptt','epoch'),('ptt','deadline'),('ptt','wall'),('ptt','source-pulse'),('handsfree','turn'),('handsfree','epoch'),('handsfree','deadline')]:
            with self.subTest(mode=mode,reason=reason):
                source,output,delivery=self.speaking(mode)
                before=len(self.runtime.commands)
                try:
                    if reason=='revoke':self.good(self.call('media.lease.revoke',dict(lease_id=source['lease_id']),self.owner))
                    elif reason=='epoch':self.good(self.ingest(self.pet,'change-'+mode+reason,'Synthetic epoch change'))
                    elif reason=='deadline':self.service.media.state['deliveries'][delivery['delivery_id']]['deadline']=time.monotonic()-1
                    elif reason=='wall':self.service.media.state['deliveries'][delivery['delivery_id']]['expires_at']=self.now*1000
                    elif reason=='source-pulse':self.service.media.state['leases'][source['lease_id']]['visibility_deadline']=time.monotonic()-1
                    else:self.runtime.events.emit(source['lease_id'],dict(type='wake',generation_id=str(uuid4())))
                    self.good(self.call('media.status',{},self.owner))
                    self.assertTrue(any(identifier==output['lease_id'] and cmd['type']=='speech.stop' for identifier,cmd in self.runtime.commands[before:]))
                finally:self.good(self.call('media.stop',{},self.owner))

    def test_commit_cannot_start_expired_devices(self):
        for mode,elapsed in [(mode,elapsed) for mode in ('ptt','window','handsfree') for elapsed in (1,2)]:
            with self.subTest(mode=mode,elapsed=elapsed):
                lease=self.prepare(mode,duration_seconds=1);self.confirm(lease)
                stage=self.service.media.stage;armed=[False]
                def staging(*args):armed[0]=True;return stage(*args)
                def trace(statement):
                    if statement=='COMMIT' and armed[0]:self.now+=elapsed;armed[0]=False
                self.service.db.set_trace_callback(trace)
                try:
                    with patch.object(self.service.media,'stage',side_effect=staging):
                        response=self.call('media.lease.start',dict(lease_id=lease['lease_id']),self.owner)
                finally:self.service.db.set_trace_callback(None)
                self.assertNotIn(lease['lease_id'],self.runtime.jobs)
                self.bad(response,'MEDIA_LEASE_STALE')

    def test_window_guard_elapsed_time_is_rechecked(self):
        lease=self.prepare('window',duration_seconds=1);self.confirm(lease)
        count=[0]
        def slow_guard(target):count[0]+=1;self.now+=2
        with patch.object(self.service.media,'window_guard',side_effect=slow_guard):
            self.bad(self.call('media.lease.start',dict(lease_id=lease['lease_id']),self.owner),'MEDIA_LEASE_STALE')
        self.assertNotIn(lease['lease_id'],self.runtime.jobs)

    def test_actual_output_late_sapi_after_source_revoke_writes_no_pcm(self):
        from types import SimpleNamespace
        from media_worker import output
        output_lease=self.start('output');source=self.start();result=self.result(source)
        delivery=self.delivery(source,result);self.confirm_delivery(delivery)
        self.good(self.call('media.delivery.consume',self.context(delivery),self.owner))
        commands=queue.Queue();stopped=threading.Event();entered=threading.Event();release=threading.Event();done=threading.Event();writes=[];tokens=[]
        class Sink:
            def __init__(self,*args):pass
            def pin(self,*args):pass
            def stop(self):pass
            def finish(self,**kwargs):pass
            def write_authorized(self,chunk,*,cancelled,authorize):
                with authorize():writes.append(chunk.pcm)
                return True
        class Synth:
            def __init__(self,**kwargs):pass
            def _synthesize(self,*args,**kwargs):tokens.append(kwargs['cancel_event']);entered.set();release.wait(3);done.set();return b'\1\0'*160
        original=self.runtime.command
        def forward(identifier,cmd):
            original(identifier,cmd)
            if identifier==output_lease['lease_id']:commands.put(cmd)
        monitor=SimpleNamespace(check=lambda:None,close=lambda:None)
        with patch('media_native.audio_endpoints.EndpointAccess'),patch('media_native.audio_endpoints.EndpointLease',return_value=monitor),patch('media_native.tts.WasapiOutput',Sink),patch('media_native.tts.SapiTtsAdapter',Synth),patch('media_worker.time.time',side_effect=lambda:self.now),patch.object(self.runtime,'command',side_effect=forward):
            worker=threading.Thread(target=output,args=(self.runtime.jobs[output_lease['lease_id']],commands,lambda event:None,stopped),daemon=True);worker.start()
            try:
                self.good(self.call('media.speech.start',self.context(delivery)|dict(lease_id=output_lease['lease_id'],text='Synthetic reply.'),self.owner))
                self.assertTrue(entered.wait(2))
                self.good(self.call('media.lease.revoke',dict(lease_id=source['lease_id']),self.owner))
                self.assertTrue(tokens[0].wait(2));release.set();self.assertTrue(done.wait(2));time.sleep(.04)
                self.assertEqual(writes,[])
            finally:release.set();stopped.set();worker.join(2)

    def test_sent_receipt_does_not_cancel_valid_speech_but_original_ttl_still_applies(self):
        source,output,delivery=self.speaking()
        before=len(self.runtime.commands)
        self.good(self.call('media.delivery.finalize',dict(delivery_id=delivery['delivery_id'],outcome='sent'),self.owner))
        self.good(self.call('media.status',{},self.owner))
        self.assertEqual(len(self.runtime.commands),before)
        self.assertEqual(self.service.media.state['leases'][output['lease_id']]['speech_delivery'],delivery['delivery_id'])
        self.service.media.state['deliveries'][delivery['delivery_id']]['deadline']=time.monotonic()-1
        self.good(self.call('media.status',{},self.owner))
        self.assertEqual(self.runtime.commands[-1][1]['type'],'speech.stop')

    def test_preview_pulse_after_window_worker_exit_keeps_only_same_frame(self):
        source=self.start('window');result=self.result(source,kind='frame')
        self.runtime.jobs.pop(source['lease_id'],None)
        original=self.runtime.command
        def require_live(identifier,cmd):
            if identifier not in self.runtime.jobs:raise RuntimeError('MEDIA_WORKER_STOPPED')
            original(identifier,cmd)
        with patch.object(self.runtime,'command',side_effect=require_live):
            self.good(self.call('media.lease.pulse',dict(lease_id=source['lease_id']),self.owner))
            frame=self.good(self.call('media.frame.read',dict(lease_id=source['lease_id'],result_id=result['result_id'],result_hash=result['hash']),self.owner))
            self.assertEqual(base64.b64decode(frame['base64']),PNG);self.assertIsNone(self.service.media.fault)

    def test_speech_postcommit_expiry_cannot_queue_a_new_sapi_attempt(self):
        output=self.start('output');source=self.start();result=self.result(source)
        delivery=self.delivery(source,result);self.confirm_delivery(delivery)
        self.good(self.call('media.delivery.consume',self.context(delivery),self.owner))
        stage=self.service.media.stage
        def staging(*args):
            stage(*args);self.service.after_commit.insert(0,lambda:setattr(self,'now',self.now+31))
        before=len(self.runtime.commands)
        with patch.object(self.service.media,'stage',side_effect=staging):
            response=self.call('media.speech.start',self.context(delivery)|dict(lease_id=output['lease_id'],text='Synthetic reply.'),self.owner)
        self.assertFalse(response['ok']);self.assertTrue(response['hint'])
        self.assertFalse(any(cmd['type']=='speak' for _,cmd in self.runtime.commands[before:]))

    def test_handsfree_actual_late_sapi_and_queued_pcm_do_not_survive_new_turn(self):
        from types import SimpleNamespace
        from uuid import UUID
        from media_native.wire import WorkerPermit
        from media_native.speech_loop import SpeechLoop
        from media_native.reply_speech import ReplySpeechBuffer
        source,output,delivery=self.speaking('handsfree')
        speak=self.runtime.commands[-1][1];permit=WorkerPermit(self.runtime.jobs[source['lease_id']],threading.Event())
        entered=threading.Event();release=threading.Event();writes=[]
        class Synth:
            def __init__(self,**kwargs):pass
            def _synthesize(self,*args,**kwargs):entered.set();release.wait(3);return b'\1\0'*160
        class Backend:
            pending=bytearray(b'previous queued PCM')
            def enqueue(self,chunk,**kwargs):writes.append(chunk.pcm);return True
            def finish_playback(self,*args,**kwargs):pass
            def cancel_playback(self,*args):self.pending.clear()
        loop=SpeechLoop(SimpleNamespace(voice_name='fixture',voice_id='fixture',voice_rate=0,authorize=permit.authorize,speech_authorize=lambda gen:permit.authorize(str(gen))),queue.Queue(),lambda event:None,threading.Event(),adapter_factory=Synth)
        loop.backend=Backend();buffer=ReplySpeechBuffer(UUID(speak['generation_id']));buffer.append('Synthetic reply.');buffer.finish()
        original=self.runtime.command
        def forward(identifier,cmd):
            original(identifier,cmd)
            if identifier==source['lease_id']:permit.control(cmd)
        with patch('media_worker.time.time',side_effect=lambda:self.now),patch.object(self.runtime,'command',side_effect=forward):
            permit.control(speak)
            player=threading.Thread(target=loop._play,args=(buffer,),daemon=True);player.start()
            try:
                self.assertTrue(entered.wait(2))
                self.runtime.events.emit(source['lease_id'],dict(type='wake',generation_id=str(uuid4())))
                self.good(self.call('media.status',{},self.owner))
                release.set();player.join(2)
                self.assertFalse(player.is_alive());self.assertEqual(writes,[]);self.assertEqual(loop.backend.pending,b'')
            finally:release.set();player.join(2)


class WorkerBoundaries(unittest.TestCase):
    def settings(self,**extra):
        return dict(mode='window',expires_at=time.time()*1000+60000,deadline=time.monotonic()+60,visibility_deadline=time.monotonic()+3,window=WINDOW.copy(),**extra)

    def test_slow_endpoint_pin_rechecks_before_native_open_and_start(self):
        from types import SimpleNamespace
        from media_native.wire import WorkerPermit
        from media_native.audio_duplex import WasapiDuplexBackend
        from media_native.tts import WasapiOutput,PcmChunk
        # Exercise actual adapters, replacing only the OS endpoints and stream.
        for mode in ('duplex','output'):
            for stage in ('pin','settings','prestart'):
                for boundary in ('expires_at','deadline','visibility_deadline'):
                    for delta in (0,1):
                        with self.subTest(mode=mode,stage=stage,boundary=boundary,delta=delta):
                            clock=[100.,200.];opened=[];started=[];closed=[]
                            settings=dict(expires_at=110000,deadline=210,visibility_deadline=210)
                            settings[boundary]=101000 if boundary=='expires_at' else 201
                            permit=WorkerPermit(settings,threading.Event())
                            def expire():clock[0 if boundary=='expires_at' else 1]=(101 if boundary=='expires_at' else 201)+delta
                            lease=SimpleNamespace(check=lambda:expire() if stage=='prestart' else None,
                                verify=lambda:None,close=lambda:None)
                            stream=SimpleNamespace(start=lambda:started.append(True))
                            def native(**kwargs):opened.append(True);return stream
                            def extra(**kwargs):
                                if stage=='settings':expire()
                            sd=SimpleNamespace(RawStream=native,RawOutputStream=native,WasapiSettings=extra)
                            if mode=='duplex':
                                adapter=WasapiDuplexBackend(sd=sd,clock=lambda:clock[1]);adapter.devices=lambda:[]
                                def pin(*args):
                                    if stage=='pin':expire()
                                    return lease
                                operation=lambda:adapter.start(DeviceBinding(1,'input','11'*32),DeviceBinding(2,'output','22'*32),authorize=permit.authorize)
                            else:
                                adapter=WasapiOutput(sd=sd)
                                def pin(*args):
                                    adapter._lease=lease
                                    if stage=='pin':expire()
                                    # Actual output pin includes endpoint.check().
                                    lease.check()
                                adapter.pin=pin
                                operation=lambda:adapter._open_locked(PcmChunk(uuid4(),0,b'\1\0'*160,sample_rate=16000),permit.authorize)
                            adapter.stop=lambda:closed.append(True)
                            with patch('media_native.wire.time.time',side_effect=lambda:clock[0]),patch('media_native.wire.time.monotonic',side_effect=lambda:clock[1]),patch.object(DeviceBinding,'verify'),patch('media_native.audio_duplex.EndpointLease',side_effect=pin):
                                with self.assertRaises(PermissionError):operation()
                            self.assertEqual(opened,[True] if mode=='duplex' and stage=='prestart' else [])
                            self.assertEqual(started,[])
                            self.assertEqual(closed,[True])

    def serve(self,settings):
        import io
        from media_worker import serve
        finish=threading.Event()
        class Reader:
            first=True
            def readline(self,*args):
                if self.first:self.first=False;return (json.dumps(settings)+'\n').encode()
                finish.wait(2);return b''
        try:serve(Reader(),io.BytesIO())
        finally:finish.set()

    def test_expired_worker_never_enters_native_capture_or_audio(self):
        for mode in ('window','ptt','handsfree','output'):
            for boundary in ('expires_at','deadline','visibility_deadline'):
                for delta in (0,-1):
                    with self.subTest(mode=mode,boundary=boundary,delta=delta):
                        settings=self.settings();settings['mode']=mode
                        with patch('media_worker.time.time',return_value=100),patch('media_worker.time.monotonic',return_value=200):
                            settings.update(expires_at=101000,deadline=201,visibility_deadline=201)
                            settings[boundary]=(100000 if boundary=='expires_at' else 200)+delta
                            with patch('media_native.wgc_worker.capture') as capture,patch('media_worker.ptt') as ptt,patch('media_worker.output') as output,patch('media_native.speech_loop.SpeechLoop') as loop:
                                self.serve(settings)
                                for native in (capture,ptt,output,loop):native.assert_not_called()

    def test_native_window_verify_gate_rechecks_before_wgc_constructor(self):
        from media_native.wgc_worker import capture
        from media_native.window_targets import WindowTarget
        from media_native.wire import WorkerPermit
        settings=self.settings();clock=[time.time()]
        with patch('media_native.wire.time.time',side_effect=lambda:clock[0]):
            permit=WorkerPermit(settings,threading.Event())
            def delayed(target):clock[0]+=61
            with patch('media_native.window_targets.verify_window',side_effect=delayed),patch('windows_capture.WindowsCapture') as wgc:
                with self.assertRaises(PermissionError):capture(WindowTarget(**WINDOW),authorize=permit.authorize)
                wgc.assert_not_called()

    def test_model_initialization_expiry_never_opens_ptt_or_handsfree(self):
        from types import SimpleNamespace
        from media_worker import ptt
        from media_native.wire import WorkerPermit,command
        from media_native.speech_loop import SpeechLoop
        for mode in ('ptt','handsfree'):
            with self.subTest(mode=mode):
                settings=self.settings();settings.update(mode=mode,input=dict(index=1,kind='input',fingerprint='11'*32))
                clock=[time.time()]
                resource=SimpleNamespace(close=lambda:None)
                def engine(*args):clock[0]+=61;return resource
                with patch('media_native.wire.time.time',side_effect=lambda:clock[0]):
                    permit=WorkerPermit(settings,threading.Event())
                    if mode=='ptt':
                        with patch('media_assets.verify'),patch('media_assets.profiles',return_value=[None]),patch('media_native.asr.SherpaOnlineEngine.from_profile',side_effect=engine),patch('media_native.audio_frontend.WasapiBackend') as backend,patch('media_native.audio_processing.WebRtcAudioProcessor',return_value=resource):
                            with self.assertRaises(PermissionError):ptt(settings,queue.Queue(),lambda event:None,permit.stopped,permit)
                            backend.return_value.start.assert_not_called()
                    else:
                        commands=queue.Queue();commands.put(command(dict(type='start')))
                        config=SimpleNamespace(profiles=lambda:(None,None,None),noise_suppression=True,capture=SimpleNamespace(binding=lambda:None),render=SimpleNamespace(binding=lambda:None),authorize=permit.authorize)
                        with patch('media_native.speech_loop.WasapiDuplexBackend') as backend:
                            loop=SpeechLoop(config,commands,lambda event:None,permit.stopped,backend_factory=backend,engine_factory=engine,wake_factory=lambda p:resource,vad_factory=lambda p:resource,processor_factory=lambda **kwargs:resource)
                            loop.run();backend.return_value.start.assert_not_called()

    def test_queued_pcm_callbacks_silence_expired_speech_without_new_permission(self):
        from types import SimpleNamespace
        from media_native.wire import WorkerPermit
        from media_native.audio_duplex import WasapiDuplexBackend
        from media_native.tts import WasapiOutput
        class Abort(Exception):pass
        sd=SimpleNamespace(CallbackAbort=Abort,CallbackStop=Abort)
        lease=SimpleNamespace(check=lambda:None)
        for reason in ('cancel','deadline','expires_at','source_visibility_deadline'):
            with self.subTest(reason=reason):
                generation=str(uuid4());settings=self.settings();permit=WorkerPermit(settings,threading.Event())
                permit.control(dict(type='speak',generation_id=generation,expires_at=settings['expires_at'],deadline=settings['deadline'],source_visibility_deadline=settings['visibility_deadline']))
                if reason=='cancel':permit.control(dict(type='speech.stop',generation_id=generation))
                else:permit.speeches[generation][reason]=time.time()*1000 if reason=='expires_at' else time.monotonic()
                output=WasapiOutput(sd=sd);output._frame_bytes=320;output._frame_samples=160;output._silence=b'\0'*320;output._pending.extend(b'\1\0'*160);output._authorize=lambda:permit.authorize(generation)
                frame=bytearray(320)
                with self.assertRaises(Abort):output._render(frame,160,None,False,lease=lease)
                self.assertEqual(frame,b'\0'*320);self.assertEqual(output._pending,b'')
                duplex=WasapiDuplexBackend(sd=sd);duplex._stopped.clear();duplex._pending.extend(b'\1\0'*160);duplex._playback_authorize=lambda:permit.authorize(generation)
                frame=bytearray(320)
                duplex._callback(b'\0'*320,frame,160,SimpleNamespace(inputBufferAdcTime=1,outputBufferDacTime=1.01),False,lease=lease)
                self.assertEqual(frame,b'\0'*320);self.assertEqual(duplex._pending,b'')

    def test_worker_pulse_updates_visibility_only_and_late_pulse_cannot_rearm(self):
        from media_native.wire import WorkerPermit
        settings=self.settings();settings.update(expires_at=110000,deadline=210,visibility_deadline=203)
        stopped=threading.Event()
        with patch('media_native.wire.time.time',return_value=100),patch('media_native.wire.time.monotonic',return_value=202):
            permit=WorkerPermit(settings,stopped);original=permit.data.copy()
            permit.control(dict(type='pulse',visibility_deadline=205))
            self.assertEqual(permit.data['expires_at'],original['expires_at']);self.assertEqual(permit.data['deadline'],original['deadline'])
            self.assertEqual(permit.data['visibility_deadline'],205)
            generation=str(uuid4())
            permit.control(dict(type='speak',generation_id=generation,expires_at=109000,deadline=209,source_visibility_deadline=203))
            permit.control(dict(type='speech.pulse',generation_id=generation,source_visibility_deadline=204))
            self.assertEqual(permit.speeches[generation]['expires_at'],109000);self.assertEqual(permit.speeches[generation]['deadline'],209)
        with patch('media_native.wire.time.time',return_value=100),patch('media_native.wire.time.monotonic',return_value=204):
            with self.assertRaises(PermissionError):permit.control(dict(type='speech.pulse',generation_id=generation,source_visibility_deadline=208))
            self.assertTrue(permit.cancelled(generation).is_set())
        with patch('media_native.wire.time.time',return_value=100),patch('media_native.wire.time.monotonic',return_value=205):
            with self.assertRaises(PermissionError):permit.control(dict(type='pulse',visibility_deadline=209))


class Containment(unittest.TestCase):
    def test_real_windows_job_and_bounded_pipes_without_devices(self):
        runtime=MediaRuntime();original=subprocess.Popen;children=[]
        code="""import json,os,sys
settings=json.loads(sys.stdin.readline())
print(json.dumps({'type':'ready','pid':os.getpid(),'key_absent':'SURFCORE_LOCAL_KEY' not in os.environ}),flush=True)
for line in sys.stdin: pass
"""
        def spawn(command,**kwargs):
            self.assertNotIn('SURFCORE_LOCAL_KEY',kwargs['env']);self.assertNotIn('DSH_HOME',kwargs['env'])
            child=original([sys.executable,'-u','-c',code],**kwargs);children.append(child);return child
        try:
            with patch('media_runtime.subprocess.Popen',side_effect=spawn):
                runtime.start('fixture',dict(mode='catalog'))
                deadline=time.monotonic()+4
                while runtime.events.empty() and time.monotonic()<deadline:time.sleep(.01)
                batch=runtime.events.snapshot();self.assertTrue(batch)
                self.assertEqual(batch[0][1]['type'],'ready');self.assertTrue(batch[0][1]['key_absent'])
                runtime.events.acknowledge(batch)
            started=time.monotonic();runtime.close();self.assertLess(time.monotonic()-started,.5)
            deadline=time.monotonic()+4
            while not runtime.jobs['fixture']['finished'].is_set() and time.monotonic()<deadline:time.sleep(.01)
            self.assertTrue(runtime.jobs['fixture']['finished'].is_set());self.assertIsNotNone(children[0].poll())
            self.assertTrue(children[0].stdin.closed);self.assertTrue(children[0].stdout.closed)
        finally:runtime.close()

    def test_hard_parent_exit_kills_only_its_owned_fixture_worker(self):
        code="""import json,sys,time
sys.path.insert(0,sys.argv[1])
import media_runtime
original=media_runtime.subprocess.Popen
child_code='import json,os,sys,time;sys.stdin.readline();print(json.dumps({"type":"ready","pid":os.getpid()}),flush=True);time.sleep(60)'
def spawn(command,**kwargs):return original([sys.executable,'-u','-c',child_code],**kwargs)
media_runtime.subprocess.Popen=spawn
runtime=media_runtime.MediaRuntime();runtime.start('fixture',{'mode':'catalog'})
deadline=time.monotonic()+5
while runtime.events.empty() and time.monotonic()<deadline:time.sleep(.01)
print(json.dumps(runtime.events.snapshot()[0][1]),flush=True)
time.sleep(60)
"""
        parent=subprocess.Popen([sys.executable,'-u','-c',code,str(ROOT/'services/local-capabilities')],stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8')
        output=queue.Queue();threading.Thread(target=lambda:output.put(parent.stdout.readline()),daemon=True).start()
        handle=None
        try:
            event=json.loads(output.get(timeout=7));self.assertEqual(event['type'],'ready')
            import win32api,win32event
            handle=win32api.OpenProcess(0x100000|0x1000,False,event['pid'])
            parent.kill();parent.wait(timeout=3)  # This helper and its child are created only by this test.
            self.assertEqual(win32event.WaitForSingleObject(handle,4000),0)
        finally:
            if handle:handle.Close()
            if parent.poll() is None:parent.kill();parent.wait(timeout=3)
            parent.stdout.close();parent.stderr.close()


class OfflineModels(unittest.TestCase):
    def test_real_public_wav_asr_vad_kws_and_native_aec_no_devices(self):
        from media_assets import verify,profiles,ROOT as ASSET_ROOT,MANIFEST
        from media_native.asr import SherpaOnlineEngine
        from media_native.speech_detectors import SherpaWakeDetector,SileroVadDetector
        from media_native.audio_processing import WebRtcAudioProcessor
        import wave
        verify();asr,wake,vad=profiles()
        engine=SherpaOnlineEngine.from_profile(asr);detector=SileroVadDetector.from_profile(vad)
        keyword=SherpaWakeDetector.from_profile(wake);processor=WebRtcAudioProcessor(echo_cancellation=True)
        fixture=ASSET_ROOT/'models'/MANIFEST['asr']/'test_wavs/0.wav'
        declared=next(item for item in MANIFEST['files'] if item['path']==fixture.relative_to(ASSET_ROOT).as_posix())
        with fixture.open('rb') as stream:self.assertEqual(hashlib.file_digest(stream,'sha256').hexdigest(),declared['sha256'])
        with wave.open(str(fixture),'rb') as audio:
            self.assertEqual(audio.getframerate(),16000);self.assertEqual(audio.getnchannels(),1);data=audio.readframes(audio.getnframes())
        text=[];speech=False
        try:
            for offset in range(0,len(data),1024):
                pcm=data[offset:offset+1024]
                hypothesis=engine.accept(pcm)
                if hypothesis and hypothesis.final:text.append(hypothesis.text)
                speech=speech or detector.accept(pcm).active
            final=engine.finish()
            if final:text.append(final.text)
            self.assertTrue(''.join(text).strip());self.assertTrue(speech)
            self.assertIsInstance(keyword.accept(b'\0'*320),bool)
            self.assertEqual(len(processor.process(b'\0'*320,b'\0'*320)),320)
            print('MEDIA_OFFLINE_EVIDENCE '+json.dumps(dict(asr_text=''.join(text),vad_detected=speech,kws_loaded=True,native_aec_bytes=320,physical_devices=False)),flush=True)
        finally:detector.close();keyword.close();processor.close()


if __name__=='__main__':unittest.main(verbosity=2)
