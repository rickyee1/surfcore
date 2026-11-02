"""Exact-result delivery consent. Only management/trusted host can obtain the body.

No transport is implemented here. A host must revalidate after every await and at
the actual model/private-send boundary using its frozen selection, never defaults.
"""
import json
import re
import uuid
from tool_contracts import bounded, encode, fail, fields, hashed

CONTEXT = ('subject_binding','host_request_id','turn_id')
SELECTION = CONTEXT + ('destination_ref','config_revision','endpoint_identity')


class ToolExports:
    def __init__(self, broker):
        self.broker,self.service,self.db = broker,broker.service,broker.db

    def subject(self, session, params, result_subject=None):
        subject=self.service.bindings.get(bounded(params['subject_binding']))
        if not subject or subject['character'] != session['character'] or subject['epoch'] != session['epoch'] or (result_subject and self.broker.subject(subject) != result_subject):
            fail('BINDING_INVALID','导出主体或会话已经失效。')
        self.broker.allowed_subject(subject)
        bounded(params['host_request_id'])
        bounded(params['turn_id'])
        return subject

    def destinations(self, action, session, params):
        self.service.management(session)
        self.broker.ready(session)
        if action=='register':
            fields(params,CONTEXT+('model','private_reply'))
            subject=self.subject(session,params)
            model=params['model']
            fields(model,('provider','model','config_revision','endpoint_identity'))
            model={key:bounded(value) for key,value in model.items()}
            if not re.fullmatch('[0-9a-f]{64}',model['endpoint_identity']) or type(params['private_reply']) is not bool:
                fail('INVALID_REQUEST','模型端点身份必须是非秘密 SHA256，private_reply 必须是布尔值。')
            if params['private_reply'] and not (subject['platform']=='pet' or (subject['platform']=='qq' and subject['scope'].startswith(('qq:private:','owner:local')))):
                fail('PERMISSION_DENIED','组合交付仅限原桌宠或 QQ 私聊会话。')
            descriptor=dict(model=model,purposes=['model_input']+(['private_reply'] if params['private_reply'] else []),
                            private_destination=json.loads(self.broker.subject(subject)) if params['private_reply'] else None,
                            memory_write=False,host_request_id=params['host_request_id'],turn_id=params['turn_id'])
            self.db.execute('UPDATE tool_destinations SET active=0 WHERE character=? AND binding=?',(session['character'],subject['token']))
            identifier=uuid.uuid4().hex
            self.db.execute('INSERT INTO tool_destinations VALUES(?,?,?,?,?,?,?,?,1)',(identifier,session['character'],session['epoch'],subject['token'],self.broker.subject(subject),params['host_request_id'],params['turn_id'],encode(descriptor)))
            return dict(destination_ref=identifier,descriptor=descriptor,local_only=True)
        if action=='revoke':
            fields(params,('destination_ref',))
            if not self.db.execute('UPDATE tool_destinations SET active=0 WHERE id=? AND character=?',(bounded(params['destination_ref']),session['character'])).rowcount:
                fail('PERMISSION_DENIED','交付目标不可访问。')
            return dict(revoked=True,local_only=True)
        fail('INVALID_REQUEST','未知交付目标管理操作。')

    def destination(self, session, identifier):
        row=self.db.execute('SELECT * FROM tool_destinations WHERE id=? AND character=? AND active=1',(bounded(identifier),session['character'])).fetchone()
        if not row or row['epoch'] != session['epoch']:
            fail('STALE_DESTINATION','原交付目标已改变或撤销。','重新选择当前模型和原私域会话，再核对逐结果确认。')
        return row

    def digest(self, export, result, execution, destination):
        return hashed(dict(export_id=export['id'],execution_id=execution['id'],execution_revision=execution['revision'],
                           result_id=result['id'],result_revision=1,character_epoch=export['epoch'],binding=export['binding'],
                           subject=export['subject'],host_request_id=export['host_request'],turn_id=export['turn_id'],
                           memory_epoch=export['memory_epoch'],policy_generation=export['policy_generation'],
                           destination_ref=destination['id'],destination=json.loads(destination['descriptor']),
                           body_hash=hashed(json.loads(result['body'])),expires_at=export['expires']))

    def checked(self, session, row):
        result,execution=self.broker.result(session,row['result'])
        destination=self.destination(session,row['destination_ref'])
        if (row['epoch'] != session['epoch'] or row['memory_epoch'] != self.service.epoch(session['character']) or
            row['policy_generation'] != self.broker.policy()['generation'] or row['expires'] <= self.broker.now() or
            row['binding'] not in self.service.bindings or destination['binding'] != row['binding'] or
            destination['host_request'] != row['host_request'] or destination['turn_id'] != row['turn_id'] or
            hashed(json.loads(result['body'])) != row['body_hash'] or self.digest(row,result,execution,destination) != row['digest']):
            fail('STALE_EXPORT','导出内容、目标、代次或期限已经失效。','重新核对当前结果与具体目标并创建新确认；不要发送旧生成结果。')
        return result,destination

    @staticmethod
    def context_matches(row, params):
        if row['binding'] != params['subject_binding'] or row['host_request'] != params['host_request_id'] or row['turn_id'] != params['turn_id']:
            fail('PERMISSION_DENIED','原请求、回合或主体会话不匹配。')

    def dispatch(self, action, session, params):
        # A model/ordinary tool caller can never consume local data, even after confirmation.
        self.service.management(session)
        if action=='list':
            fields(params,(),('limit',))
            limit=params.get('limit',20)
            if type(limit) is not int or not 1 <= limit <= 50:
                fail('INVALID_REQUEST','导出记录数量必须在 1 到 50 之间。')
            rows=self.db.execute('SELECT * FROM tool_exports WHERE character=? ORDER BY rowid DESC LIMIT ?',(session['character'],limit)).fetchall()
            return dict(exports=[self.metadata(row) for row in rows],local_only=True)
        if action=='status':
            fields(params,('export_id',))
            row=self.db.execute('SELECT * FROM tool_exports WHERE id=? AND character=?',(bounded(params['export_id']),session['character'])).fetchone()
            if not row:
                fail('PERMISSION_DENIED','导出记录不可访问。')
            return self.metadata(row)
        if action != 'finalize':
            self.broker.ready(session)
        if action=='prepare':
            fields(params,('result_id','expected_result_revision','destination_ref')+CONTEXT)
            result,execution=self.broker.result(session,params['result_id'])
            if type(params['expected_result_revision']) is not int or params['expected_result_revision'] != 1:
                fail('VERSION_CONFLICT','结果版本不匹配。')
            subject=self.subject(session,params,execution['subject'])
            destination=self.destination(session,params['destination_ref'])
            if destination['binding'] != subject['token'] or destination['host_request'] != params['host_request_id'] or destination['turn_id'] != params['turn_id']:
                fail('PERMISSION_DENIED','交付目标不属于原请求、回合与会话。')
            row=dict(id=uuid.uuid4().hex,execution=execution['id'],result=result['id'],character=session['character'],epoch=session['epoch'],
                     binding=subject['token'],subject=execution['subject'],memory_epoch=self.service.epoch(session['character']),
                     policy_generation=self.broker.policy()['generation'],destination_ref=destination['id'],body_hash=hashed(json.loads(result['body'])),
                     expires=self.broker.now()+60000,state='prepared',revision=1,host_request=params['host_request_id'],turn_id=params['turn_id'])
            row['digest']=self.digest(row,result,execution,destination)
            self.db.execute('INSERT INTO tool_exports VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',tuple(row[key] for key in
                            ('id','execution','result','character','epoch','binding','subject','memory_epoch','policy_generation','destination_ref','body_hash','digest','expires','state','revision','host_request','turn_id')))
            prior,count=self.prior(result['id'],row['id'])
            return dict(export_id=row['id'],revision=1,state='prepared',confirmation_digest=row['digest'],body_hash=row['body_hash'],
                        body_bytes=len(result['body'].encode('utf-8')),result_id=result['id'],result_revision=1,destination_ref=destination['id'],
                        descriptor=json.loads(destination['descriptor']),expires_at=row['expires'],prior_unconfirmed_exports=prior,prior_unconfirmed_count=count,local_only=True)
        required=('export_id','expected_revision','confirmation_digest') if action=='confirm' else ('export_id',)+CONTEXT+('outcome',) if action=='finalize' else ('export_id',)+SELECTION
        fields(params,required)
        row=self.db.execute('SELECT * FROM tool_exports WHERE id=? AND character=?',(bounded(params['export_id']),session['character'])).fetchone()
        if not row:
            fail('PERMISSION_DENIED','导出记录不可访问。')
        if action=='finalize':
            # A receipt can record uncertainty even after expiry/revoke; it grants no data or resend.
            self.context_matches(row,params)
            if params['outcome'] not in ('sent','failed','unknown') or row['state'] not in ('consumed','sent','failed','unknown'):
                fail('INVALID_STATE','只有已占用的交付可记录 sent/failed/unknown 收据。')
            if row['state'] != 'consumed' and row['state'] != params['outcome']:
                fail('INVALID_STATE','终态收据不可改写。')
            if row['state']=='consumed':
                self.db.execute('UPDATE tool_exports SET state=?,revision=revision+1 WHERE id=?',(params['outcome'],row['id']))
            return dict(export_id=row['id'],state=params['outcome'],delivery_confirmed=params['outcome']=='sent',local_only=True)
        if action in ('consume','validate'):
            self.context_matches(row,params)
            if action=='consume' and row['state'] in ('consumed','sent','failed','unknown'):
                fail('EXPORT_ALREADY_CONSUMED','此结果已尝试交付，不能再次读取正文。','响应丢失属于不明交付；核验目标后重新发起新确认。')
        result,destination=self.checked(session,row)
        if action=='confirm':
            if row['state']!='prepared' or type(params['expected_revision']) is not int or params['expected_revision'] != row['revision'] or params['confirmation_digest'] != row['digest']:
                fail('VERSION_CONFLICT','导出确认状态、版本或摘要不匹配。')
            self.db.execute("UPDATE tool_exports SET state='confirmed',revision=revision+1 WHERE id=?",(row['id'],))
            return dict(export_id=row['id'],revision=row['revision']+1,state='confirmed',expires_at=row['expires'],local_only=True)
        if action not in ('consume','validate'):
            fail('INVALID_REQUEST','未知结果导出操作。')
        model=json.loads(destination['descriptor'])['model']
        if params['destination_ref'] != row['destination_ref'] or params['config_revision'] != model['config_revision'] or params['endpoint_identity'] != model['endpoint_identity']:
            fail('STALE_DESTINATION','当前模型配置、端点或目的地与确认不一致。','使用准备时固定的模型与端点；任何更换或 fallback 必须重新确认。')
        if row['state'] not in ('confirmed','consumed'):
            fail('CONFIRMATION_REQUIRED','该交付尚未获得有效精确确认。')
        response=dict(export_id=row['id'],state=row['state'],destination_ref=destination['id'],descriptor=json.loads(destination['descriptor']),
                      expires_at=row['expires'],memory_epoch=row['memory_epoch'],policy_generation=row['policy_generation'],
                      subject_binding=row['binding'],host_request_id=row['host_request'],turn_id=row['turn_id'],memory_write=False)
        if action=='consume':
            if self.db.execute("UPDATE tool_exports SET state='consumed',revision=revision+1 WHERE id=? AND state='confirmed' AND revision=?",(row['id'],row['revision'])).rowcount != 1:
                fail('EXPORT_ALREADY_CONSUMED','此交付已被消费。')
            response.update(state='consumed',revision=row['revision']+1,body=json.loads(result['body']),delivery_confirmed=False)
        else:
            response['valid']=True
        return response

    def metadata(self, row):
        destination=self.db.execute('SELECT descriptor FROM tool_destinations WHERE id=?',(row['destination_ref'],)).fetchone()
        prior,count=self.prior(row['result'],row['id'])
        return dict(export_id=row['id'],revision=row['revision'],state=row['state'],expires_at=row['expires'],
                    confirmation_digest=row['digest'] if row['state']=='prepared' else None,result_id=row['result'],result_revision=1,
                    destination_ref=row['destination_ref'],descriptor=json.loads(destination[0]) if destination else None,
                    subject_binding=row['binding'],subject=json.loads(row['subject']),host_request_id=row['host_request'],turn_id=row['turn_id'],
                    outcome=row['state'] if row['state'] in ('sent','failed','unknown') else None,
                    prior_unconfirmed_exports=prior,prior_unconfirmed_count=count,
                    unconfirmed=row['state'] in ('consumed','unknown'),delivery_confirmed=row['state']=='sent',local_only=True)

    def prior(self, result_id, excluded_id):
        query="FROM tool_exports WHERE result=? AND id!=? AND state IN ('consumed','unknown')"
        args=(result_id,excluded_id)
        return ([row[0] for row in self.db.execute('SELECT id '+query+' ORDER BY rowid DESC LIMIT 20',args)],
                self.db.execute('SELECT count(*) '+query,args).fetchone()[0])
