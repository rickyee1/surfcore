"""Exact volatile transcript/frame delivery; no cloud client or media history writes."""
import copy
import time
import uuid
from media_authority import fail,selection
from tool_contracts import fields,bounded,hashed

CONTEXT=('subject_binding','host_request_id','turn_id','context_ref','model_selection')


class MediaDelivery:
    def __init__(self,authority):self.a=authority

    def metadata(self,item):
        return {key:item.get(key) for key in ('delivery_id','revision','state','lease_id','result_id','result_hash','subject_binding','host_request_id','turn_id','context_ref','expected_memory_epoch','model_selection','expires_at','confirmation_digest','memory_write','history_write','purposes')}

    def checked(self,session,state,params):
        item=state['deliveries'].get(bounded(params['delivery_id']))
        if not item or item['character']!=session['character']:fail('PERMISSION_DENIED','媒体交付不可访问。')
        lease=self.a.current(session,state,item['lease_id'])
        if (item['subject_binding']!=params['subject_binding'] or item['host_request_id']!=params['host_request_id'] or
            item['turn_id']!=params['turn_id'] or item['context_ref']!=params['context_ref']):fail('PERMISSION_DENIED','媒体交付的原桌宠、请求、上下文或回合不匹配。')
        if selection(params['model_selection'])!=item['model_selection']:
            self.a.revoke_immediate(session['character'],'MEDIA_MODEL_CHANGED')
            fail('MEDIA_MODEL_CHANGED','当前模型、端点或适配器与已确认目的地不同。','停止本次媒体回合，重新选择并确认固定模型；不允许 fallback。')
        result=state['results'].get(item['result_id'])
        if item['expected_memory_epoch']!=self.a.service.epoch(session['character']) or item['expires_at']<=self.a.now() or item['deadline']<=time.monotonic() or not result or result['hash']!=item['result_hash'] or result['turn_id']!=lease['turn_id'] or item['source_turn']!=lease['turn_id']:
            fail('MEDIA_DELIVERY_STALE','媒体交付的期限、帧哈希或原回合已经失效。')
        return item,lease,result

    def dispatch(self,action,session,params):
        state=copy.deepcopy(self.a.state);actions=[]
        if action=='delivery.prepare':
            fields(params,('lease_id','result_id','result_hash','host_request_id','turn_id','context_ref','expected_memory_epoch'))
            lease=self.a.current(session,state,params['lease_id'])
            result=state['results'].get(params['result_id'])
            if not result or result['lease_id']!=lease['lease_id'] or result['hash']!=params['result_hash'] or result['turn_id']!=lease['turn_id']:
                fail('PERMISSION_DENIED','媒体转写或预览不是当前租约的同一结果。')
            host_request,turn=bounded(params['host_request_id']),bounded(params['turn_id'])
            context=bounded(params['context_ref'])
            epoch=params['expected_memory_epoch']
            if type(epoch) is not int or epoch!=self.a.service.epoch(session['character']):fail('STALE_CONTEXT','媒体交付不能使用旧记忆上下文。')
            for previous in state['deliveries'].values():
                if previous['result_id']==result['result_id']:
                    if previous['host_request_id']==host_request and previous['turn_id']==turn and previous['context_ref']==context and previous['expected_memory_epoch']==epoch and previous['state'] in ('awaiting_confirmation','authorized'):
                        return self.metadata(previous)
                    fail('MEDIA_RESULT_USED','此媒体结果已经准备或尝试交付。','不重放不明交付；重新采集并明确确认新结果。')
            if len(state['deliveries'])>=24:fail('MEDIA_LIMIT','本次媒体交付数量已达到上限。','停止设备并重启本地能力服务后重新准备。')
            item=dict(delivery_id=uuid.uuid4().hex,character=session['character'],lease_id=lease['lease_id'],result_id=result['result_id'],result_hash=result['hash'],
                subject_binding=lease['subject_binding'],host_request_id=host_request,turn_id=turn,source_turn=result['turn_id'],model_selection=lease['model_selection'],
                context_ref=context,expected_memory_epoch=epoch,
                expires_at=min(self.a.now()+120000,lease['expires_at']),revision=1,state='authorized' if lease['mode']=='handsfree' else 'awaiting_confirmation',
                deadline=min(time.monotonic()+120,lease['deadline']),
                memory_write=False,history_write=lease['mode']=='ptt',purposes=['model_image_input','pet_reply_no_history'] if result['kind']=='frame' else ['model_text_input','pet_reply','local_speech_output'],speech_started=False)
            item['confirmation_digest']=hashed(item)
            state['deliveries'][item['delivery_id']]=item
            self.a.stage(state,actions,session['character'],action)
            return self.metadata(item)
        if action=='delivery.confirm':
            fields(params,('delivery_id','expected_revision','confirmation_digest'))
            item=state['deliveries'].get(params['delivery_id'])
            if not item or item['character']!=session['character']:fail('PERMISSION_DENIED','媒体交付不可访问。')
            self.a.current(session,state,item['lease_id'])
            result=state['results'].get(item['result_id'])
            lease=state['leases'][item['lease_id']]
            if (item['state']!='awaiting_confirmation' or item['expected_memory_epoch']!=self.a.service.epoch(session['character']) or not result or result['hash']!=item['result_hash'] or result['turn_id']!=lease['turn_id'] or item['expires_at']<=self.a.now() or item['deadline']<=time.monotonic() or type(params['expected_revision']) is not int or
                params['expected_revision']!=item['revision'] or params['confirmation_digest']!=item['confirmation_digest']):fail('VERSION_CONFLICT','转写或同帧交付确认的版本、摘要或期限不匹配。')
            item.update(state='authorized',revision=item['revision']+1)
            self.a.stage(state,actions,session['character'],action)
            return self.metadata(item)
        if action=='delivery.finalize':
            fields(params,('delivery_id','outcome'))
            item=state['deliveries'].get(params['delivery_id'])
            if not item or item['character']!=session['character']:fail('PERMISSION_DENIED','媒体交付不可访问。')
            if params['outcome'] not in ('sent','failed','unknown') or item['state'] not in ('consumed',params['outcome']):fail('INVALID_STATE','只有已尝试的媒体交付可记录固定收据。')
            item.update(state=params['outcome'],revision=item['revision']+1)
            self.a.stage(state,actions,session['character'],action)
            return self.metadata(item)
        if action=='speech.stop':
            fields(params,('lease_id',))
            lease=self.a.current(session,state,params['lease_id'])
            self.a.revoke(state,lease['lease_id'],actions,'MEDIA_SPEECH_STOPPED')
            if lease.get('speech_delivery') in state['deliveries']:state['deliveries'][lease['speech_delivery']]['state']='cancelled'
            self.a.stage(state,actions,session['character'],action)
            return dict(stopped=True)
        if action in ('delivery.consume','delivery.validate','speech.start'):
            fields(params,('delivery_id',)+CONTEXT+(('lease_id','text') if action=='speech.start' else ()))
            item,source,result=self.checked(session,state,params)
            if action=='delivery.consume':
                if item['state'] in ('consumed','sent','failed','unknown'):fail('MEDIA_DELIVERY_CONSUMED','此媒体结果已尝试交付，不能重新获取。','响应丢失属于不明交付；不会重发旧转写或图像。')
                if item['state']!='authorized':fail('CONFIRMATION_REQUIRED','需要先明确确认本次转写或图像发送。')
                item.update(state='consumed',revision=item['revision']+1)
                self.a.stage(state,actions,session['character'],action)
                return dict(**self.metadata(item),text=result.get('text'),frame=dict(lease_id=source['lease_id'],result_id=result['result_id'],result_hash=result['hash'],bytes=len(result['data'])) if result['kind']=='frame' else None,delivery_confirmed=False)
            if item['state']!='consumed':fail('MEDIA_DELIVERY_STALE','媒体交付尚未占用、已经终结或被取消。')
            if action=='delivery.validate':return dict(valid=True,**self.metadata(item))
            output=self.a.current(session,state,params['lease_id'])
            if output['mode'] not in ('output','handsfree') or output['state'] not in ('running','preview') or output['subject_binding']!=item['subject_binding'] or output['model_selection']!=item['model_selection']:
                fail('MEDIA_OUTPUT_OWNER','本次回复没有当前原桌宠的匹配输出所有者。')
            if item['speech_started']:fail('MEDIA_SPEECH_USED','本回合语音已启动，不能重复播放。')
            text=bounded(params['text'],4000)
            item['speech_started']=True
            output.update(speech_generation=item['source_turn'],speech_delivery=item['delivery_id'])
            actions.append(lambda:self.a.speak_worker(session,output['lease_id'],text))
            self.a.stage(state,actions,session['character'],action)
            return dict(started=True,delivery_id=item['delivery_id'],single_output_owner=output['lease_id'],memory_write=False,history_write=item['history_write'])
        fail('INVALID_REQUEST','未知媒体交付操作。')
