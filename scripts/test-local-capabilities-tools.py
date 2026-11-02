"""T3 behavioral counterexamples. Disposable SQLCipher fixtures; no real tools/devices."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import threading
import time
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('tool_service_fixtures',ROOT/'scripts/test-local-capabilities-service.py')
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
from tool_contracts import descriptors, hashed
from tool_paths import pinned_path


class Tools(unittest.TestCase):
    for name in ('tearDown','call','good','bad','activate','bind','epoch','ingest'):
        locals()[name] = getattr(fixtures.Behavior,name)

    def setUp(self):
        self.lock = 'unlocked'
        self.lock_patch = patch('tool_broker.lockscreen_state',side_effect=lambda:self.lock)
        self.lock_patch.start()
        self.addCleanup(self.lock_patch.stop)
        fixtures.Behavior.setUp(self)
        self.files = self.directory/'files-fixture'
        self.files.mkdir()
        self.file = self.files/'sample.txt'
        self.file.write_text('synthetic LOCAL-BODY must stay private',encoding='utf-8')
        # The data directory itself cannot be a tool root; use a sibling temporary root.
        import tempfile
        self.file_temp = tempfile.TemporaryDirectory(prefix='surfcore-tool-files-')
        self.addCleanup(self.file_temp.cleanup)
        self.files = Path(self.file_temp.name)
        self.file = self.files/'sample.txt'
        self.file.write_text('synthetic LOCAL-BODY must stay private',encoding='utf-8')
        self.root_id = self.good(self.call('tool.roots.register',dict(path=str(self.files),label='synthetic root'),self.owner))['root_id']

    def tool(self, tool='time.now', args=None, key=None, binding=None):
        return self.good(self.call('tool.propose',dict(tool_id=tool,action=descriptors()[tool]['action'],arguments=args or {},
                         idempotency_key=key or os.urandom(8).hex()),binding or self.pet))

    def confirm(self, execution):
        return self.good(self.call('tool.confirm',dict(execution_id=execution['execution_id'],expected_revision=execution['revision'],
                         confirmation_digest=execution['confirmation_digest']),self.owner))

    def run_tool(self, tool, args=None, binding=None):
        execution = self.tool(tool,args,binding=binding)
        if execution['state'] == 'awaiting_confirmation':
            self.confirm(execution)
        result = self.good(self.call('tool.execute',dict(execution_id=execution['execution_id']),binding or self.pet))
        if result['state'] == 'running':
            result = self.wait(execution['execution_id'],binding)
        return result

    def wait(self, identifier, binding=None):
        for _ in range(200):
            result = self.good(self.call('tool.status',dict(execution_id=identifier),binding or self.pet))
            if result['state'] in ('succeeded','failed','unknown','cancelled'):
                return result
            time.sleep(.005)
        self.fail('bounded synthetic worker did not finish')

    def body(self, execution):
        return self.good(self.call('tool.result.read',dict(result_id=execution['result_id']),self.owner))['body']

    def grant(self, tool, binding=None, uses=1, **extra):
        params=dict(subject_binding=binding or self.pet,tool_id=tool,action=descriptors()[tool]['action'],descriptor_hash=descriptors()[tool]['descriptor_hash'],
                    expires_at=self.now*1000+60000,uses=uses,**extra)
        if tool.startswith('files.') or tool == 'local.open_directory':
            params['root_id']=self.root_id
        return self.good(self.call('tool.grants.create',params,self.owner))

    def file_args(self, relative='sample.txt'):
        return dict(root_id=self.root_id,relative_path=relative)

    def slow(self):
        entered,release=threading.Event(),threading.Event()
        def adapter(job,cancel):
            entered.set()
            release.wait(2)
            return dict(text='synthetic delayed SECRET-BODY')
        self.service.tools.adapter=adapter
        self.addCleanup(release.set)
        return entered,release

    def prepare_export(self, execution, private_reply=False, binding=None):
        context=dict(subject_binding=binding or self.pet,host_request_id='host-call-1',turn_id='turn-1')
        destination=self.good(self.call('tool.destinations.register',dict(**context,model=dict(provider='synthetic',model='offline-fixture',config_revision='config-v1',endpoint_identity='ab'*32),private_reply=private_reply),self.owner))
        return self.good(self.call('tool.result.export.prepare',dict(result_id=execution['result_id'],expected_result_revision=1,
                         **context,destination_ref=destination['destination_ref']),self.owner))

    def consume_params(self, export, **extra):
        return dict(export_id=export['export_id'],subject_binding=self.pet,host_request_id='host-call-1',turn_id='turn-1',
                    destination_ref=export['destination_ref'],config_revision='config-v1',endpoint_identity='ab'*32) | extra

    def confirm_export(self, export):
        return self.good(self.call('tool.result.export.confirm',dict(export_id=export['export_id'],expected_revision=export['revision'],confirmation_digest=export['confirmation_digest']),self.owner))

    def test_catalog_and_public_time(self):
        catalog=self.good(self.call('tool.catalog',{},self.pet))
        self.assertEqual(len(catalog['tools']),7)
        self.assertEqual(next(t for t in catalog['tools'] if t['tool_id']=='time.now')['data_boundary'],'public')
        for item in catalog['tools']:
            self.assertEqual(hashed({k:v for k,v in item.items() if k!='descriptor_hash'}),item['descriptor_hash'])
        result=self.run_tool('time.now')
        self.assertEqual(result['result']['unix_ms'],int(self.now*1000))
        self.assertFalse(result['local_only'])

    def test_encrypted_notes_persist_and_ordinary_body_is_withheld(self):
        created=self.run_tool('notes.create',dict(title='synthetic title',text='synthetic NOTE-PRIVATE'))
        self.assertEqual(created['state'],'succeeded')
        self.assertNotIn('NOTE-PRIVATE',json.dumps(created))
        body=self.body(created)
        self.assertEqual(body['text'],'synthetic NOTE-PRIVATE')
        self.bad(self.call('tool.result.read',dict(result_id=created['result_id']),self.pet),'PERMISSION_DENIED')
        self.assertNotIn('NOTE-PRIVATE',json.dumps(self.good(self.call('tool.history',{},self.pet))))
        self.service.close()
        self.assertNotEqual((self.directory/'memory.db').read_bytes()[:16],b'SQLite format 3\x00')
        self.assertNotIn(b'NOTE-PRIVATE',(self.directory/'memory.db').read_bytes())
        self.service=fixtures.CapabilityService(self.directory,clock=lambda:self.now)
        self.activate('a')
        self.owner=self.bind('owner:local',owner=True,management=True)
        self.pet=self.bind('pet:local',owner=True)
        listed=self.body(self.run_tool('notes.list'))
        self.assertEqual(listed['notes'][0]['note_id'],body['note_id'])
        self.assertEqual(self.body(self.run_tool('notes.read',dict(note_id=body['note_id'])))['text'],'synthetic NOTE-PRIVATE')

    def test_groups_public_fake_owner_and_management_routes_denied(self):
        for binding in (self.group1,self.group2,self.public):
            for op,params in [('tool.catalog',{}),('tool.propose',dict(tool_id='time.now',action='read',arguments={},idempotency_key='fake')),
                              ('tool.emergency.stop',{}),('tool.roots.list',{}),('tool.grants.list',{})]:
                self.bad(self.call(op,params,binding),'PERMISSION_DENIED')
        for binding in (self.pet,self.alice,self.bob):
            for op in ('tool.emergency.stop','tool.emergency.reset','tool.subjects','tool.grants.list','tool.roots.list'):
                self.bad(self.call(op,{},binding),'PERMISSION_DENIED')

    def test_owner_shared_memory_does_not_inherit_tool_grant(self):
        self.grant('notes.list',self.pet,uses=2)
        self.assertEqual(self.tool('notes.list')['state'],'authorized')
        shared=self.good(self.call('session.bind',dict(platform='qq',account_id='bot',conversation_id='alice',principal_id='alice',audience_scope='owner:local',is_owner=True,management=False)))['session_binding']
        for binding in (self.alice,self.bob,shared):
            request=self.tool('notes.list',binding=binding)
            self.assertEqual(request['state'],'awaiting_confirmation')
            self.bad(self.call('tool.execute',dict(execution_id=request['execution_id']),binding),'CONFIRMATION_REQUIRED')

    def test_cross_subject_character_status_cancel_execute_and_note_isolation(self):
        created=self.run_tool('notes.create',dict(title='synthetic',text='private'))
        note_id=self.body(created)['note_id']
        for op in ('tool.status','tool.cancel','tool.execute'):
            self.bad(self.call(op,dict(execution_id=created['execution_id']),self.bob),'PERMISSION_DENIED')
        self.bad(self.call('tool.propose',dict(tool_id='notes.read',action='read',arguments=dict(note_id=note_id),idempotency_key='x'),self.bob),'NOTE_NOT_FOUND')
        self.activate('b')
        owner_b=self.bind('owner:local',owner=True,management=True,character='b')
        self.bad(self.call('tool.status',dict(execution_id=created['execution_id']),owner_b,character='b'),'PERMISSION_DENIED')
        self.bad(self.call('tool.result.read',dict(result_id=created['result_id']),owner_b,character='b'),'PERMISSION_DENIED')

    def test_management_confirms_but_cannot_execute_for_another_subject(self):
        request=self.tool('notes.list')
        self.confirm(request)
        self.bad(self.call('tool.execute',dict(execution_id=request['execution_id']),self.owner),'PERMISSION_DENIED')
        self.assertEqual(self.good(self.call('tool.execute',dict(execution_id=request['execution_id']),self.pet))['state'],'succeeded')

    def test_idempotency_and_unknown_schema(self):
        first=self.tool('notes.create',dict(title='t',text='synthetic'),key='same')
        self.assertFalse(first['duplicate'])
        duplicate=self.tool('notes.create',dict(title='t',text='synthetic'),key='same')
        self.assertTrue(duplicate['duplicate'])
        self.assertEqual(duplicate['execution_id'],first['execution_id'])
        self.bad(self.call('tool.propose',dict(tool_id='notes.create',action='create',arguments=dict(title='t',text='changed'),idempotency_key='same'),self.pet),'IDEMPOTENCY_CONFLICT')
        for tool,action,args in [('shell','run',{}),('time.now','read',dict(command='anything')),('notes.create','create',dict(title='t',text='x',path='C:\\x'))]:
            self.bad(self.call('tool.propose',dict(tool_id=tool,action=action,arguments=args,idempotency_key='bad'),self.pet),'TOOL_NOT_ALLOWED' if tool=='shell' else 'INVALID_REQUEST')
        self.confirm(first)
        one=self.good(self.call('tool.execute',dict(execution_id=first['execution_id']),self.pet))
        two=self.good(self.call('tool.execute',dict(execution_id=first['execution_id']),self.pet))
        self.assertEqual(one,two)
        self.assertEqual(self.service.db.execute('SELECT count(*) FROM tool_notes').fetchone()[0],1)

    def test_proposal_duplicate_survives_restart_rebinding_and_auto_write_off(self):
        first=self.tool('time.now',key='trusted-event-stable-hash')
        self.assertFalse(first['duplicate'])
        self.good(self.call('tool.execute',dict(execution_id=first['execution_id']),self.pet))
        self.good(self.call('memory.settings',dict(auto_write=False),self.owner))
        rebound=self.bind('pet:local',owner=True)
        history=self.good(self.call('tool.history',dict(idempotency_key='trusted-event-stable-hash',limit=1),rebound))
        self.assertEqual([row['execution_id'] for row in history['executions']],[first['execution_id']])
        self.service.close()
        self.service=fixtures.CapabilityService(self.directory,clock=lambda:self.now)
        self.activate('a');self.owner=self.bind('owner:local',owner=True,management=True);self.pet=self.bind('pet:local',owner=True)
        repeated=self.tool('time.now',key='trusted-event-stable-hash')
        self.assertTrue(repeated['duplicate'])
        self.assertEqual(repeated['execution_id'],first['execution_id'])
        self.assertEqual(repeated['state'],'succeeded')
        self.assertEqual(self.service.db.execute('SELECT count(*) FROM tool_executions').fetchone()[0],1)
        self.assertFalse(self.good(self.call('memory.settings',{},self.owner))['auto_write'])
        history=self.good(self.call('tool.history',dict(idempotency_key='trusted-event-stable-hash',limit=1),self.pet))
        self.assertEqual([row['execution_id'] for row in history['executions']],[first['execution_id']])

    def test_history_exact_key_is_subject_scoped_and_never_reads_body(self):
        request=self.tool('notes.create',dict(title='fixture',text='synthetic HISTORY-PRIVATE'),key='exact-history-key')
        self.confirm(request)
        self.good(self.call('tool.execute',dict(execution_id=request['execution_id']),self.pet))
        time_request=self.tool('time.now',key='exact-history-time')
        self.good(self.call('tool.execute',dict(execution_id=time_request['execution_id']),self.pet))
        for binding in (self.bob,self.owner):
            self.assertEqual(self.good(self.call('tool.history',dict(idempotency_key='exact-history-key',limit=1),binding))['executions'],[])
        own=self.good(self.call('tool.history',dict(idempotency_key='exact-history-key',limit=1),self.pet))
        self.assertEqual([row['execution_id'] for row in own['executions']],[request['execution_id']])
        self.assertNotIn('HISTORY-PRIVATE',json.dumps(own))
        self.assertNotIn('arguments',own['executions'][0])
        self.assertEqual(self.good(self.call('tool.history',dict(idempotency_key='exact-history-%',limit=1),self.pet))['executions'],[])
        for invalid in ('',123,'x'*201):
            self.bad(self.call('tool.history',dict(idempotency_key=invalid,limit=1),self.pet),'INVALID_REQUEST')
        statements=[]
        self.service.db.set_trace_callback(statements.append)
        try:
            filtered=self.good(self.call('tool.history',dict(idempotency_key='exact-history-time',limit=1),self.pet))
        finally:
            self.service.db.set_trace_callback(None)
        self.assertNotIn('result',filtered['executions'][0])
        self.assertFalse(any('SELECT body FROM tool_results' in sql for sql in statements))
        self.assertFalse(any('SELECT * FROM tool_executions' in sql for sql in statements))
        admin=self.tool('notes.create',dict(title='fixture',text='synthetic ADMIN-HISTORY-PRIVATE'),key='exact-history-key',binding=self.owner)
        filtered_admin=self.good(self.call('tool.history',dict(idempotency_key='exact-history-key',limit=1),self.owner))
        self.assertEqual([row['execution_id'] for row in filtered_admin['executions']],[admin['execution_id']])
        self.assertNotIn('ADMIN-HISTORY-PRIVATE',json.dumps(filtered_admin))
        self.activate('b');owner_b=self.bind('owner:local',owner=True,management=True,character='b')
        self.assertEqual(self.good(self.call('tool.history',dict(idempotency_key='exact-history-key',limit=1),owner_b,character='b'))['executions'],[])

    def test_confirm_digest_revision_and_expiry(self):
        request=self.tool('notes.list')
        self.bad(self.call('tool.confirm',dict(execution_id=request['execution_id'],expected_revision=99,confirmation_digest=request['confirmation_digest']),self.owner),'VERSION_CONFLICT')
        self.bad(self.call('tool.confirm',dict(execution_id=request['execution_id'],expected_revision=1,confirmation_digest='bad'),self.owner),'VERSION_CONFLICT')
        self.confirm(request)
        current=self.good(self.call('tool.status',dict(execution_id=request['execution_id']),self.pet))
        self.bad(self.call('tool.confirm',dict(execution_id=request['execution_id'],expected_revision=current['revision'],confirmation_digest=current['confirmation_digest']),self.owner),'INVALID_STATE')
        self.now+=61
        self.bad(self.call('tool.execute',dict(execution_id=request['execution_id']),self.pet),'CONFIRMATION_REQUIRED')

    def test_descriptor_or_arguments_changed_after_confirmation(self):
        request=self.tool('notes.list')
        self.confirm(request)
        descriptor=self.service.tools.descriptors['notes.list']
        descriptor['timeout_ms']+=1
        self.bad(self.call('tool.execute',dict(execution_id=request['execution_id']),self.pet),'DESCRIPTOR_CHANGED')
        descriptor['timeout_ms']-=1
        self.service.db.execute('UPDATE tool_executions SET arguments=? WHERE id=?',('{"limit":1}',request['execution_id']))
        self.bad(self.call('tool.execute',dict(execution_id=request['execution_id']),self.pet),'ARGUMENTS_CHANGED')

    def test_last_grant_use_two_authorized_proposals(self):
        grant=self.grant('files.read_text')
        first=self.tool('files.read_text',self.file_args())
        second=self.tool('files.read_text',self.file_args())
        self.assertEqual(first['state'],second['state'])
        self.assertEqual(first['state'],'authorized')
        entered,release=self.slow()
        self.good(self.call('tool.execute',dict(execution_id=first['execution_id']),self.pet))
        self.assertTrue(entered.wait(1))
        self.bad(self.call('tool.execute',dict(execution_id=second['execution_id']),self.pet),'CONFIRMATION_REQUIRED')
        self.assertEqual(self.service.db.execute('SELECT remaining FROM tool_grants WHERE id=?',(grant['grant_id'],)).fetchone()[0],0)
        release.set()
        self.wait(first['execution_id'])

    def test_running_persistence_failure_never_calls_external_adapter(self):
        grant=self.grant('files.read_text')
        request=self.tool('files.read_text',self.file_args())
        calls=[]
        self.service.tools.adapter=lambda job,cancel:calls.append(job)
        self.service.db.execute("CREATE TEMP TRIGGER reject_running BEFORE UPDATE ON tool_executions WHEN NEW.state='running' BEGIN SELECT RAISE(ABORT,'synthetic disk error'); END")
        self.bad(self.call('tool.execute',dict(execution_id=request['execution_id']),self.pet),'SERVICE_UNAVAILABLE')
        self.assertEqual(calls,[])
        self.assertEqual(self.service.db.execute('SELECT remaining FROM tool_grants WHERE id=?',(grant['grant_id'],)).fetchone()[0],1)
        self.assertEqual(self.good(self.call('tool.status',dict(execution_id=request['execution_id']),self.pet))['state'],'authorized')

    def test_running_commit_failure_rolls_back_grant_and_never_launches(self):
        grant=self.grant('files.read_text')
        request=self.tool('files.read_text',self.file_args())
        calls=[]
        self.service.tools.adapter=lambda job,cancel:calls.append(job)
        from sqlcipher3 import dbapi2
        def authorizer(action,arg1,arg2,database,source):
            return dbapi2.SQLITE_DENY if action==dbapi2.SQLITE_TRANSACTION and arg1=='COMMIT' else dbapi2.SQLITE_OK
        self.service.db.set_authorizer(authorizer)
        try:
            with patch.object(self.service,'poll'):
                self.bad(self.call('tool.execute',dict(execution_id=request['execution_id']),self.pet),'SERVICE_UNAVAILABLE')
        finally:
            self.service.db.set_authorizer(None)
        self.assertEqual(calls,[])
        self.assertEqual(self.service.db.execute('SELECT remaining FROM tool_grants WHERE id=?',(grant['grant_id'],)).fetchone()[0],1)
        self.assertEqual(self.good(self.call('tool.status',dict(execution_id=request['execution_id']),self.pet))['state'],'authorized')

    def test_external_adapter_observes_committed_running_and_consumed_grant(self):
        grant=self.grant('files.read_text')
        request=self.tool('files.read_text',self.file_args())
        observed=[]
        def adapter(job,cancel):
            from sqlcipher3 import dbapi2
            connection=dbapi2.connect(str(self.directory/'memory.db'))
            try:
                connection.execute(f'PRAGMA key="x\'{fixtures.KEY}\'"')
                observed.append(connection.execute('SELECT state FROM tool_executions WHERE id=?',(request['execution_id'],)).fetchone()[0])
                observed.append(connection.execute('SELECT remaining FROM tool_grants WHERE id=?',(grant['grant_id'],)).fetchone()[0])
            finally:
                connection.close()
            return dict(text='fixture')
        self.service.tools.adapter=adapter
        self.good(self.call('tool.execute',dict(execution_id=request['execution_id']),self.pet))
        self.assertEqual(self.wait(request['execution_id'])['state'],'succeeded')
        self.assertEqual(observed,['running',0])

    def test_real_handle_reads_list_limits_and_hardlinks(self):
        result=self.run_tool('files.read_text',self.file_args())
        self.assertEqual(self.body(result)['text'],'synthetic LOCAL-BODY must stay private')
        self.assertNotIn('LOCAL-BODY',json.dumps(result))
        self.assertEqual(self.body(self.run_tool('files.list',self.file_args('')))['entries'][0]['name'],'sample.txt')
        hard=self.files/'hard.txt'
        os.link(self.file,hard)
        self.bad(self.call('tool.propose',dict(tool_id='files.read_text',action='read',arguments=self.file_args('hard.txt'),idempotency_key='hard'),self.pet),'PATH_DENIED')
        hard.unlink()  # Disposable fixture only.
        self.file.write_bytes(b'x'*65537)
        oversized=self.run_tool('files.read_text',self.file_args())
        self.assertEqual(oversized['state'],'failed')
        self.assertEqual(oversized['error_code'],'OUTPUT_LIMIT')

    def test_path_escape_matrix(self):
        for relative in ('..\\outside.txt','/etc/passwd','C:\\secret','C:secret','\\\\server\\share','\\\\?\\C:\\secret','sample.txt:stream','folder\\..\\sample.txt','CON','a.','a\\','a//b','/','a/'*13+'b'):
            with self.subTest(relative=relative):
                self.bad(self.call('tool.propose',dict(tool_id='files.read_text',action='read',arguments=self.file_args(relative),idempotency_key='invalid'),self.pet),'PATH_DENIED')
        for path in (str(self.directory),str(self.directory.parent),r'\\server\share',r'C:relative'):
            self.bad(self.call('tool.roots.register',dict(path=path,label='bad'),self.owner),'PATH_DENIED')

    def test_confirmation_then_target_replaced(self):
        request=self.tool('files.read_text',self.file_args())
        self.confirm(request)
        self.file.rename(self.files/'old.txt')
        self.file.write_text('synthetic replacement',encoding='utf-8')
        self.bad(self.call('tool.execute',dict(execution_id=request['execution_id']),self.pet),'TARGET_CHANGED')

    def test_junction_escape_and_handle_pins_against_replace(self):
        target=self.files/'target'
        target.mkdir()
        link=self.files/'junction'
        created=subprocess.run(['cmd.exe','/d','/c','mklink','/J',str(link),str(target)],capture_output=True)
        self.assertEqual(created.returncode,0,'fixture junction creation failed')
        try:
            self.bad(self.call('tool.propose',dict(tool_id='files.list',action='list',arguments=self.file_args('junction'),idempotency_key='junction'),self.pet),'PATH_DENIED')
        finally:
            os.rmdir(link)  # Removes only the fixture junction itself, never recursively.
        with pinned_path(str(self.files),'sample.txt',False) as node:
            with self.assertRaises(OSError):
                self.file.rename(self.files/'replacement.txt')
            self.assertIn('LOCAL-BODY',node.read())

    def test_cancel_and_late_success_cannot_resurrect(self):
        entered,release=self.slow()
        request=self.tool('files.read_text',self.file_args())
        self.confirm(request)
        self.good(self.call('tool.execute',dict(execution_id=request['execution_id']),self.pet))
        self.assertTrue(entered.wait(1))
        stopped=self.good(self.call('tool.cancel',dict(execution_id=request['execution_id']),self.pet))
        self.assertEqual(stopped['state'],'unknown')
        release.set()
        time.sleep(.02)
        late=self.good(self.call('tool.status',dict(execution_id=request['execution_id']),self.pet))
        self.assertEqual(late['state'],'unknown')
        self.assertIsNone(late['result_id'])
        self.assertEqual(self.service.db.execute('SELECT count(*) FROM tool_results').fetchone()[0],0)

    def test_emergency_persistent_reset_does_not_revive(self):
        entered,release=self.slow()
        request=self.tool('files.read_text',self.file_args())
        self.confirm(request)
        self.good(self.call('tool.execute',dict(execution_id=request['execution_id']),self.pet))
        self.assertTrue(entered.wait(1))
        self.good(self.call('tool.emergency.stop',{},self.owner))
        release.set()
        self.service.close()
        self.service=fixtures.CapabilityService(self.directory,clock=lambda:self.now)
        self.activate('a')
        self.owner=self.bind('owner:local',owner=True,management=True)
        self.pet=self.bind('pet:local',owner=True)
        self.assertTrue(self.good(self.call('tool.emergency.status',{},self.owner))['closed'])
        self.bad(self.call('tool.propose',dict(tool_id='time.now',action='read',arguments={},idempotency_key='blocked'),self.pet),'TOOL_STOPPED')
        self.good(self.call('tool.emergency.reset',{},self.owner))
        self.assertEqual(self.good(self.call('tool.execute',dict(execution_id=request['execution_id']),self.pet))['state'],'unknown')
        self.assertIsNone(self.good(self.call('tool.status',dict(execution_id=request['execution_id']),self.pet))['result_id'])

    def test_timeout_and_late_completion(self):
        entered,release=self.slow()
        request=self.tool('files.read_text',self.file_args())
        self.confirm(request)
        self.good(self.call('tool.execute',dict(execution_id=request['execution_id']),self.pet))
        self.assertTrue(entered.wait(1))
        self.service.tools.jobs[request['execution_id']]['deadline']=time.monotonic()-1
        release.set()
        time.sleep(.02)
        state=self.good(self.call('tool.status',dict(execution_id=request['execution_id']),self.pet))
        self.assertEqual(state['state'],'unknown')
        self.assertEqual(state['error_code'],'TOOL_TIMEOUT')

    def test_role_retire_lock_and_revoke_cancel_inflight(self):
        for event in ('retire','lock','revoke'):
            with self.subTest(event=event):
                entered,release=self.slow()
                grant=self.grant('files.read_text')
                request=self.tool('files.read_text',self.file_args())
                self.good(self.call('tool.execute',dict(execution_id=request['execution_id']),self.pet))
                self.assertTrue(entered.wait(1))
                if event=='retire':
                    self.good(self.call('lifecycle.retire'))
                    self.activate('a')
                    self.owner=self.bind('owner:local',owner=True,management=True)
                    self.pet=self.bind('pet:local',owner=True)
                elif event=='lock':
                    self.lock='locked'
                    self.service.tools.next_lock_check=0
                    self.good(self.call('tool.emergency.status',{},self.owner))
                    self.bad(self.call('tool.propose',dict(tool_id='time.now',action='read',arguments={},idempotency_key='locked'),self.pet),'SESSION_LOCKED')
                    self.lock='unlocked'
                    self.service.tools.next_lock_check=0
                else:
                    self.good(self.call('tool.grants.revoke',dict(grant_id=grant['grant_id']),self.owner))
                release.set()
                time.sleep(.02)
                self.assertEqual(self.good(self.call('tool.status',dict(execution_id=request['execution_id']),self.pet))['state'],'unknown')

    def test_recover_preexisting_running_as_unknown_without_replay(self):
        request=self.tool('files.read_text',self.file_args())
        self.service.db.execute("UPDATE tool_executions SET state='running',revision=revision+1 WHERE id=?",(request['execution_id'],))
        self.service.store.close()  # Simulated abrupt authority loss: no broker close path.
        self.service=fixtures.CapabilityService(self.directory,clock=lambda:self.now)
        self.activate('a')
        self.owner=self.bind('owner:local',owner=True,management=True)
        self.pet=self.bind('pet:local',owner=True)
        calls=[]
        self.service.tools.adapter=lambda job,cancel:calls.append(job)
        state=self.good(self.call('tool.execute',dict(execution_id=request['execution_id']),self.pet))
        self.assertEqual(state['state'],'unknown')
        self.assertEqual(state['error_code'],'SERVICE_RESTARTED')
        self.assertEqual(calls,[])

    def test_adapter_error_does_not_echo_secret(self):
        def adapter(job,cancel):
            raise RuntimeError('synthetic API_KEY=DO_NOT_ECHO user file body')
        self.service.tools.adapter=adapter
        result=self.run_tool('files.read_text',self.file_args())
        self.assertEqual(result['state'],'failed')
        self.assertTrue(result['error'])
        self.assertTrue(result['hint'])
        self.assertNotIn('DO_NOT_ECHO',json.dumps(result))

    def test_fixed_explorer_adapter_arguments_without_launch(self):
        with patch('tool_broker.subprocess.Popen') as launch:
            launch.return_value.wait.return_value=0
            result=self.run_tool('local.open_directory',self.file_args(''))
        self.assertEqual(result['state'],'succeeded')
        args,kwargs=launch.call_args
        self.assertEqual(Path(args[0][0]).name.lower(),'explorer.exe')
        self.assertEqual(args[0][1],str(self.files))
        self.assertIs(kwargs['shell'],False)

    def test_export_exact_result_target_and_host_only_one_time_consumption(self):
        result=self.run_tool('notes.create',dict(title='t',text='synthetic EXPORT-ONLY'))
        export=self.prepare_export(result)
        params=self.consume_params(export)
        self.bad(self.call('tool.result.export.consume',params,self.owner),'CONFIRMATION_REQUIRED')
        self.bad(self.call('tool.result.export.confirm',dict(export_id=export['export_id'],expected_revision=1,confirmation_digest='wrong'),self.owner),'VERSION_CONFLICT')
        self.confirm_export(export)
        for binding in (self.pet,self.bob):
            self.bad(self.call('tool.result.export.consume',params,binding),'PERMISSION_DENIED')
        consumed=self.good(self.call('tool.result.export.consume',params,self.owner))
        self.assertEqual(consumed['body']['text'],'synthetic EXPORT-ONLY')
        self.assertEqual(consumed['descriptor']['model']['provider'],'synthetic')
        self.assertEqual(consumed['descriptor']['purposes'],['model_input'])
        self.assertFalse(consumed['memory_write'])
        self.assertFalse(consumed['delivery_confirmed'])
        self.assertNotIn('body',self.good(self.call('tool.result.export.validate',params,self.owner)))
        self.bad(self.call('tool.result.export.consume',params,self.owner),'EXPORT_ALREADY_CONSUMED')
        newer=self.prepare_export(result)
        self.assertIn(export['export_id'],newer['prior_unconfirmed_exports'])
        listed=self.good(self.call('tool.result.export.list',dict(limit=1),self.owner))['exports'][0]
        self.assertIn(export['export_id'],listed['prior_unconfirmed_exports'])
        self.assertEqual(listed['prior_unconfirmed_count'],1)

    def test_export_stale_memory_and_cross_ttl_then_receipt(self):
        result=self.run_tool('notes.create',dict(title='t',text='synthetic'))
        export=self.prepare_export(result)
        self.confirm_export(export)
        self.good(self.ingest(self.pet,'synthetic-change','synthetic memory change'))
        self.bad(self.call('tool.result.export.consume',self.consume_params(export),self.owner),'STALE_EXPORT')
        export=self.prepare_export(result)
        self.confirm_export(export)
        consumed=self.good(self.call('tool.result.export.consume',self.consume_params(export),self.owner))
        self.assertEqual(consumed['state'],'consumed')
        self.now+=61
        self.bad(self.call('tool.result.export.validate',self.consume_params(export),self.owner),'STALE_EXPORT')
        receipt=dict(export_id=export['export_id'],subject_binding=self.pet,host_request_id='host-call-1',turn_id='turn-1',outcome='unknown')
        self.assertEqual(self.good(self.call('tool.result.export.finalize',receipt,self.owner))['state'],'unknown')
        self.bad(self.call('tool.result.export.finalize',receipt|dict(outcome='sent'),self.owner),'INVALID_STATE')
        self.assertNotIn('body',self.good(self.call('tool.result.export.status',dict(export_id=export['export_id']),self.owner)))

    def test_export_confirmation_rejects_replacement_fields_and_policy_reset(self):
        result=self.run_tool('notes.list')
        export=self.prepare_export(result)
        self.bad(self.call('tool.result.export.confirm',dict(export_id=export['export_id'],expected_revision=1,confirmation_digest=export['confirmation_digest'],destination_ref='replacement'),self.owner),'INVALID_REQUEST')
        self.confirm_export(export)
        self.good(self.call('tool.emergency.stop',{},self.owner))
        self.bad(self.call('tool.result.export.consume',self.consume_params(export),self.owner),'TOOL_STOPPED')
        self.good(self.call('tool.emergency.reset',{},self.owner))
        self.bad(self.call('tool.result.export.consume',self.consume_params(export),self.owner),'STALE_RESULT')

    def test_export_endpoint_change_and_fallback_invalidates_selection(self):
        result=self.run_tool('notes.list')
        export=self.prepare_export(result)
        self.confirm_export(export)
        for extra in (dict(endpoint_identity='cd'*32),dict(config_revision='config-v2'),dict(destination_ref='other')):
            self.bad(self.call('tool.result.export.consume',self.consume_params(export,**extra),self.owner),'STALE_DESTINATION')
        self.good(self.call('tool.destinations.register',dict(subject_binding=self.pet,host_request_id='host-call-1',turn_id='turn-1',
            model=dict(provider='synthetic',model='offline-fixture',config_revision='config-v2',endpoint_identity='cd'*32),private_reply=False),self.owner))
        self.bad(self.call('tool.result.export.consume',self.consume_params(export),self.owner),'STALE_DESTINATION')

    def test_export_shared_owner_qq_and_pet_remain_distinct(self):
        pet=self.good(self.call('session.bind',dict(platform='pet',account_id='pet',conversation_id='local',principal_id='owner',audience_scope='owner:local',is_owner=True,management=False)))['session_binding']
        qq=self.good(self.call('session.bind',dict(platform='qq',account_id='bot',conversation_id='owner',principal_id='owner',audience_scope='owner:local',is_owner=True,management=False)))['session_binding']
        result=self.run_tool('notes.list',binding=pet)
        self.pet=pet
        export=self.prepare_export(result,private_reply=True)
        self.confirm_export(export)
        self.bad(self.call('tool.result.export.consume',self.consume_params(export,subject_binding=qq),self.owner),'PERMISSION_DENIED')
        self.bad(self.call('tool.result.export.consume',self.consume_params(export,turn_id='other-turn'),self.owner),'PERMISSION_DENIED')
        consumed=self.good(self.call('tool.result.export.consume',self.consume_params(export),self.owner))
        self.assertEqual(consumed['descriptor']['purposes'],['model_input','private_reply'])
        self.assertEqual(consumed['descriptor']['private_destination']['platform'],'pet')
        self.assertEqual(consumed['descriptor']['private_destination']['account'],'pet')
        self.assertFalse(consumed['descriptor']['memory_write'])

    def test_export_commit_response_lost_restart_cannot_read_body_twice(self):
        result=self.run_tool('notes.list')
        export=self.prepare_export(result)
        self.confirm_export(export)
        params=self.consume_params(export)
        self.good(self.call('tool.result.export.consume',params,self.owner))
        self.service.store.close()  # Crash after consume COMMIT, before hypothetical delivery receipt.
        self.service=fixtures.CapabilityService(self.directory,clock=lambda:self.now)
        self.activate('a')
        self.owner=self.bind('owner:local',owner=True,management=True)
        self.pet=self.bind('pet:local',owner=True)
        status=self.good(self.call('tool.result.export.status',dict(export_id=export['export_id']),self.owner))
        self.assertEqual(status['state'],'consumed')
        self.assertFalse(status['delivery_confirmed'])
        self.bad(self.call('tool.result.export.consume',params,self.owner),'EXPORT_ALREADY_CONSUMED')

    def test_export_consume_commit_failure_does_not_return_body(self):
        result=self.run_tool('notes.list')
        export=self.prepare_export(result)
        self.confirm_export(export)
        self.service.db.execute("CREATE TEMP TRIGGER reject_consume BEFORE UPDATE ON tool_exports WHEN NEW.state='consumed' BEGIN SELECT RAISE(ABORT,'synthetic disk error'); END")
        response=self.call('tool.result.export.consume',self.consume_params(export),self.owner)
        self.bad(response,'SERVICE_UNAVAILABLE')
        self.assertNotIn('body',json.dumps(response))
        self.assertEqual(self.good(self.call('tool.result.export.status',dict(export_id=export['export_id']),self.owner))['state'],'confirmed')

    def test_export_management_list_is_body_free_and_role_scoped(self):
        result=self.run_tool('notes.create',dict(title='t',text='synthetic LIST-PRIVATE'))
        export=self.prepare_export(result)
        self.bad(self.call('tool.result.export.list',{},self.pet),'PERMISSION_DENIED')
        self.bad(self.call('tool.result.export.list',dict(limit=51),self.owner),'INVALID_REQUEST')
        listed=self.good(self.call('tool.result.export.list',dict(limit=1),self.owner))
        self.assertEqual(listed['exports'][0]['confirmation_digest'],export['confirmation_digest'])
        self.assertNotIn('LIST-PRIVATE',json.dumps(listed))
        self.activate('b')
        owner_b=self.bind('owner:local',owner=True,management=True,character='b')
        self.assertEqual(self.good(self.call('tool.result.export.list',{},owner_b,character='b'))['exports'],[])

    def test_bounded_background_slots_remain_responsive(self):
        entered,release=self.slow()
        requests=[]
        for _ in range(3):
            request=self.tool('files.read_text',self.file_args())
            self.confirm(request)
            requests.append(request)
        for request in requests[:2]:
            self.good(self.call('tool.execute',dict(execution_id=request['execution_id']),self.pet))
        self.assertTrue(entered.wait(1))
        self.bad(self.call('tool.execute',dict(execution_id=requests[2]['execution_id']),self.pet),'TOOL_BUSY')
        self.good(self.call('tool.emergency.stop',{},self.owner))
        for request in requests[:2]:
            self.assertEqual(self.good(self.call('tool.status',dict(execution_id=request['execution_id']),self.pet))['state'],'unknown')
        release.set()

    def test_unknown_lock_detection_is_fail_closed(self):
        self.lock='not_verified'
        self.service.tools.next_lock_check=0
        response=self.call('tool.propose',dict(tool_id='time.now',action='read',arguments={},idempotency_key='lock-unknown'),self.pet)
        self.bad(response,'LOCK_NOT_VERIFIED')
        self.assertEqual(self.good(self.call('tool.emergency.status',{},self.owner))['lockscreen_live_test'],'NOT_VERIFIED')

    def test_directory_entry_count_is_bounded(self):
        for index in range(200):
            (self.files/f'entry-{index}.txt').write_text('synthetic',encoding='utf-8')
        result=self.run_tool('files.list',self.file_args(''))
        self.assertEqual(result['state'],'failed')
        self.assertEqual(result['error_code'],'OUTPUT_LIMIT')

    def test_root_revoke_rejects_old_export_and_pending_execution(self):
        result=self.run_tool('files.read_text',self.file_args())
        export=self.prepare_export(result)
        self.confirm_export(export)
        self.good(self.call('tool.roots.revoke',dict(root_id=self.root_id),self.owner))
        self.bad(self.call('tool.result.export.consume',self.consume_params(export),self.owner),'STALE_RESULT')
        self.bad(self.call('tool.propose',dict(tool_id='files.list',action='list',arguments=self.file_args(''),idempotency_key='revoked'),self.pet),'ROOT_REVOKED')

    def test_real_jsonl_transport_cancel_and_parent_exit_are_responsive(self):
        # Adapter replacement exists only in this synthetic child process, never production options.
        code="""import sys
sys.path.insert(0,sys.argv.pop(1))
import tool_broker
tool_broker.lockscreen_state=lambda:'unlocked'
def synthetic_adapter(job,cancel):
    cancel.wait(5)
    return {'text':'synthetic transport PRIVATE-BODY'}
tool_broker.ToolBroker.external_adapter=staticmethod(synthetic_adapter)
from server import main
main()
"""
        import queue
        responses=queue.Queue()
        data=self.directory/'transport-data'
        process=subprocess.Popen([sys.executable,'-u','-c',code,str(ROOT/'services/local-capabilities'),'--data-dir',str(data)],
                                 stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,encoding='utf-8')
        def reader():
            for line in process.stdout:
                responses.put(json.loads(line))
        threading.Thread(target=reader,daemon=True).start()
        epoch=None
        def send(op,params=None,binding=None):
            request=dict(protocol_version=1,request_id='transport',op=op,params=params or {},character_id='transport',character_epoch=epoch,session_binding=binding)
            process.stdin.write(json.dumps(request)+'\n')
            process.stdin.flush()
            result=responses.get(timeout=2)
            self.assertTrue(result['ok'],result)
            return result['result']
        try:
            epoch=send('character.activate',dict(character_id='transport'))['character_epoch']
            owner=send('session.bind',dict(platform='local',account_id='test',conversation_id='local',principal_id='owner',audience_scope='owner:local',is_owner=True,management=True))['session_binding']
            pet=send('session.bind',dict(platform='pet',account_id='test',conversation_id='local',principal_id='owner',audience_scope='pet:local',is_owner=True,management=False))['session_binding']
            root=send('tool.roots.register',dict(path=str(self.files),label='synthetic transport'),owner)['root_id']
            def launch(key):
                request=send('tool.propose',dict(tool_id='files.read_text',action='read',arguments=dict(root_id=root,relative_path='sample.txt'),idempotency_key=key),pet)
                send('tool.confirm',dict(execution_id=request['execution_id'],expected_revision=request['revision'],confirmation_digest=request['confirmation_digest']),owner)
                started=time.monotonic()
                result=send('tool.execute',dict(execution_id=request['execution_id']),pet)
                self.assertEqual(result['state'],'running')
                self.assertLess(time.monotonic()-started,1)
                return request
            request=launch('cancel')
            self.assertEqual(send('tool.cancel',dict(execution_id=request['execution_id']),pet)['state'],'unknown')
            self.assertNotIn('PRIVATE-BODY',json.dumps(send('tool.status',dict(execution_id=request['execution_id']),pet)))
            pending=launch('parent-exit')
            process.stdin.close()
            process.wait(timeout=2)
            self.assertEqual(process.returncode,0)
            self.assertEqual(process.stderr.read(),'')
            restarted=fixtures.CapabilityService(data,clock=lambda:self.now)
            try:
                row=restarted.db.execute('SELECT state,error_code FROM tool_executions WHERE id=?',(pending['execution_id'],)).fetchone()
                self.assertEqual(tuple(row),('unknown','PARENT_EXITED'))
            finally:
                restarted.close()
        finally:
            if process.poll() is None:
                process.stdin.close()
                process.wait(timeout=3)
            process.stdout.close()
            process.stderr.close()

    @staticmethod
    def deny_commit(action,arg1,arg2,database,source):
        from sqlcipher3 import dbapi2
        return dbapi2.SQLITE_DENY if action==dbapi2.SQLITE_TRANSACTION and arg1=='COMMIT' else dbapi2.SQLITE_OK

    def test_poll_commit_failure_locks_exports_until_explicit_restart(self):
        result=self.run_tool('notes.create',dict(title='fixture',text='synthetic POLL-PRIVATE-BODY'))
        export=self.prepare_export(result)
        self.confirm_export(export)
        generation=self.service.tools.policy()['generation']
        self.lock='locked'
        self.service.tools.next_lock_check=0
        self.service.db.set_authorizer(self.deny_commit)
        try:
            response=self.call('tool.emergency.status',{},self.owner)
            self.bad(response,'SERVICE_UNAVAILABLE')
        finally:
            self.service.db.set_authorizer(None)
        # Failed DB publication cannot pretend the lock transition already committed.
        self.assertEqual(self.service.tools.lock_state,'unlocked')
        self.assertEqual(self.service.tools.next_lock_check,0)
        self.lock='unlocked'
        status=self.good(self.call('tool.emergency.status',{},self.owner))
        self.assertTrue(status['closed'])
        self.assertTrue(status['persistence_fault'])
        self.assertGreater(status['policy_generation'],generation)
        self.bad(self.call('tool.result.export.consume',self.consume_params(export),self.owner),'TOOL_PERSISTENCE_FAULT')
        self.bad(self.call('tool.result.read',dict(result_id=result['result_id']),self.owner),'TOOL_PERSISTENCE_FAULT')
        self.bad(self.call('tool.emergency.reset',{},self.owner),'TOOL_PERSISTENCE_FAULT')
        self.service.close()
        self.service=fixtures.CapabilityService(self.directory,clock=lambda:self.now)
        self.activate('a')
        self.owner=self.bind('owner:local',owner=True,management=True)
        self.pet=self.bind('pet:local',owner=True)
        self.assertTrue(self.good(self.call('tool.emergency.status',{},self.owner))['closed'])
        self.good(self.call('tool.emergency.reset',{},self.owner))
        response=self.call('tool.result.export.consume',self.consume_params(export),self.owner)
        self.assertFalse(response['ok'])
        self.assertNotIn('POLL-PRIVATE-BODY',json.dumps(response))

    def test_poll_commit_failure_retains_completion_until_unknown_is_durable(self):
        entered,release=self.slow()
        request=self.tool('files.read_text',self.file_args())
        self.confirm(request)
        self.good(self.call('tool.execute',dict(execution_id=request['execution_id']),self.pet))
        self.assertTrue(entered.wait(1))
        release.set()
        deadline=time.monotonic()+2
        while self.service.tools.completed.empty() and time.monotonic()<deadline:
            time.sleep(.005)
        self.assertFalse(self.service.tools.completed.empty())
        self.service.db.set_authorizer(self.deny_commit)
        try:
            self.bad(self.call('tool.status',dict(execution_id=request['execution_id']),self.pet),'SERVICE_UNAVAILABLE')
        finally:
            self.service.db.set_authorizer(None)
        self.assertIn(request['execution_id'],self.service.tools.jobs)
        self.assertEqual(self.service.tools.completed.qsize(),1)
        self.assertTrue(self.service.tools.jobs[request['execution_id']]['cancel'].is_set())
        result=self.good(self.call('tool.status',dict(execution_id=request['execution_id']),self.pet))
        self.assertEqual(result['state'],'unknown')
        self.assertEqual(result['error_code'],'TOOL_PERSISTENCE_FAULT')
        self.assertIsNone(result['result_id'])
        self.assertNotIn('SECRET-BODY',json.dumps(result))
        self.assertNotIn(request['execution_id'],self.service.tools.jobs)
        self.assertTrue(self.service.tools.completed.empty())
        self.assertEqual(self.service.db.execute("SELECT count(*) FROM tool_executions WHERE state='running'").fetchone()[0],0)
        self.assertEqual(self.service.db.execute('SELECT count(*) FROM tool_results').fetchone()[0],0)

    def test_idle_poll_commit_and_rollback_failure_still_cancels_before_cleanup(self):
        entered,release=self.slow()
        request=self.tool('files.read_text',self.file_args())
        self.confirm(request)
        self.good(self.call('tool.execute',dict(execution_id=request['execution_id']),self.pet))
        self.assertTrue(entered.wait(1))
        from sqlcipher3 import dbapi2
        from storage import ServiceError
        def deny_cleanup(action,arg1,arg2,database,source):
            return dbapi2.SQLITE_DENY if action==dbapi2.SQLITE_TRANSACTION and arg1 in ('COMMIT','ROLLBACK') else dbapi2.SQLITE_OK
        self.lock='locked'
        self.service.tools.next_lock_check=0
        self.service.db.set_authorizer(deny_cleanup)
        try:
            with self.assertRaises(ServiceError) as caught:
                self.service.poll()  # Same authority path used by server idle polling.
            self.assertEqual(caught.exception.code,'SERVICE_UNAVAILABLE')
            self.assertTrue(caught.exception.hint)
            self.assertTrue(self.service.tools.persistence_fault)
            self.assertTrue(self.service.tools.jobs[request['execution_id']]['cancel'].is_set())
            self.assertTrue(self.service.db.in_transaction)
            with self.assertRaises(ServiceError) as blocked:
                self.service.tools.ready(self.service.bindings[self.pet])
            self.assertEqual(blocked.exception.code,'TOOL_PERSISTENCE_FAULT')
            self.bad(self.call('tool.execute',dict(execution_id=request['execution_id']),self.pet),'SERVICE_UNAVAILABLE')
        finally:
            self.service.db.set_authorizer(None)
        self.lock='unlocked'
        release.set()
        status=self.good(self.call('tool.status',dict(execution_id=request['execution_id']),self.pet))
        self.assertEqual(status['state'],'unknown')
        self.assertEqual(status['error_code'],'TOOL_PERSISTENCE_FAULT')
        self.assertFalse(self.service.db.in_transaction)
        self.assertTrue(self.good(self.call('tool.emergency.status',{},self.owner))['closed'])


if __name__=='__main__':
    unittest.main(verbosity=2)
