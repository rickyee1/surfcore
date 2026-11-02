"""One media authority: volatile short leases, persistent preferences, no raw data DB."""
import base64
import copy
import hashlib
import json
import re
import struct
import time
import uuid
from storage import ServiceError
from tool_contracts import bounded,encode,fields,hashed
from media_runtime import MediaRuntime

LIVE=('confirmed','starting','running','finishing','preview')
MESSAGES={
    'MEDIA_DEPENDENCY_MISSING':('本机媒体依赖缺失。','安装独立环境 requirements-media.txt 后重试；不会改用远程服务。'),
    'MEDIA_MODEL_MISSING':('本地语音模型缺失。','恢复 media-models.json 声明的模型，不会自动下载。'),
    'MEDIA_MODEL_INVALID':('本地语音模型校验失败。','核对固定模型文件的 SHA256 后重新准备。'),
    'MEDIA_MODEL_UNAVAILABLE':('本地语音模型未能加载。','核对固定模型、CPU依赖和关键词表后重试。'),
    'MEDIA_AUDIO_UNAVAILABLE':('所选音频端点未能打开。','刷新设备列表并重新选择，检查设备权限；不会切到默认设备。'),
    'MEDIA_AUDIO_FAILED':('音频设备断开、替换或音频连续性丢失。','停止后刷新设备列表，重新选择并批准。'),
    'MEDIA_PLAYBACK_FAILED':('本地语音合成或播放失败。','检查所选 Windows 声音和输出设备；不会隐式切到 voxd。'),
    'MEDIA_WINDOW_CHANGED':('目标窗口已变化或不再允许捕获。','刷新窗口列表并重新选择；不会捕获整个桌面。'),
    'MEDIA_VISIBILITY_LOST':('控制页或原桌宠的可见心跳已丢失。','保持控制页可见，重新准备、批准并启动；旧预览已作废。'),
    'MEDIA_NO_SPEECH':('本次没有可发送的转写。','检查输入设备并重新按键录音，原始音频不保存。'),
}


def fail(code,message,hint='在本机设备页面核对选择和权限，重新准备；不要重放旧任务。'):
    raise ServiceError(code,message,hint)


def selection(value):
    fields(value,('provider','model','config_revision','endpoint_identity','adapter_id','adapter_revision','image_capable'))
    result={key:bounded(item) for key,item in value.items() if key!='image_capable'}
    if not re.fullmatch('[0-9a-f]{64}',result['endpoint_identity']) or type(value['image_capable']) is not bool:
        fail('INVALID_REQUEST','固定模型选择的端点身份或图像能力无效。')
    result['image_capable']=value['image_capable']
    return result


class MediaAuthority:
    def __init__(self,service):
        self.service,self.db=service,service.db
        self.runtime=MediaRuntime();self.fault=None;self.closed=False
        self.state=dict(catalogs={},leases={},results={},deliveries={},events=[],sequence=0,generations={})
        self.window_guard=self._window_guard
        self.db.executescript('CREATE TABLE IF NOT EXISTS media_config(character TEXT PRIMARY KEY,enabled INTEGER NOT NULL,provider TEXT NOT NULL); CREATE TABLE IF NOT EXISTS media_audit(id TEXT PRIMARY KEY,character TEXT NOT NULL,operation TEXT NOT NULL,digest TEXT NOT NULL,created REAL NOT NULL);')
        from media_delivery import MediaDelivery
        self.delivery=MediaDelivery(self)

    @staticmethod
    def _window_guard(target):
        from media_native.window_targets import WindowTarget,verify_window
        verify_window(WindowTarget(**target))

    def now(self):return self.service.clock()*1000

    def config(self,character):
        row=self.db.execute('SELECT * FROM media_config WHERE character=?',(character,)).fetchone()
        return dict(enabled=bool(row['enabled']),output_provider=row['provider']) if row else dict(enabled=False,output_provider='external')

    def guard(self,session,enabled=True):
        self.service.management(session)
        if self.fault:fail(self.fault,'媒体状态已闭锁。','停止本机能力、检查错误并重启能力服务；旧租约和待发送结果不会恢复。')
        self.service.tools.require_healthy()
        if self.service.tools.policy()['closed']:fail('TOOL_STOPPED','本机能力处于紧停闭锁。')
        if self.service.tools.lock_state!='unlocked':fail('SESSION_LOCKED','Windows 会话未确认解锁，设备已关闭。')
        if enabled and not self.config(session['character'])['enabled']:fail('MEDIA_DISABLED','媒体设备功能尚未开启。','在本机设备页显式开启，再选择具体设备与用途。')

    def subject(self,session,token):
        subject=self.service.bindings.get(bounded(token))
        if not subject or subject['character']!=session['character'] or subject['epoch']!=session['epoch'] or subject['platform']!='pet' or not subject['owner']:
            fail('PERMISSION_DENIED','媒体许可只允许当前本机主人的原桌宠会话。')
        return subject

    def current(self,session,state,identifier):
        self.guard(session)
        lease=state['leases'].get(bounded(identifier))
        if not lease or lease['character']!=session['character']:fail('PERMISSION_DENIED','媒体租约不可访问。')
        subject=self.subject(session,lease['subject_binding'])
        if (lease['epoch']!=session['epoch'] or lease['policy_generation']!=self.service.tools.policy()['generation'] or
            lease['generation']!=state['generations'].get(session['character'],1) or lease['expires_at']<=self.now() or lease['deadline']<=time.monotonic()):
            fail('MEDIA_LEASE_STALE','媒体租约的角色、权限或期限已失效。')
        if lease['state'] not in LIVE+('prepared',):fail('MEDIA_LEASE_REVOKED','媒体租约已经停止或撤销。')
        if lease['state'] in ('starting','running','finishing','preview') and lease.get('visibility_deadline',0)<=time.monotonic():
            fail('MEDIA_VISIBILITY_LOST','媒体控制页或原桌宠的可见心跳已过期。','保持控制页可见；重新打开页面后需重新批准和启动，旧预览已作废。')
        if lease['mode']=='window':
            try:self.window_guard(lease['window'])
            except Exception:fail('MEDIA_WINDOW_CHANGED','目标窗口已关闭、替换或不再允许捕获。','刷新窗口列表并重新选择；不会改为整个桌面。')
        # Native identity verification and DB/policy reads may consume the remaining TTL.
        if lease['expires_at']<=self.now() or lease['deadline']<=time.monotonic():fail('MEDIA_LEASE_STALE','媒体租约已到原签署期限。')
        if lease['state'] in ('starting','running','finishing','preview') and lease.get('visibility_deadline',0)<=time.monotonic():fail('MEDIA_VISIBILITY_LOST','媒体控制页的原可见期限已过。')
        return lease

    def cancel_speech(self,state,output,actions):
        if not output.get('speech_delivery'):return
        generation=output.pop('speech_generation',None)
        output.pop('speech_delivery',None)
        if output['state'] in LIVE:
            actions.insert(0,lambda identifier=output['lease_id'],generation=generation:self.runtime.command(identifier,dict(type='speech.stop',generation_id=generation)))

    def speech_current(self,session,state,output):
        item=state['deliveries'].get(output.get('speech_delivery'))
        if not item or item['state'] not in ('consumed','sent'):fail('MEDIA_DELIVERY_STALE','本次语音的来源交付已经失效。')
        self.delivery.checked(session,state,dict(delivery_id=item['delivery_id'],**{key:item[key] for key in ('subject_binding','host_request_id','turn_id','context_ref','model_selection')}))
        self.current(session,state,output['lease_id'])
        if output.get('speech_generation')!=item['source_turn']:fail('MEDIA_DELIVERY_STALE','本次语音不再属于原来源回合。')
        return item

    def sweep_speech(self,state,actions):
        for output in state['leases'].values():
            if not output.get('speech_delivery'):continue
            session=next((s for s in self.service.bindings.values() if s['character']==output['character'] and s['management']),None)
            try:
                if not session:raise ValueError()
                self.current(session,state,output['lease_id']);self.speech_current(session,state,output)
            except (ServiceError,ValueError):self.cancel_speech(state,output,actions)

    def post_current(self,session,identifier):
        try:lease=self.current(session,self.state,identifier)
        except ServiceError as failure:
            actions=[];self.revoke(self.state,identifier,actions,failure.code)
            self.sweep_speech(self.state,actions)
            for action in actions:action()
            raise
        return lease

    def start_worker(self,session,identifier):
        lease=self.post_current(session,identifier)
        payload={key:lease[key] for key in ('mode','expires_at','deadline','visibility_deadline','input','output','voice','window') if key in lease}
        self.runtime.start(identifier,payload)

    def speak_worker(self,session,identifier,text):
        try:
            output=self.post_current(session,identifier)
            item=self.speech_current(session,self.state,output)
        except ServiceError:
            actions=[];self.cancel_speech(self.state,self.state['leases'][identifier],actions)
            for action in actions:action()
            raise
        source=self.state['leases'][item['lease_id']]
        self.runtime.command(identifier,dict(type='speak',generation_id=item['source_turn'],text=text,
            expires_at=min(item['expires_at'],source['expires_at'],output['expires_at']),
            deadline=min(item['deadline'],source['deadline'],output['deadline']),
            source_lease_id=source['lease_id'],source_visibility_deadline=source['visibility_deadline']))

    def emit(self,state,character,kind,**values):
        state['sequence']+=1
        state['events'].append(dict(sequence=state['sequence'],character=character,type=kind,**values))
        state['events']=state['events'][-64:]

    def revoke(self,state,identifier,actions,code='MEDIA_REVOKED'):
        lease=state['leases'].get(identifier)
        if not lease:return
        lease.update(state='revoked',revision=lease['revision']+1,code=code)
        for result_id in list(state['results']):
            if state['results'][result_id]['lease_id']==identifier:del state['results'][result_id]
        for delivery in state['deliveries'].values():
            if delivery['lease_id']==identifier:delivery['state']='cancelled'
        # Raw transcript partials in history are also discarded on revocation.
        state['events']=[event for event in state['events'] if event.get('lease_id')!=identifier]
        message,hint=MESSAGES.get(code,('媒体回合已经停止。','核对原设备、权限和当前角色后重新准备；不要重放旧回合。'))
        self.emit(state,lease['character'],'revoked',lease_id=identifier,code=code,error=message,hint=hint)
        actions.append(lambda:self.runtime.stop(identifier))

    def publish(self,state,actions):
        if self.runtime.overflow.is_set():
            self.fail_closed('MEDIA_QUEUE_OVERFLOW');return
        self.state=state
        self.sweep_speech(state,actions)
        for action in actions:
            try:action()
            except ServiceError:raise
            except Exception:self.fail_closed('MEDIA_WORKER_FAILED');break

    def revoke_immediate(self,character,code):
        # Monotonic denial is not rolled back when a stale host selection is rejected.
        state=copy.deepcopy(self.state);actions=[]
        for identifier,lease in state['leases'].items():
            if lease['character']==character:self.revoke(state,identifier,actions,code)
        state['generations'][character]=state['generations'].get(character,1)+1
        self.publish(state,actions)

    def stage(self,state,actions,character,operation):
        self.db.execute('INSERT INTO media_audit VALUES(?,?,?,?,?)',(uuid.uuid4().hex,character,operation,hashed(dict(operation=operation,generation=state['generations'].get(character,1))),self.service.clock()))
        self.db.execute('DELETE FROM media_audit WHERE id IN (SELECT id FROM media_audit ORDER BY created DESC,rowid DESC LIMIT -1 OFFSET 128)')
        self.service.after_commit.append(lambda:self.publish(state,actions))

    def retire(self,character=None,code='LIFECYCLE_RETIRED'):
        state=copy.deepcopy(self.state);actions=[]
        for identifier,lease in state['leases'].items():
            if character is None or lease['character']==character:self.revoke(state,identifier,actions,code)
        for identifier,catalog in state['catalogs'].items():
            if catalog['state']=='running' and (character is None or catalog['character']==character):
                catalog['state']='cancelled';actions.append(lambda identifier=identifier:self.runtime.stop(identifier))
        if character:state['generations'][character]=state['generations'].get(character,1)+1
        self.service.after_commit.append(lambda:self.publish(state,actions))

    def fail_closed(self,code='MEDIA_STORAGE_FAULT'):
        self.fault=code
        self.runtime.stop_all()
        self.state['results'].clear();self.state['events'].clear()
        for lease in self.state['leases'].values():lease['state']='revoked'
        for delivery in self.state['deliveries'].values():delivery['state']='cancelled'

    def metadata(self,lease):
        keys=('lease_id','revision','state','mode','subject_binding','subject','expires_at','prepared_until','confirmation_digest','purposes','model_selection','code','turn_id','frames_remaining')
        result={key:lease.get(key) for key in keys}
        result['targets']={key:copy.deepcopy(lease[key]) for key in ('input','output','voice','window') if key in lease}
        result.update(worker_state=lease.get('worker_state'),voice_level=lease.get('voice_level',0),local_only=True)
        result['visibility_expires_at']=self.now()+max(0,lease.get('visibility_deadline',0)-time.monotonic())*1000 if lease.get('visibility_deadline') else None
        result['formats']=dict(capture='16000 Hz mono PCM16' if lease['mode'] in ('ptt','handsfree') else None,render='16000 Hz mono PCM16' if lease['mode']=='handsfree' else '24000 Hz mono PCM16' if lease['mode']=='output' else None,wasapi_shared_auto_convert=True)
        if lease.get('code'):
            message,hint=MESSAGES.get(lease['code'],('媒体采集或播放已停止。','核对原设备、窗口和模型后重新选择并确认；不要重放旧回合。'))
            result.update(error=message,hint=hint)
        return result

    def status(self,session):
        config=self.config(session['character'])
        leases=[self.metadata(lease) for lease in self.state['leases'].values() if lease['character']==session['character']]
        owner=next((item['lease_id'] for item in leases if item['state'] in LIVE and item['mode'] in ('output','handsfree')),None)
        return dict(**config,leases=leases,deliveries=[self.delivery.metadata(d) for d in self.state['deliveries'].values() if d['character']==session['character']],
                    output_owner=owner,legacy_playback_suppressed=config['enabled'] and config['output_provider']=='sapi',
                    fault=self.fault,physical_test='NOT_VERIFIED',local_only=True,
                    **(dict(code=self.fault,error='媒体功能已停止。',hint='核验设备状态并重启本地能力服务。') if self.fault else {}))

    def dispatch(self,op,session,params):
        self.service.management(session)
        action=op[len('media.'):]
        if action=='status':fields(params,());return self.status(session)
        if action=='lease.status':
            fields(params,('lease_id',))
            lease=self.state['leases'].get(params['lease_id'])
            if not lease or lease['character']!=session['character']:fail('PERMISSION_DENIED','媒体租约不可访问。')
            return self.metadata(lease)
        if action=='configure':
            fields(params,('enabled',),('output_provider',))
            if type(params['enabled']) is not bool or params.get('output_provider','external') not in ('sapi','external'):fail('INVALID_REQUEST','媒体偏好字段无效。')
            provider=params.get('output_provider',self.config(session['character'])['output_provider'])
            self.db.execute('INSERT OR REPLACE INTO media_config VALUES(?,?,?)',(session['character'],int(params['enabled']),provider))
            self.retire(session['character'],'MEDIA_CONFIGURATION_CHANGED')
            return dict(enabled=params['enabled'],output_provider=provider,leases_restored=False)
        if action=='stop':fields(params,());self.retire(session['character'],'MEDIA_STOPPED');return dict(stopped=True)
        self.guard(session,enabled=not action.startswith('catalog.'))
        if action.startswith('delivery.') or action.startswith('speech.'):
            return self.delivery.dispatch(action,session,params)
        if action=='events.poll':
            fields(params,(),('after','limit'))
            after,limit=params.get('after',0),params.get('limit',32)
            if type(after) is not int or after<0 or type(limit) is not int or not 1<=limit<=32:fail('INVALID_REQUEST','事件游标无效。')
            events=[e for e in self.state['events'] if e['character']==session['character']]
            if after and events and after<events[0]['sequence']-1:fail('MEDIA_EVENT_GAP','设备事件已超过有界历史。','停止当前设备回合并刷新状态；不补发旧转写或图像。')
            result=[{k:v for k,v in e.items() if k!='character'} for e in events if e['sequence']>after][:limit]
            return dict(events=result,next_sequence=result[-1]['sequence'] if result else max(after,self.state['sequence']),local_only=True)
        if action=='frame.read':
            fields(params,('lease_id','result_id','result_hash'),('offset','limit'))
            lease=self.current(session,self.state,params['lease_id'])
            result=self.state['results'].get(params['result_id'])
            if not result or result['lease_id']!=lease['lease_id'] or result['turn_id']!=lease['turn_id'] or result['kind']!='frame' or result['hash']!=params['result_hash']:fail('PERMISSION_DENIED','指定图像预览不可用。')
            offset,limit=params.get('offset',0),params.get('limit',262144)
            if type(offset) is not int or not 0<=offset<=len(result['data']) or type(limit) is not int or not 1<=limit<=262144:fail('INVALID_REQUEST','图像分块范围无效。')
            chunk=result['data'][offset:offset+limit]
            return dict(result_id=params['result_id'],result_hash=result['hash'],offset=offset,total_bytes=len(result['data']),base64=base64.b64encode(chunk).decode('ascii'),eof=offset+len(chunk)==len(result['data']),memory_write=False,history_write=False,local_only=True)
        if action.startswith('catalog.'):
            return self.catalog(action.split('.')[1],session,params)
        if action.startswith('lease.'):
            return self.lease(action.split('.')[1],session,params)
        fail('INVALID_REQUEST','未知媒体操作。')

    def catalog(self,action,session,params):
        state=copy.deepcopy(self.state);actions=[]
        if action=='start':
            fields(params,())
            if self.runtime.active(('catalog',)):fail('MEDIA_BUSY','设备枚举任务正在进行。')
            identifier=uuid.uuid4().hex
            state['catalogs']={key:value for key,value in state['catalogs'].items() if value['character']!=session['character']}
            if len(state['catalogs'])>=4:fail('MEDIA_LIMIT','当前枚举任务数量达到上限。')
            state['catalogs'][identifier]=dict(catalog_id=identifier,character=session['character'],epoch=session['epoch'],state='running',expires_at=self.now()+30000,deadline=time.monotonic()+30,refs={})
            actions.append(lambda:self.runtime.start(identifier,dict(mode='catalog')))
            self.stage(state,actions,session['character'],'catalog.start')
            return dict(catalog_id=identifier,state='running')
        fields(params,('catalog_id',))
        item=state['catalogs'].get(params['catalog_id'])
        if not item or item['character']!=session['character'] or item['epoch']!=session['epoch']:fail('PERMISSION_DENIED','设备列表不可访问。')
        if action=='cancel':
            item['state']='cancelled';actions.append(lambda:self.runtime.stop(item['catalog_id']));self.stage(state,actions,session['character'],'catalog.cancel')
        elif action!='status':fail('INVALID_REQUEST','未知设备枚举操作。')
        result=dict(catalog_id=item['catalog_id'],state=item['state'],local_only=True)
        if item.get('code'):result.update(code=item['code'],error='设备列表不可用。',hint='刷新列表，检查本机权限和设备后重试。')
        if item['state']=='succeeded':result.update(item['public'])
        return result

    def lookup(self,state,character,reference,kind):
        for catalog in state['catalogs'].values():
            if catalog['character']==character and catalog['epoch']==self.service.active.get(character) and catalog['state']=='succeeded' and catalog['expires_at']>self.now() and catalog['deadline']>time.monotonic():
                value=catalog['refs'].get(reference)
                if value and value['kind']==kind:return copy.deepcopy(value['data'])
        fail('MEDIA_TARGET_STALE','设备、声音或窗口选择已失效。','刷新本机列表并重新选择；不会切到默认设备。')

    def lease(self,action,session,params):
        state=copy.deepcopy(self.state);actions=[]
        if action=='prepare':
            fields(params,('subject_binding','mode','model_selection'),('input_ref','output_ref','voice_ref','window_ref','duration_seconds','frame_limit'))
            subject=self.subject(session,params['subject_binding']);model=selection(params['model_selection']);mode=params['mode']
            if mode not in ('ptt','handsfree','window','output'):fail('INVALID_REQUEST','媒体租约模式无效。')
            duration=params.get('duration_seconds',30 if mode=='ptt' else 60 if mode=='window' else 900)
            frames=params.get('frame_limit',1)
            maximum=30 if mode=='ptt' else 60 if mode=='window' else 900
            if type(duration) is not int or not 1<=duration<=maximum or type(frames) is not int or not 1<=frames<=3:fail('INVALID_REQUEST','媒体时长或图像数量超过允许范围。')
            required={'ptt':('input_ref',),'handsfree':('input_ref','output_ref','voice_ref'),'output':('output_ref','voice_ref'),'window':('window_ref',)}[mode]
            optional_targets={'input_ref','output_ref','voice_ref','window_ref'}
            if any(key not in params for key in required) or any(key in params for key in optional_targets-set(required)):fail('INVALID_REQUEST','所选设备与租约模式不匹配。')
            if mode!='window' and 'frame_limit' in params:fail('INVALID_REQUEST','音频租约不接受帧数量。')
            if mode=='window' and not model['image_capable']:fail('MEDIA_IMAGE_UNSUPPORTED','当前固定模型适配器未声明已审图像能力。')
            if mode in ('handsfree','output') and self.config(session['character'])['output_provider']!='sapi':fail('MEDIA_OUTPUT_PROVIDER','请明确选择 Windows 本地语音提供方。','现有外部 voxd 配置保留；此受控输出不会自动改用它。')
            if len(state['leases'])>=16:fail('MEDIA_LIMIT','本次服务的媒体租约数量已到上限。','停止设备并重启能力服务后重新准备。')
            identifier=uuid.uuid4().hex
            lease=dict(lease_id=identifier,character=session['character'],epoch=session['epoch'],subject_binding=subject['token'],subject=json.loads(self.service.tools.subject(subject)),
                mode=mode,model_selection=model,policy_generation=self.service.tools.policy()['generation'],generation=state['generations'].get(session['character'],1),
                expires_at=self.now()+duration*1000,prepared_until=self.now()+min(60,duration)*1000,revision=1,state='prepared',frames_remaining=frames if mode=='window' else 0,
                deadline=time.monotonic()+duration,prepared_deadline=time.monotonic()+min(60,duration),
                turn_id=None,code=None,purposes=['local_transcript_preview'] if mode=='ptt' else ['window_preview','model_image_input','pet_reply_no_history'] if mode=='window' else ['local_speech_output'] if mode=='output' else ['local_kws_vad_aec_asr','model_text_input','pet_reply','local_speech_output'])
            for key in required:
                target=key.split('_')[0]
                lease[target if target!='voice' else 'voice']=self.lookup(state,session['character'],params[key],target)
            lease['confirmation_digest']=hashed({key:value for key,value in lease.items() if key not in ('state','code')})
            state['leases'][identifier]=lease
            self.stage(state,actions,session['character'],'lease.prepare')
            return self.metadata(lease)
        fields(params,('lease_id','expected_revision','confirmation_digest') if action=='confirm' else ('lease_id',),('discard',) if action=='stop' else ())
        lease=self.current(session,state,params['lease_id'])
        if action=='status':return self.metadata(lease)
        if action=='confirm':
            if lease['state']!='prepared' or lease['prepared_until']<=self.now() or lease['prepared_deadline']<=time.monotonic() or type(params['expected_revision']) is not int or params['expected_revision']!=lease['revision'] or params['confirmation_digest']!=lease['confirmation_digest']:fail('VERSION_CONFLICT','媒体确认版本、用途摘要或期限不匹配。')
            if lease['mode'] in ('output','handsfree') and any(other['lease_id']!=lease['lease_id'] and other['mode'] in ('output','handsfree') and other['state'] in LIVE for other in state['leases'].values()):fail('MEDIA_OUTPUT_BUSY','已有已确认的语音输出所有者。')
            lease.update(state='confirmed',revision=lease['revision']+1)
        elif action=='start':
            if lease['state'] not in ('confirmed','preview') or (lease['mode']=='window' and lease['frames_remaining']<1):fail('INVALID_STATE','此租约不能启动新采集或播放所有者。')
            mode=lease['mode']
            if mode in ('ptt','handsfree') and self.runtime.active(('ptt','handsfree')):fail('MEDIA_BUSY','已有输入流或未完成的设备释放。')
            if mode in ('output','handsfree') and (self.runtime.active(('output','handsfree')) or any(other['lease_id']!=lease['lease_id'] and other['mode'] in ('output','handsfree') and other['state'] in LIVE for other in state['leases'].values())):fail('MEDIA_OUTPUT_BUSY','已有语音输出所有者；不能双播音。')
            if mode=='window' and self.runtime.active(('window',)):fail('MEDIA_BUSY','已有单次窗口捕获正在进行。')
            lease.update(state='starting',revision=lease['revision']+1,heartbeat=time.monotonic(),started=time.monotonic(),visibility_deadline=min(time.monotonic()+3,lease['deadline']))
            if mode=='window':
                lease['frames_remaining']-=1;lease['turn_id']=str(uuid.uuid4())
                for key in list(state['results']):
                    if state['results'][key]['lease_id']==lease['lease_id']:del state['results'][key]
                for item in state['deliveries'].values():
                    if item['lease_id']==lease['lease_id']:item['state']='cancelled'
            actions.append(lambda:self.start_worker(session,lease['lease_id']))
        elif action=='stop' and params.get('discard',True) is False:
            if lease['mode']!='ptt' or lease['state'] not in ('starting','running'):fail('INVALID_STATE','只有正在录音的按键会话可完成转写。')
            lease.update(state='finishing',revision=lease['revision']+1)
            actions.append(lambda:self.runtime.command(lease['lease_id'],dict(type='finish')))
        elif action=='pulse':
            if lease['state'] not in ('starting','running','finishing','preview'):fail('INVALID_STATE','只有已启动且仍可见的租约可延续可见性。')
            lease['visibility_deadline']=min(time.monotonic()+3,lease['deadline'])
            def pulse():
                current=self.post_current(session,lease['lease_id'])
                # A completed single-frame worker has exited; the immutable preview remains live.
                if current['mode']!='window' or current['state']!='preview':
                    self.runtime.command(current['lease_id'],dict(type='pulse',visibility_deadline=current['visibility_deadline']))
                for output in self.state['leases'].values():
                    item=self.state['deliveries'].get(output.get('speech_delivery'))
                    if item and item['lease_id']==current['lease_id']:
                        self.speech_current(session,self.state,output)
                        self.runtime.command(output['lease_id'],dict(type='speech.pulse',generation_id=item['source_turn'],source_visibility_deadline=current['visibility_deadline']))
            actions.append(pulse)
        elif action in ('stop','revoke'):
            if 'discard' in params and type(params['discard']) is not bool:fail('INVALID_REQUEST','discard 必须为布尔值。')
            self.revoke(state,lease['lease_id'],actions,'MEDIA_STOPPED')
        else:fail('INVALID_REQUEST','未知媒体租约操作。')
        self.stage(state,actions,session['character'],'lease.'+action)
        return self.metadata(lease)

    def event(self,state,identifier,event,actions):
        kind=event.get('type')
        catalog=state['catalogs'].get(identifier)
        if catalog:
            if catalog['state']!='running':return
            if kind=='catalog':
                data=event['data'];refs={};public=dict(devices=[],voices=[],windows=[])
                if len(data.get('devices',[]))>256 or len(data.get('voices',[]))>64 or len(data.get('windows',[]))>30:raise ValueError('catalog overflow')
                for group in public:
                    for target in data.get(group,[]):
                        ref=uuid.uuid4().hex;targetkind=target['kind'] if group=='devices' else 'voice' if group=='voices' else 'window'
                        refs[ref]=dict(kind=targetkind,data=target)
                        public[group].append(dict(ref=ref,**({key:target[key] for key in ('name','kind','sample_rate','hostapi') if key in target} if group!='windows' else dict(title=target['title'],pid=target['pid']))))
                catalog.update(state='succeeded',refs=refs,public=public,expires_at=self.now()+300000,deadline=time.monotonic()+300)
            elif kind in ('failed','process.exited'):catalog.update(state='failed',code='MEDIA_CATALOG_FAILED')
            return
        lease=state['leases'].get(identifier)
        if not lease or lease['state'] not in LIVE:return
        lease['heartbeat']=time.monotonic()
        if event.get('state') in ('loading','armed','listening','thinking','speaking','idle','preview'):lease['worker_state']=event['state']
        if 'voice_level' in event:
            if type(event['voice_level']) not in (int,float) or not 0<=event['voice_level']<=1:raise ValueError('invalid level')
            lease['voice_level']=event['voice_level']
        if kind in ('heartbeat','prepared'):return
        if kind=='ready':
            lease.update(state='running',revision=lease['revision']+1)
            if event.get('generation_id'):lease['turn_id']=str(uuid.UUID(event['generation_id']))
        elif kind in ('wake','interrupted'):
            generation=str(uuid.UUID(event['generation_id']))
            # Source emits interrupted(old), then wake(new). Both revoke pending deliveries.
            for delivery in state['deliveries'].values():
                if delivery['lease_id']==identifier:delivery['state']='cancelled'
            for key in list(state['results']):
                if state['results'][key]['lease_id']==identifier:del state['results'][key]
            lease['turn_id']=generation
            self.emit(state,lease['character'],'interrupt',lease_id=identifier,turn_id=generation)
        elif kind in ('asr.partial','asr.final'):
            text=bounded(event.get('text'),4000);generation=str(uuid.UUID(event['generation_id']))
            if lease['turn_id'] not in (None,generation):return
            lease['turn_id']=generation
            if kind=='asr.final':
                if len(state['results'])>=16:raise ValueError('result overflow')
                result_id=uuid.uuid4().hex;result_hash=hashed(dict(text=text))
                state['results'][result_id]=dict(result_id=result_id,lease_id=identifier,kind='transcript',text=text,hash=result_hash,turn_id=generation)
                if lease['mode']=='ptt':lease['state']='preview'
                self.emit(state,lease['character'],kind,lease_id=identifier,result_id=result_id,result_hash=result_hash,text=text,turn_id=generation,local_only=True)
            else:self.emit(state,lease['character'],kind,lease_id=identifier,text=text,turn_id=generation,local_only=True)
        elif kind=='frame':
            data=base64.b64decode(event['png'],validate=True)
            if not data.startswith(b'\x89PNG\r\n\x1a\n') or not 24<=len(data)<=1500000:raise ValueError('invalid PNG')
            width,height=struct.unpack('>II',data[16:24])
            if not 0<width<=640 or not 0<height<=640 or hashlib.sha256(data).hexdigest()!=event['sha256']:raise ValueError('invalid PNG hash')
            self.window_guard(lease['window'])
            if sum(result['kind']=='frame' for result in state['results'].values())>=3:raise ValueError('frame overflow')
            result_id=uuid.uuid4().hex
            state['results'][result_id]=dict(result_id=result_id,lease_id=identifier,kind='frame',data=data,hash=event['sha256'],turn_id=lease['turn_id'])
            lease['state']='preview'
            self.emit(state,lease['character'],'frame.ready',lease_id=identifier,result_id=result_id,result_hash=event['sha256'],width=width,height=height,bytes=len(data),memory_write=False,history_write=False)
        elif kind=='reply.finished':
            if str(event.get('generation_id'))!=lease.get('speech_generation'):return
            lease.pop('speech_delivery',None);lease.pop('speech_generation',None)
            self.emit(state,lease['character'],kind,lease_id=identifier,turn_id=lease.get('turn_id'))
        elif kind=='failed':
            translated={'LOCAL_MODEL_UNAVAILABLE':'MEDIA_MODEL_UNAVAILABLE','AUDIO_UNAVAILABLE':'MEDIA_AUDIO_UNAVAILABLE','AUDIO_FAILED':'MEDIA_AUDIO_FAILED','CONTROL_FAILED':'MEDIA_PROTOCOL_FAILED','REPLY_FAILED':'MEDIA_PLAYBACK_FAILED','SESSION_LIMIT':'MEDIA_SESSION_LIMIT'}
            candidate=translated.get(event.get('code'),event.get('code'))
            code=candidate if candidate in MESSAGES or candidate in ('MEDIA_CAPTURE_NOT_STARTED','MEDIA_TRANSCRIPT_LIMIT','MEDIA_OUTPUT_BUSY','MEDIA_QUEUE_OVERFLOW','MEDIA_PROTOCOL_FAILED','MEDIA_SESSION_LIMIT') else 'MEDIA_WORKER_FAILED'
            self.revoke(state,identifier,actions,code)
        elif kind in ('stopped','process.exited'):
            if lease['mode']!='window':self.revoke(state,identifier,actions,'MEDIA_WORKER_STOPPED')

    def poll(self):
        if self.closed:return
        if self.runtime.overflow.is_set():self.fail_closed('MEDIA_QUEUE_OVERFLOW')
        if self.fault:return
        batch=self.runtime.events.snapshot()
        if not batch and not any(lease['state'] in LIVE+('prepared',) for lease in self.state['leases'].values()) and not any(c['state']=='running' for c in self.state['catalogs'].values()):
            self.runtime.collect();return
        state=copy.deepcopy(self.state);actions=[]
        try:
            self.db.execute('BEGIN IMMEDIATE')
            for identifier,lease in state['leases'].items():
                if lease['state'] not in LIVE+('prepared',):continue
                session=next((s for s in self.service.bindings.values() if s['character']==lease['character'] and s['management']),None)
                try:
                    if not session:raise ValueError()
                    self.current(session,state,identifier)
                    if lease['state'] in ('starting','running','finishing') or (lease['state']=='preview' and lease['mode']!='window'):
                        timeout=(8 if lease['mode']=='window' else 20) if lease['state']=='starting' else 2
                        if time.monotonic()-lease.get('heartbeat',0)>timeout:raise ValueError()
                except ServiceError as failure:self.revoke(state,identifier,actions,failure.code)
                except Exception:self.revoke(state,identifier,actions,'MEDIA_LEASE_STALE')
            for catalog in state['catalogs'].values():
                if catalog['state']=='running' and (catalog['expires_at']<=self.now() or catalog['deadline']<=time.monotonic()):catalog.update(state='failed',code='MEDIA_CATALOG_TIMEOUT');actions.append(lambda catalog=catalog:self.runtime.stop(catalog['catalog_id']))
            for identifier,event,_ in batch:
                try:self.event(state,identifier,event,actions)
                except (ValueError,KeyError,TypeError,ServiceError):
                    if identifier in state['leases']:self.revoke(state,identifier,actions,'MEDIA_PROTOCOL_FAILED')
                    elif identifier in state['catalogs']:state['catalogs'][identifier].update(state='failed',code='MEDIA_CATALOG_FAILED')
            self.sweep_speech(state,actions)
            self.db.execute('COMMIT')
        except BaseException:
            self.fail_closed();self.service.tools.latch_fault()
            try:
                if self.db.in_transaction:self.db.execute('ROLLBACK')
            except BaseException:pass
            raise ServiceError('SERVICE_UNAVAILABLE','媒体状态无法核验或持久化，已关闭设备。','核对设备与本地存储后重启；旧帧、转写和播音不会恢复。') from None
        self.runtime.events.acknowledge(batch)
        self.publish(state,actions);self.runtime.collect()

    def close(self):
        self.closed=True;self.fail_closed('PARENT_EXITED');self.runtime.close()
