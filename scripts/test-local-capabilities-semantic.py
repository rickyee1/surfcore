"""Isolated semantic authority checks and real offline CPU model acceptance evidence."""
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
spec = importlib.util.spec_from_file_location('semantic_service_fixtures',ROOT/'scripts/test-local-capabilities-service.py')
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
from semantic_model import DIMENSION, FINGERPRINT, MODEL_DIRECTORY, ModelFailure, verify_assets
from semantic_runtime import SemanticRuntime


def unit(index=0):
    vector = [0.0]*DIMENSION
    vector[index] = 1.0
    return vector


class FixtureRuntime:
    def __init__(self):
        self.calls,self.cancelled = [],0
        self.entered,self.release = threading.Event(),threading.Event()
        self.block = False
        self.failure = None
        self.invalid = False

    def encode(self, items, cancel):
        self.calls.append([dict(item) for item in items])
        self.entered.set()
        if self.block:
            self.release.wait(3)  # Deliberately ignores cancel to test late result rejection.
        if self.failure:
            raise self.failure
        if self.invalid:
            return [[1.0]]*len(items)
        return [unit(0 if '猫' in item['text'] or 'cat' in item['text'] else 1) for item in items]

    def cancel(self):
        self.cancelled += 1

    def close(self):
        self.cancel()


class Semantic(unittest.TestCase):
    for name in ('tearDown','call','good','bad','activate','bind','epoch','ingest'):
        locals()[name] = getattr(fixtures.Behavior,name)

    def setUp(self):
        self.lock = 'unlocked'
        self.lock_patch = patch('tool_broker.lockscreen_state',side_effect=lambda:self.lock)
        self.lock_patch.start()
        self.addCleanup(self.lock_patch.stop)
        fixtures.Behavior.setUp(self)
        self.runtime = FixtureRuntime()
        self.addCleanup(self.runtime.release.set)
        self.service.semantic.runtime = self.runtime

    def enable(self):
        self.good(self.call('memory.semantic.configure',dict(enabled=True),self.owner))

    def start(self, query='猫咪', binding=None, **extra):
        return self.good(self.call('memory.semantic.query.start',dict(query=query,**extra),binding or self.pet))

    def wait(self, job, binding=None, seconds=3):
        deadline = time.monotonic()+seconds
        while time.monotonic()<deadline:
            result = self.good(self.call('memory.semantic.job.status',dict(job_id=job['job_id']),binding or self.pet))
            if result['state'] in ('succeeded','failed','cancelled','stale'):
                return result
            time.sleep(.01)
        self.fail('semantic fixture deadline exceeded')

    def search(self, query='猫咪', binding=None, **extra):
        return self.wait(self.start(query,binding,**extra),binding)

    def vectors(self):
        return self.service.db.execute('SELECT count(*) FROM semantic_vectors').fetchone()[0]

    def test_disabled_idle_and_empty_query_preserve_recent_visibility_without_worker(self):
        own=self.good(self.ingest(self.pet,'recent-own','猫咪 private synthetic'))
        self.good(self.ingest(self.bob,'recent-foreign','Other private synthetic'))
        status=self.good(self.call('memory.semantic.status',{},self.pet))
        self.assertFalse(status['enabled'])
        self.assertEqual(status['eligible_count'],1)
        self.assertEqual(status['model_state'],'unloaded')
        self.bad(self.call('memory.semantic.query.start',dict(query='猫咪'),self.pet),'SEMANTIC_DISABLED')
        recent=self.start('')
        self.assertEqual(recent['state'],'succeeded')
        self.assertEqual(recent['search_mode'],'recent')
        self.assertEqual([r['id'] for r in recent['memories']],[own['id']])
        self.assertEqual(self.runtime.calls,[])

    def test_scopes_roles_groups_and_worker_input_are_filtered_first(self):
        texts=[(self.pet,'pet','猫 pet PRIVATE'),(self.bob,'bob','猫 bob HIDDEN'),(self.group1,'g1','猫 group ONE'),
               (self.group2,'g2','猫 group TWO'),(self.public,'pub','猫 PUBLIC')]
        for binding,event,body in texts:
            self.good(self.ingest(binding,event,body))
        self.activate('b')
        other=self.bind('owner:local',owner=True,management=True,character='b')
        self.good(self.ingest(other,'other-role','猫 OTHER-ROLE',character='b'))
        self.enable()
        result=self.search()
        self.assertEqual({r['statement'] for r in result['memories']},{'猫 pet PRIVATE','猫 PUBLIC'})
        seen=json.dumps(self.runtime.calls,ensure_ascii=False)
        self.assertNotIn('HIDDEN',seen);self.assertNotIn('group',seen);self.assertNotIn('OTHER-ROLE',seen)
        group=self.search(binding=self.group1)
        self.assertEqual({r['statement'] for r in group['memories']},{'猫 group ONE','猫 PUBLIC'})
        self.assertEqual(group['coverage']['eligible_count'],2)
        self.bad(self.call('memory.semantic.job.status',dict(job_id=result['job_id']),self.owner),'PERMISSION_DENIED')
        self.bad(self.call('memory.semantic.job.status',dict(job_id=result['job_id']),self.bob),'PERMISSION_DENIED')

    def test_management_default_session_explicit_character_and_quarantine(self):
        self.good(self.ingest(self.pet,'pet-only','猫 pet'))
        self.good(self.ingest(self.owner,'owner-only','猫 owner'))
        self.good(self.call('memory.migrate',dict(migration_id='legacy',records=[dict(source_event_id='q',text='猫 QUARANTINE')]),self.owner))
        self.enable()
        normal=self.search(binding=self.owner)
        self.assertEqual({r['statement'] for r in normal['memories']},{'猫 owner'})
        explicit=self.search(binding=self.owner,audience='character')
        self.assertEqual({r['statement'] for r in explicit['memories']},{'猫 owner','猫 pet'})
        self.assertNotIn('QUARANTINE',json.dumps(self.runtime.calls))
        self.bad(self.call('memory.semantic.query.start',dict(query='x',audience='character'),self.pet),'PERMISSION_DENIED')

    def test_recursive_hidden_projection_never_reaches_worker_or_metadata(self):
        parent=self.good(self.ingest(self.pet,'pet-parent','猫 SECRET-PARENT'))
        self.good(self.call('memory.ingest',dict(source_event_id='owner-child',text='猫 HIDDEN-CHILD',source_refs=[],derived_from=[parent['id']],expected_memory_epoch=self.epoch()),self.owner))
        shared=self.good(self.call('session.bind',dict(platform='qq',account_id='bot',conversation_id='alice',principal_id='alice',audience_scope='owner:local',is_owner=True,management=False)))['session_binding']
        self.enable()
        result=self.search(binding=shared)
        self.assertEqual(result['memories'],[])
        self.assertEqual(result['coverage']['eligible_count'],0)
        self.assertEqual(self.runtime.calls,[])

    def test_query_cache_new_episode_and_assertion_are_indexed_incrementally(self):
        first=self.good(self.ingest(self.pet,'first','猫 first'))
        self.enable()
        self.assertEqual(self.search()['state'],'succeeded')
        self.assertEqual(self.vectors(),1)
        self.search()
        self.assertEqual(len(self.runtime.calls[-1]),1)  # Query only; no document re-embedding.
        second=self.good(self.ingest(self.pet,'second','猫 new source'))
        self.assertEqual(self.vectors(),1)
        payload=dict(proposal_id='semantic-assertion',source_ids=[second['id']],source_revisions={second['id']:1},expected_memory_epoch=self.epoch(),
                     proposals=[dict(operation='add',kind='preference',statement='猫 preferred assertion')])
        self.good(self.call('memory.proposals.submit',payload,self.pet))
        assertion=self.good(self.call('memory.proposals.commit',dict(proposal_id='semantic-assertion',expected_memory_epoch=self.epoch()),self.pet))['ids'][0]
        result=self.search()
        self.assertIn(assertion,{r['id'] for r in result['memories']})
        self.assertEqual(self.vectors(),3)
        self.assertEqual(len(self.runtime.calls[-1]),3)  # Two new records plus query.

    def test_page64_is_stable_and_requires_first_epoch(self):
        for index in range(65):
            self.good(self.ingest(self.pet,f'page-{index}',f'猫 page {index}'))
        self.enable()
        first=self.search(limit=20)
        self.assertTrue(first['coverage']['has_more']);self.assertFalse(first['coverage']['complete'])
        self.assertEqual(first['coverage']['next_offset'],64)
        self.assertEqual(self.vectors(),64)
        self.bad(self.call('memory.semantic.query.start',dict(query='猫',offset=64),self.pet),'STALE_CONTEXT')
        second=self.search(offset=64,expected_memory_epoch=first['memory_epoch'])
        self.assertEqual(len(second['memories']),1)
        self.assertEqual(second['memories'][0]['statement'],'猫 page 0')
        self.assertFalse(second['coverage']['has_more'])
        self.good(self.ingest(self.pet,'page-new','猫 new'))
        self.bad(self.call('memory.semantic.query.start',dict(query='猫',offset=64,expected_memory_epoch=first['memory_epoch']),self.pet),'STALE_CONTEXT')

    def test_correct_and_suspend_invalidate_recursive_source_vectors(self):
        parent=self.good(self.ingest(self.pet,'ancestor','猫 old preference'))
        child=self.good(self.call('memory.ingest',dict(source_event_id='child',text='猫 derived',derived_from=[parent['id']],source_revisions={parent['id']:1},expected_memory_epoch=self.epoch()),self.pet))
        grandchild=self.good(self.call('memory.ingest',dict(source_event_id='grandchild',text='猫 grandchild',derived_from=[child['id']],source_revisions={child['id']:1},expected_memory_epoch=self.epoch()),self.pet))
        self.enable();self.search()
        self.assertEqual(self.vectors(),3)
        self.good(self.call('memory.correct',dict(id=parent['id'],expected_revision=1,statement='现在喜欢狗'),self.owner))
        self.assertEqual(self.vectors(),0)
        corrected=self.search('狗')
        self.assertEqual([r['statement'] for r in corrected['memories']],['现在喜欢狗'])
        self.good(self.call('memory.suspend',dict(id=parent['id'],expected_revision=2),self.owner))
        self.assertEqual(self.vectors(),0)
        self.assertEqual(self.search()['memories'],[])

    def test_deleted_during_slow_embedding_cannot_resurrect(self):
        source=self.good(self.ingest(self.pet,'delete-late','猫 DELETE-PRIVATE'))
        self.enable();self.runtime.block=True
        job=self.start()
        self.assertTrue(self.runtime.entered.wait(1))
        self.good(self.call('memory.delete',dict(id=source['id'],expected_revision=1),self.owner))
        self.runtime.release.set()
        time.sleep(.02)
        result=self.wait(job)
        self.assertEqual(result['state'],'stale')
        self.assertNotIn('DELETE-PRIVATE',json.dumps(result))
        self.assertEqual(self.vectors(),0)
        self.bad(self.ingest(self.pet,'delete-late','猫 DELETE-PRIVATE'),'DELETED_SOURCE')

    def test_correction_during_slow_embedding_and_cancel_late_result(self):
        source=self.good(self.ingest(self.pet,'correct-late','猫 old text'))
        self.enable();self.runtime.block=True
        job=self.start()
        self.assertTrue(self.runtime.entered.wait(1))
        self.good(self.call('memory.correct',dict(id=source['id'],expected_revision=1,statement='现在喜欢狗'),self.owner))
        self.runtime.release.set();time.sleep(.02)
        self.assertEqual(self.wait(job)['state'],'stale')
        self.assertEqual(self.vectors(),0)
        self.runtime.block=False
        self.assertEqual(self.search('狗')['memories'][0]['statement'],'现在喜欢狗')

    def test_cancel_and_tool_emergency_remain_responsive(self):
        self.good(self.ingest(self.pet,'slow','猫 slow'))
        self.enable();self.runtime.block=True
        job=self.start()
        self.assertTrue(self.runtime.entered.wait(1))
        self.bad(self.call('memory.semantic.query.start',dict(query='x'),self.pet),'SEMANTIC_BUSY')
        started=time.monotonic()
        self.good(self.call('tool.emergency.stop',{},self.owner))
        self.assertLess(time.monotonic()-started,.5)
        result=self.wait(job)
        self.assertEqual(result['state'],'cancelled')
        self.assertEqual(result['code'],'TOOL_STOPPED')
        self.runtime.release.set();time.sleep(.02)
        self.assertEqual(self.wait(job)['state'],'cancelled')
        self.assertEqual(self.vectors(),0)

    def test_explicit_cancel_disable_and_bad_vectors_are_visible(self):
        self.good(self.ingest(self.pet,'cancel','猫 cancel'))
        self.enable();self.runtime.block=True
        job=self.start()
        self.assertTrue(self.runtime.entered.wait(1))
        cancelled=self.good(self.call('memory.semantic.job.cancel',dict(job_id=job['job_id']),self.pet))
        self.assertEqual(cancelled['state'],'cancelled');self.assertTrue(cancelled['error']);self.assertTrue(cancelled['hint'])
        self.runtime.release.set();time.sleep(.02);self.wait(job)
        self.runtime.block=False;self.runtime.invalid=True
        bad=self.search()
        self.assertEqual(bad['code'],'SEMANTIC_INVALID_VECTOR');self.assertTrue(bad['hint'])
        self.assertEqual(self.vectors(),0)
        self.good(self.call('memory.semantic.configure',dict(enabled=False),self.owner))
        self.bad(self.call('memory.semantic.query.start',dict(query='猫'),self.pet),'SEMANTIC_DISABLED')

    def test_model_failure_is_structured_and_sanitized(self):
        self.good(self.ingest(self.pet,'failure','猫 body'))
        self.enable();self.runtime.failure=RuntimeError('synthetic token=DO_NOT_ECHO')
        result=self.search()
        self.assertEqual(result['state'],'failed')
        self.assertEqual(result['code'],'SEMANTIC_WORKER_FAILED')
        self.assertTrue(result['hint']);self.assertNotIn('DO_NOT_ECHO',json.dumps(result))

    def test_asset_and_dependency_codes_are_visible_without_fallback(self):
        self.good(self.ingest(self.pet,'asset-errors','猫 no fallback'))
        self.enable()
        for code in ('SEMANTIC_MODEL_MISSING','SEMANTIC_MODEL_CORRUPT','SEMANTIC_DEPENDENCY_MISSING'):
            with self.subTest(code=code):
                self.runtime.failure=ModelFailure(code)
                result=self.search()
                self.assertEqual(result['state'],'failed');self.assertEqual(result['code'],code)
                self.assertTrue(result['error']);self.assertTrue(result['hint'])
        self.assertEqual(self.vectors(),0)

    def test_timeout_and_session_lock_discard_late_vectors(self):
        self.good(self.ingest(self.pet,'timeout','猫 timeout'))
        self.enable();self.runtime.block=True
        job=self.start()
        self.assertTrue(self.runtime.entered.wait(1))
        self.service.semantic.jobs[job['job_id']]['deadline']=time.monotonic()-1
        self.assertEqual(self.wait(job)['code'],'SEMANTIC_TIMEOUT')
        self.runtime.release.set();time.sleep(.02);self.wait(job)
        self.runtime=FixtureRuntime();self.addCleanup(self.runtime.release.set)
        self.service.semantic.runtime=self.runtime;self.runtime.block=True
        job=self.start();self.assertTrue(self.runtime.entered.wait(1))
        self.lock='locked';self.service.tools.next_lock_check=0
        self.assertEqual(self.wait(job)['code'],'SESSION_LOCKED')
        self.runtime.release.set()
        self.assertEqual(self.vectors(),0)

    def test_lifecycle_retire_restart_and_cache_reuse(self):
        self.good(self.ingest(self.pet,'restart','猫 survives restart'))
        self.enable();first=self.search()
        self.assertEqual(self.vectors(),1)
        self.runtime.block=True
        job=self.start();self.assertTrue(self.runtime.entered.wait(1))
        self.good(self.call('lifecycle.retire'))
        self.runtime.release.set()
        self.service.close()
        self.service=fixtures.CapabilityService(self.directory,clock=lambda:self.now)
        self.activate('a');self.owner=self.bind('owner:local',owner=True,management=True);self.pet=self.bind('pet:local',owner=True)
        self.runtime=FixtureRuntime();self.service.semantic.runtime=self.runtime
        self.bad(self.call('memory.semantic.job.status',dict(job_id=job['job_id']),self.pet),'PERMISSION_DENIED')
        result=self.search()
        self.assertEqual(result['state'],'succeeded')
        self.assertEqual(len(self.runtime.calls[0]),1)

    def test_restore_clears_derived_vectors_and_obeys_latest_delete_ledger(self):
        source=self.good(self.ingest(self.pet,'restore','猫 snapshot body'))
        self.enable();self.search()
        password='synthetic-semantic-backup-password'
        backup=self.good(self.call('backup.create',dict(password=password),self.owner))['backup_id']
        self.good(self.call('memory.delete',dict(id=source['id'],expected_revision=1),self.owner))
        stage=self.good(self.call('backup.restore.stage',dict(backup_id=backup,password=password),self.owner))
        self.good(self.call('backup.restore.commit',dict(restore_id=stage['restore_id'],expected_memory_epoch=self.epoch()),self.owner))
        self.assertEqual(self.vectors(),0)
        self.activate('a');self.owner=self.bind('owner:local',owner=True,management=True);self.pet=self.bind('pet:local',owner=True)
        self.assertEqual(self.search()['memories'],[])
        self.assertEqual(self.vectors(),0)

    def test_poll_commit_failure_retains_completion_and_closes_semantic_and_tools(self):
        self.good(self.ingest(self.pet,'poll-fail','猫 no resurrection'))
        self.enable();self.runtime.block=True
        job=self.start();self.assertTrue(self.runtime.entered.wait(1));self.runtime.release.set()
        deadline=time.monotonic()+2
        while self.service.semantic.completed.empty() and time.monotonic()<deadline:
            time.sleep(.005)
        from sqlcipher3 import dbapi2
        self.service.db.set_authorizer(lambda action,a,b,c,d:dbapi2.SQLITE_DENY if action==dbapi2.SQLITE_TRANSACTION and a=='COMMIT' else dbapi2.SQLITE_OK)
        try:
            # Reach the semantic COMMIT specifically; the independent T3 suite covers its poll failure.
            with patch.object(self.service.tools,'poll'):
                self.bad(self.call('memory.semantic.job.status',dict(job_id=job['job_id']),self.pet),'SERVICE_UNAVAILABLE')
            self.assertTrue(self.service.semantic.fault)
            self.assertTrue(self.service.tools.persistence_fault)
            self.assertEqual(self.service.semantic.completed.qsize(),1)
            self.assertIn(job['job_id'],self.service.semantic.jobs)
            self.assertEqual(self.vectors(),0)
        finally:
            self.service.db.set_authorizer(None)
        result=self.wait(job)
        self.assertEqual(result['state'],'failed');self.assertEqual(result['code'],'SEMANTIC_STORAGE_FAULT')
        self.assertEqual(self.vectors(),0)
        self.assertEqual(self.service.db.execute("SELECT count(*) FROM semantic_jobs WHERE state IN ('queued','running')").fetchone()[0],0)

    def test_input_limits_and_optional_dependencies_do_not_change_core_query(self):
        self.bad(self.call('memory.semantic.query.start',dict(query='x'*1001),self.pet),'INVALID_REQUEST')
        self.bad(self.call('memory.semantic.configure',dict(enabled=True,model_path='untrusted'),self.owner),'INVALID_REQUEST')
        self.good(self.ingest(self.pet,'ordinary','ordinary substring'))
        self.assertEqual(len(self.good(self.call('memory.query',dict(query='substring'),self.pet))['memories']),1)
        self.assertEqual(self.runtime.calls,[])

    def test_asset_verification_and_worker_reject_missing_or_changed_model(self):
        missing=self.directory/'missing-model'
        with self.assertRaises(ModelFailure) as caught:
            verify_assets(missing)
        self.assertEqual(caught.exception.code,'SEMANTIC_MODEL_MISSING')
        corrupt=self.directory/'corrupt-model';corrupt.mkdir()
        (corrupt/'model.safetensors').write_bytes(b'synthetic corrupt model')
        with self.assertRaises(ModelFailure) as caught:
            verify_assets(corrupt)
        self.assertEqual(caught.exception.code,'SEMANTIC_MODEL_CORRUPT')
        # Exercise real worker verification before any optional ML import, no fake model success.
        code='from pathlib import Path; import semantic_worker; semantic_worker.main(Path(__import__("sys").argv[1]))'
        for path,expected in ((missing,'SEMANTIC_MODEL_MISSING'),(corrupt,'SEMANTIC_MODEL_CORRUPT')):
            result=subprocess.run([sys.executable,'-u','-c',code,str(path)],cwd=ROOT/'services/local-capabilities',
                input=json.dumps(dict(items=[dict(text='synthetic',query=False)]))+'\n',capture_output=True,text=True,encoding='utf-8',timeout=10)
            payload=json.loads(result.stdout)
            self.assertFalse(payload['ok']);self.assertEqual(payload['code'],expected)

    def test_long_segments_and_invalid_aggregate_roll_back_whole_cache_batch(self):
        self.good(self.ingest(self.pet,'long','猫'*3501))
        self.good(self.ingest(self.pet,'short','猫 short'))
        self.enable()
        def encode(items,cancel):
            self.assertEqual([len(item['text']) for item in items[:3]],[7,3500,1])
            return [unit(0),unit(1),[-value for value in unit(1)],unit(0)]
        self.runtime.encode=encode
        result=self.search()
        self.assertEqual(result['state'],'failed')
        self.assertEqual(result['code'],'SEMANTIC_INVALID_VECTOR')
        self.assertEqual(self.vectors(),0)

    def test_real_transport_batch32_has_no_key_and_cleanup_is_bounded(self):
        runtime=SemanticRuntime()
        original=subprocess.Popen
        processes=[]
        code="""import json,sys
for line in sys.stdin:
    request=json.loads(line)
    items=request['items']
    assert len(items)<=32 and all(len(item['text'])<=3500 for item in items)
    print(json.dumps({'ok':True,'fingerprint':sys.argv[1],'vectors':[[1.0]+[0.0]*511 for _ in items]}),flush=True)
"""
        def launch(command,**kwargs):
            self.assertNotIn('SURFCORE_LOCAL_KEY',kwargs['env'])
            self.assertNotIn('DSH_HOME',kwargs['env'])
            self.assertEqual(kwargs['env']['HF_HUB_OFFLINE'],'1')
            process=original([sys.executable,'-u','-c',code,FINGERPRINT],**kwargs)
            processes.append(process)
            return process
        try:
            with patch('semantic_runtime.subprocess.Popen',side_effect=launch):
                vectors=runtime.encode([dict(text='synthetic',query=False)]*65,threading.Event())
            self.assertEqual(len(vectors),65)
            started=time.monotonic();runtime.close()
            self.assertLess(time.monotonic()-started,.5)
            deadline=time.monotonic()+3
            while runtime.retired_count and time.monotonic()<deadline:
                time.sleep(.01)
            self.assertEqual(runtime.retired_count,0)
            self.assertIsNotNone(processes[0].poll())
            self.assertTrue(processes[0].stdin.closed);self.assertTrue(processes[0].stdout.closed)
        finally:
            runtime.close()


class RealCPU(Semantic):
    # Reuse only fixtures/helpers; unittest's inherited synthetic tests remain on Semantic.
    __unittest_skip__ = False

    def test_real_cpu_chinese_synonym_and_rebuild_equivalence(self):
        if not MODEL_DIRECTORY.exists():
            self.skipTest('NOT_VERIFIED: fixed local model assets are missing')
        self.service.semantic.runtime=SemanticRuntime()
        cat=self.good(self.ingest(self.pet,'real-cat','我很喜欢小猫，平时会照顾流浪猫。'))
        other=self.good(self.ingest(self.pet,'real-other','数据库连接池正在迁移，需要为磁盘分区进行备份。'))
        self.enable()
        result=self.wait(self.start('我偏爱猫咪。'),seconds=120)
        self.assertEqual(result['state'],'succeeded',result)
        self.assertEqual(result['memories'][0]['id'],cat['id'])
        scores={row['id']:row['semantic_score'] for row in result['memories']}
        self.assertGreater(scores[cat['id']],scores[other['id']]+.08)
        rebuild=self.good(self.call('memory.semantic.rebuild.start',{},self.owner))
        # Management defaults to owner session; pet data only via explicit character audience.
        self.assertEqual(rebuild['state'],'succeeded')
        rebuild=self.good(self.call('memory.semantic.rebuild.start',dict(audience='character'),self.owner))
        rebuilt=self.wait(rebuild,self.owner,seconds=120)
        self.assertEqual(rebuilt['state'],'succeeded',rebuilt)
        repeated=self.wait(self.start('我偏爱猫咪。'),seconds=120)
        self.assertEqual([r['id'] for r in repeated['memories']],[r['id'] for r in result['memories']])
        for record in repeated['memories']:
            self.assertAlmostEqual(record['semantic_score'],scores[record['id']],places=5)
        evidence=dict(model_fingerprint=FINGERPRINT,dimensions=512,related_score=scores[cat['id']],unrelated_score=scores[other['id']],
                      rebuild_equivalent=True,local_files_only=True,trust_remote_code=False,storage='SQLCipher')
        print('REAL_CPU_EVIDENCE '+json.dumps(evidence,sort_keys=True),flush=True)


# Avoid inherited test duplication in RealCPU; keep its single actual-model acceptance.
for _name in list(Semantic.__dict__):
    if _name.startswith('test_'):
        setattr(RealCPU,_name,None)


if __name__=='__main__':
    unittest.main(verbosity=2)
