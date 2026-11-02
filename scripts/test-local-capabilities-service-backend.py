"""T2a adversarial checks: only temporary SQLCipher fixtures and explicit test keys."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('service_fixtures', ROOT / 'scripts/test-local-capabilities-service.py')
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
CapabilityService = fixtures.CapabilityService


class Backend(unittest.TestCase):
    for name in ('setUp','tearDown','call','good','bad','activate','bind','epoch','ingest','query'):
        locals()[name] = getattr(fixtures.Behavior, name)

    password = 'synthetic-backup-password-2026'

    def submit(self, identifier, source, items=None, binding=None):
        payload = dict(proposal_id=identifier, source_ids=[source['id']], source_revisions={source['id']:source.get('revision',1)},
                       expected_memory_epoch=self.epoch(), proposals=items or [dict(operation='add',kind='preference',statement='User prefers tea')])
        return self.call('memory.proposals.submit',payload,binding or self.pet), payload

    def commit(self, identifier, binding=None):
        return self.call('memory.proposals.commit',dict(proposal_id=identifier,expected_memory_epoch=self.epoch()),binding or self.pet)

    def backup(self):
        return self.good(self.call('backup.create',dict(password=self.password),self.owner))['backup_id']

    def stage(self, identifier):
        return self.good(self.call('backup.restore.stage',dict(backup_id=identifier,password=self.password),self.owner))

    def restore(self, stage, **extra):
        if extra.get('review') and 'review_digest' not in extra:
            status=self.call('backup.recovery.status',{},self.owner)
            if status['ok'] and status['result'].get('restore_id')==stage['restore_id']:
                extra['review_digest']=status['result'].get('review_digest')
            elif stage.get('review_digest'):
                extra['review_digest']=stage['review_digest']
        return self.call('backup.restore.commit',dict(restore_id=stage['restore_id'],expected_memory_epoch=self.epoch(),**extra),self.owner)

    def rebind(self):
        self.activate('a')
        self.owner = self.bind('owner:local',owner=True,management=True)
        self.pet = self.bind('pet:local',owner=True)

    def test_proposals_atomic_assertions_relationship_and_consumption(self):
        episode = self.good(self.ingest(self.pet,'writer-episode','We discussed tea'))
        pending = self.good(self.call('memory.episodes.pending',dict(limit=10),self.pet))
        self.assertEqual([row['id'] for row in pending['episodes']],[episode['id']])
        items = [dict(operation='add',kind='preference',statement='User prefers tea'),
                 dict(operation='add',kind='relationship_projection',statement='Shared conversation about tea')]
        reply,payload = self.submit('writer-batch',episode,items)
        self.good(reply)
        self.assertTrue(self.good(self.call('memory.proposals.submit',payload,self.pet))['duplicate'])
        saved = self.good(self.commit('writer-batch'))
        self.assertEqual(len(saved['ids']),2)
        self.assertTrue(self.good(self.commit('writer-batch'))['duplicate'])
        self.assertFalse(self.good(self.call('memory.episodes.pending',{},self.pet))['episodes'])
        records = [row for row in self.query(self.pet) if row['id'] in saved['ids']]
        self.assertEqual({row['kind'] for row in records},{'preference','relationship_projection'})
        self.assertTrue(all(row['derived_from']==[episode['id']] for row in records))
        self.bad(self.submit('already-consumed',episode)[0],'SOURCE_CONSUMED')
        self.good(self.call('memory.correct',dict(id=episode['id'],statement='We discussed water',expected_revision=1),self.owner))
        self.assertFalse([row for row in self.query(self.pet) if row['id'] in saved['ids']])

    def test_user_pinned_wins_and_partial_batch_rolls_back(self):
        first = self.good(self.ingest(self.pet,'first-source','Original preference source'))
        self.good(self.submit('initial',first)[0])
        assertion = self.good(self.commit('initial'))['ids'][0]
        self.good(self.call('memory.correct',dict(id=assertion,statement='User explicitly prefers water',expected_revision=1),self.owner))
        second = self.good(self.ingest(self.pet,'second-source','New automatic source'))
        items = [dict(operation='add',kind='interest',statement='Must roll back this intermediate item'),
                 dict(operation='supersede',kind='preference',target_id=assertion,expected_revision=2,statement='User prefers coffee')]
        self.good(self.submit('conflict',second,items)[0])
        before = self.epoch()
        self.bad(self.commit('conflict'),'VERSION_CONFLICT')
        self.assertEqual(self.epoch(),before)
        self.assertNotIn('Must roll back',json.dumps(self.query(self.pet)))
        self.assertIn('User explicitly prefers water',json.dumps(self.query(self.pet)))
        self.assertTrue(self.good(self.call('memory.episodes.pending',{},self.pet))['episodes'])

    def test_automatic_supersede_invalidate_keep_current_source_proofs(self):
        first=self.good(self.ingest(self.pet,'assertion-first','Initial observation'))
        self.good(self.submit('assertion-add',first)[0]); identifier=self.good(self.commit('assertion-add'))['ids'][0]
        second=self.good(self.ingest(self.pet,'assertion-second','New independent observation'))
        item=dict(operation='supersede',kind='preference',target_id=identifier,expected_revision=1,statement='Updated current preference')
        self.good(self.submit('assertion-replace',second,[item])[0]); self.good(self.commit('assertion-replace'))
        row=next(row for row in self.query(self.pet) if row['id']==identifier)
        self.assertEqual(row['revision'],2); self.assertEqual(row['source_revisions'],{second['id']:1})
        self.assertEqual(row['source_refs'],['source:assertion-second'])
        third=self.good(self.ingest(self.pet,'assertion-third','No longer applicable'))
        item=dict(operation='invalidate',kind='preference',target_id=identifier,expected_revision=2)
        self.good(self.submit('assertion-invalidate',third,[item])[0]); self.good(self.commit('assertion-invalidate'))
        self.assertNotIn(identifier,{row['id'] for row in self.query(self.pet)})
        detail=self.good(self.call('memory.detail',dict(id=identifier),self.owner))
        self.assertEqual(detail['memory']['status'],'invalidated')
        self.assertEqual([row['actor'] for row in detail['revisions']],['writer','writer','writer'])

    def test_proposal_event_collision_cannot_reclassify_or_rewrite_pinned_episode(self):
        collision=self.good(self.ingest(self.pet,'proposal:collision:0','Independent original event'))
        self.good(self.call('memory.correct',dict(id=collision['id'],statement='User pinned original event',expected_revision=1),self.owner))
        source=self.good(self.ingest(self.pet,'collision-source','Another source'))
        self.good(self.submit('collision',source)[0])
        self.bad(self.commit('collision'),'VERSION_CONFLICT')
        detail=self.good(self.call('memory.detail',dict(id=collision['id']),self.owner))
        self.assertEqual(detail['memory']['kind'],'episode')
        self.assertEqual(detail['memory']['statement'],'User pinned original event')
        self.assertEqual(detail['revisions'][0]['actor'],'ingest')
        self.assertEqual(detail['memory']['source_revisions'],{})

    def test_stale_revision_epoch_auto_write_and_scope(self):
        source = self.good(self.ingest(self.pet,'stale-source','Original source'))
        self.bad(self.submit('cross-scope',source,binding=self.group1)[0],'PERMISSION_DENIED')
        self.assertFalse(self.good(self.call('memory.episodes.pending',{},self.group1))['episodes'])
        self.good(self.submit('stale',source)[0])
        self.good(self.call('memory.correct',dict(id=source['id'],statement='Corrected source',expected_revision=1),self.owner))
        self.bad(self.commit('stale'),'STALE_CONTEXT')
        self.bad(self.submit('old-revision',source)[0],'VERSION_CONFLICT')
        self.good(self.call('memory.settings',dict(auto_write=False),self.owner))
        source['revision']=2
        self.bad(self.submit('disabled',source)[0],'AUTO_WRITE_DISABLED')
        self.bad(self.call('memory.proposals.list',{},self.group1),'PERMISSION_DENIED')

    def test_delete_purges_pending_payload_and_keyword_projection(self):
        source = self.good(self.ingest(self.pet,'delete-proposal','Sensitive automatic source'))
        self.good(self.submit('delete-pending',source,[dict(operation='add',kind='interest',statement='Sensitive pending proposal body')])[0])
        self.good(self.call('memory.delete',dict(id=source['id'],expected_revision=1),self.owner))
        listed = self.good(self.call('memory.proposals.list',{},self.owner))
        self.assertNotIn('Sensitive',json.dumps(listed))
        self.bad(self.commit('delete-pending'),'DELETED_SOURCE')
        self.assertEqual(self.good(self.call('memory.query',dict(query='Sensitive',search_mode='keyword'),self.pet))['memories'],[])

    def test_resume_requires_owner_and_current_source_review(self):
        source = self.good(self.ingest(self.pet,'resume-source','Original observation'))
        child = self.good(self.ingest(self.pet,'resume-child','Observation summary',derived_from=[source['id']]))
        self.good(self.call('memory.correct',dict(id=source['id'],statement='Corrected observation',expected_revision=1),self.owner))
        request = dict(id=child['id'],expected_revision=2,expected_source_revisions={source['id']:2})
        self.bad(self.call('memory.resume',request,self.pet),'PERMISSION_DENIED')
        self.bad(self.call('memory.resume',dict(id=child['id'],expected_revision=2),self.owner),'INVALID_REQUEST')
        resumed = self.good(self.call('memory.resume',request,self.owner))
        self.assertTrue(resumed['memory']['pinned'])
        self.assertIn(child['id'],{row['id'] for row in self.query(self.pet)})
        self.good(self.call('memory.delete',dict(id=child['id'],expected_revision=3),self.owner))
        self.bad(self.call('memory.resume',dict(id=child['id'],expected_revision=4),self.owner),'DELETED_SOURCE')

    def test_keyword_index_is_rebuildable_and_audience_first(self):
        row = self.good(self.ingest(self.pet,'keywords','daily coffee and 茶水'))
        result = self.good(self.call('memory.query',dict(query='coffee daily',search_mode='keyword'),self.pet))
        self.assertEqual([value['id'] for value in result['memories']],[row['id']])
        self.assertFalse(self.good(self.call('memory.query',dict(query='coffee daily',search_mode='keyword'),self.group1))['memories'])
        self.service.db.execute('DELETE FROM memory_terms')
        rebuilt = self.good(self.call('memory.index.rebuild',{},self.owner))
        self.assertFalse(rebuilt['semantic_vectors'])
        self.assertTrue(self.good(self.call('memory.query',dict(query='茶水',search_mode='keyword'),self.pet))['memories'])

    def test_backup_encrypted_password_manifest_and_permission_failures(self):
        self.good(self.ingest(self.pet,'backup-secret','Only inside encrypted snapshot body'))
        identifier = self.backup()
        base = self.directory / 'backups'
        for file in base.iterdir():
            self.assertNotIn(b'Only inside encrypted snapshot body',file.read_bytes())
            self.assertNotIn(self.password.encode(),file.read_bytes())
        result = self.good(self.call('backup.inspect',dict(backup_id=identifier,password=self.password),self.owner))
        self.assertFalse(result['includes_keys']); self.assertFalse(result['includes_authorizations'])
        self.assertEqual(result['preview'][0]['statement'],'Only inside encrypted snapshot body')
        self.bad(self.call('backup.inspect',dict(backup_id=identifier,password='incorrect-password'),self.owner),'BACKUP_AUTH_FAILED')
        self.bad(self.call('backup.inspect',dict(backup_id='../memory.db',password=self.password),self.owner),'INVALID_REQUEST')
        self.bad(self.call('backup.create',dict(password=self.password),self.group1),'PERMISSION_DENIED')
        self.bad(self.call('backup.create',dict(password='short'),self.owner),'INVALID_REQUEST')
        file=base/(identifier+'.db'); content=file.read_bytes(); file.write_bytes(content[:-5]+b'xxxxx')
        self.bad(self.call('backup.restore.stage',dict(backup_id=identifier,password=self.password),self.owner),'BACKUP_CORRUPT')
        self.assertEqual(self.query(self.pet)[0]['statement'],'Only inside encrypted snapshot body')

    def test_old_snapshot_cannot_restore_deleted_sources_or_relationships(self):
        source=self.good(self.ingest(self.pet,'before-delete','Private old experience'))
        self.good(self.submit('before-delete-writer',source,[dict(operation='add',kind='relationship_projection',statement='Old derived relationship')])[0])
        self.good(self.commit('before-delete-writer'))
        identifier=self.backup()
        self.good(self.call('memory.delete',dict(id=source['id'],expected_revision=1),self.owner))
        self.good(self.call('memory.settings',dict(auto_write=False),self.owner))
        staged=self.stage(identifier)
        self.assertFalse(staged['requires_review'])
        result=self.good(self.restore(staged))
        self.assertEqual(result['status'],'committed')
        self.bad(self.call('context.validate',dict(memory_epoch=result['memory_epoch']),self.pet),'STALE_CHARACTER')
        self.rebind()
        self.assertFalse(self.query(self.pet))
        self.assertFalse(self.good(self.call('memory.settings',{},self.owner))['auto_write'])
        self.good(self.call('memory.settings',dict(auto_write=True),self.owner))
        self.bad(self.ingest(self.pet,'replay-new-id','Private old experience'),'DELETED_SOURCE')
        exported=self.good(self.call('memory.export',{},self.owner))
        self.assertNotIn('Private old experience',json.dumps(exported))
        self.assertNotIn('Old derived relationship',json.dumps(exported))

    def test_concurrent_correction_and_cancel_keep_activity_intact(self):
        source=self.good(self.ingest(self.pet,'cas-restore','Snapshot value'))
        identifier=self.backup(); stage=self.stage(identifier)
        self.good(self.call('memory.correct',dict(id=source['id'],statement='Current user correction',expected_revision=1),self.owner))
        self.bad(self.restore(stage),'VERSION_CONFLICT')
        self.assertEqual(self.query(self.pet)[0]['statement'],'Current user correction')
        self.good(self.call('backup.restore.cancel',dict(restore_id=stage['restore_id']),self.owner))
        self.bad(self.restore(stage),'VERSION_CONFLICT')

    def test_stage_corruption_and_interrupted_commit_are_atomic(self):
        source=self.good(self.ingest(self.pet,'atomic-restore','Snapshot original'))
        identifier=self.backup()
        self.good(self.call('memory.correct',dict(id=source['id'],statement='Current live content',expected_revision=1),self.owner))
        stage=self.stage(identifier)
        path=self.directory/'restore-staging'/(stage['restore_id']+'.db')
        path.write_bytes(path.read_bytes()+b'corrupt')
        self.bad(self.restore(stage),'BACKUP_CORRUPT')
        stage=self.stage(identifier); before=self.epoch()
        with patch.object(self.service.governance,'rebuild',side_effect=RuntimeError('synthetic interrupted restore')):
            self.bad(self.restore(stage),'SERVICE_UNAVAILABLE')
        self.assertEqual(self.epoch(),before)
        self.assertEqual(self.query(self.pet)[0]['statement'],'Current live content')
        self.good(self.call('context.validate',dict(memory_epoch=before),self.pet))
        self.assertEqual(self.service.db.execute('SELECT status FROM restore_stages WHERE id=?',(stage['restore_id'],)).fetchone()[0],'staged')

    def test_portable_restore_is_paused_until_management_review(self):
        self.good(self.ingest(self.pet,'portable','Portable private memory'))
        identifier=self.backup()
        target=self.directory/'new-device'; (target/'backups').mkdir(parents=True)
        for suffix in ('.json','.db'):
            shutil.copy2(self.directory/'backups'/(identifier+suffix),target/'backups'/(identifier+suffix))
        self.service.close()
        with patch.dict(os.environ,SURFCORE_LOCAL_KEY='29'*32):
            self.service=CapabilityService(target,clock=lambda:self.now)
        self.rebind()
        stage=self.stage(identifier); self.assertTrue(stage['requires_review'])
        result=self.good(self.restore(stage)); self.assertEqual(result['status'],'committed_paused')
        self.rebind()
        self.bad(self.call('memory.query',{},self.pet),'RECOVERY_REVIEW_REQUIRED')
        self.bad(self.call('attention.reserve',dict(outreach_id='paused-send'),self.pet),'RECOVERY_REVIEW_REQUIRED')
        self.service.close()
        with patch.dict(os.environ,SURFCORE_LOCAL_KEY='29'*32):
            self.service=CapabilityService(target,clock=lambda:self.now)
        self.rebind()
        self.bad(self.call('memory.query',{},self.pet),'RECOVERY_REVIEW_REQUIRED')
        self.bad(self.call('backup.restore.commit',dict(restore_id=stage['restore_id'],expected_memory_epoch=self.epoch(),review=True),self.pet),'PERMISSION_DENIED')
        self.good(self.restore(stage,review=True)); self.rebind()
        self.assertEqual(self.query(self.pet)[0]['statement'],'Portable private memory')
        self.assertFalse((target/'key.dpapi').exists())  # explicit test key; no source DPAPI copied
        self.assertEqual(self.service.db.execute('SELECT count(*) FROM outreach').fetchone()[0],0)

    def test_snapshot_missing_fingerprints_cannot_bypass_latest_deletion(self):
        import hashlib
        import uuid
        from backup import KDF,file_digest
        source=self.good(self.ingest(self.pet,'forged-source','Fingerprint protected deleted body'))
        data=self.service.backups.collect('a')
        data['records']['fingerprints']=[]
        self.good(self.call('memory.delete',dict(id=source['id'],expected_revision=1),self.owner))
        identifier=uuid.uuid4().hex; salt=os.urandom(16).hex()
        header=dict(format_version=1,backup_id=identifier,salt=salt,kdf=KDF,lineage='unregistered',created_at=self.now,
                    counts={name:len(rows) for name,rows in data['records'].items()})
        directory=self.directory/'backups'; directory.mkdir(exist_ok=True)
        path=directory/(identifier+'.db')
        self.service.backups.write(path,self.service.backups.key(self.password,salt),header,data)
        (directory/(identifier+'.json')).write_text(json.dumps(dict(header,sha256=file_digest(path),bytes=path.stat().st_size)),encoding='utf-8')
        self.bad(self.call('backup.restore.stage',dict(backup_id=identifier,password=self.password),self.owner),'BACKUP_CORRUPT')
        self.assertFalse(self.query(self.pet))

    def test_backup_identity_and_snapshot_index_are_role_scoped(self):
        self.good(self.ingest(self.pet,'role-backup','Role a private only'))
        identifier=self.backup()
        self.activate('b'); owner_b=self.bind('owner:local',owner=True,management=True,character='b')
        self.bad(self.call('backup.inspect',dict(backup_id=identifier,password=self.password),owner_b,'b'),'CHARACTER_MISMATCH')
        self.assertEqual(self.query(owner_b,'b'),[])
        other=self.good(self.ingest(owner_b,'b-memory','Other role remains current',character='b'))
        self.rebind()
        self.good(self.restore(self.stage(identifier)))
        self.assertEqual([row['id'] for row in self.query(owner_b,'b')],[other['id']])

    def test_missing_independent_ledger_requires_review(self):
        self.good(self.ingest(self.pet,'ledger-source','Existing domain content'))
        self.service.close()
        (self.directory/'sovereignty.db').rename(self.directory/'sovereignty.saved-for-fixture')
        self.service=CapabilityService(self.directory,clock=lambda:self.now); self.rebind()
        self.bad(self.call('memory.query',{},self.pet),'RECOVERY_REVIEW_REQUIRED')
        self.assertEqual(self.query(self.owner)[0]['statement'],'Existing domain content')
        self.service.close()
        self.service=CapabilityService(self.directory,clock=lambda:self.now); self.rebind()
        self.bad(self.call('memory.query',{},self.pet),'RECOVERY_REVIEW_REQUIRED')

    def test_independent_ledger_survives_old_physical_main_replay(self):
        source=self.good(self.ingest(self.pet,'physical-source','Do not resurrect physical replay'))
        self.service.close()
        old=self.directory/'synthetic-old-main.db'; shutil.copy2(self.directory/'memory.db',old)
        self.service=CapabilityService(self.directory,clock=lambda:self.now); self.rebind()
        self.good(self.call('memory.delete',dict(id=source['id'],expected_revision=1),self.owner)); self.service.close()
        shutil.copy2(old,self.directory/'memory.db')
        self.service=CapabilityService(self.directory,clock=lambda:self.now); self.rebind()
        self.assertFalse(self.query(self.pet))
        self.bad(self.ingest(self.pet,'physical-source','different wording'),'DELETED_SOURCE')

    def test_review_f1_private_writer_cannot_change_public_assertion(self):
        for operation in ('supersede','invalidate'):
            with self.subTest(operation=operation):
                source=self.good(self.ingest(self.public,'public-'+operation,'Public original '+operation))
                self.good(self.submit('public-add-'+operation,source,binding=self.public)[0])
                target=self.good(self.commit('public-add-'+operation,self.public))['ids'][0]
                private=self.good(self.ingest(self.pet,'private-'+operation,'Private replacement '+operation))
                item=dict(operation=operation,kind='preference',target_id=target,expected_revision=1,statement='Private replacement body')
                self.good(self.submit('private-change-'+operation,private,[item])[0])
                self.bad(self.commit('private-change-'+operation),'PERMISSION_DENIED')
                row=next(row for row in self.query(self.public) if row['id']==target)
                self.assertEqual(row['revision'],1)

    def test_review_f1_invisible_target_cannot_be_resourced_into_visibility(self):
        source=self.good(self.ingest(self.pet,'hidden-parent','Original root observation'))
        self.good(self.submit('hidden-assertion',source)[0]); target=self.good(self.commit('hidden-assertion'))['ids'][0]
        self.good(self.call('memory.suspend',dict(id=source['id'],expected_revision=1),self.owner))
        self.assertNotIn(target,{row['id'] for row in self.query(self.pet)})
        replacement=self.good(self.ingest(self.pet,'visible-replacement','Different current evidence'))
        item=dict(operation='supersede',kind='preference',target_id=target,expected_revision=1,statement='Must not reactivate hidden target')
        self.good(self.submit('resourcing-hidden',replacement,[item])[0])
        self.bad(self.commit('resourcing-hidden'),'PERMISSION_DENIED')

    def test_review_f2_delete_refs_empty_add_clears_committed_payload_and_result(self):
        source=self.good(self.call('memory.ingest',dict(source_event_id='no-refs-source',text='Surviving source',source_refs=[],expected_memory_epoch=self.epoch()),self.pet))
        body='Deleted automatic output body'
        submitted,payload=self.submit('no-refs-add',source,[dict(operation='add',kind='interest',statement=body)])
        self.good(submitted); target=self.good(self.commit('no-refs-add'))['ids'][0]
        self.good(self.call('memory.delete',dict(id=target,expected_revision=1),self.owner))
        listed=self.good(self.call('memory.proposals.list',{},self.owner))
        self.assertNotIn(body,json.dumps(listed))
        proposal=next(row for row in listed['proposals'] if row['proposal_id']=='no-refs-add')
        self.assertEqual(proposal['status'],'deleted'); self.assertEqual(proposal['result'],{})
        self.bad(self.commit('no-refs-add'),'DELETED_SOURCE')
        self.bad(self.call('memory.proposals.submit',payload,self.pet),'DELETED_SOURCE')

    def test_review_f2_independent_source_candidate_body_follows_content_deletion(self):
        body='Content deletion must erase independent candidate'
        deleted=self.good(self.ingest(self.pet,'delete-body',body))
        independent=self.good(self.ingest(self.pet,'independent-candidate-source','Independent source survives'))
        submitted,payload=self.submit('same-body-candidate',independent,[dict(operation='add',kind='interest',statement=body)])
        self.good(submitted)
        self.good(self.call('memory.delete',dict(id=deleted['id'],expected_revision=1),self.owner))
        self.assertNotIn(body,json.dumps(self.good(self.call('memory.proposals.list',{},self.owner))))
        self.bad(self.commit('same-body-candidate'),'DELETED_SOURCE')
        payload['proposal_id']='new-id-deleted-body';payload['expected_memory_epoch']=self.epoch()
        self.bad(self.call('memory.proposals.submit',payload,self.pet),'DELETED_SOURCE')

    def test_review_f3_stage_rechecks_authority_after_ledger_disappears(self):
        self.good(self.ingest(self.pet,'healthy-stage','Backup before authority loss'))
        stage=self.stage(self.backup());self.assertFalse(stage['requires_review'])
        self.service.close();(self.directory/'sovereignty.db').rename(self.directory/'lost-ledger-fixture')
        self.service=CapabilityService(self.directory,clock=lambda:self.now);self.rebind()
        self.bad(self.call('memory.query',{},self.pet),'RECOVERY_REVIEW_REQUIRED')
        self.bad(self.call('backup.restore.commit',dict(restore_id=stage['restore_id'],expected_memory_epoch=self.epoch(),
            review=True,review_digest=stage.get('review_digest')),self.owner),'VERSION_CONFLICT')
        result=self.good(self.restore(stage))
        self.assertEqual(result['status'],'committed_paused');self.assertTrue(result['requires_review'])
        self.rebind();self.bad(self.call('context.validate',dict(memory_epoch=self.epoch()),self.pet),'RECOVERY_REVIEW_REQUIRED')

    def test_review_f3_old_restore_approval_cannot_release_new_restore(self):
        source=self.good(self.ingest(self.pet,'restore-sequence','Restore A original'))
        backup_a=self.backup()
        self.good(self.call('memory.correct',dict(id=source['id'],statement='Restore B current',expected_revision=1),self.owner))
        backup_b=self.backup();self.service.db.execute('DELETE FROM sovereignty.backups')
        stage_a=self.stage(backup_a);self.good(self.restore(stage_a));self.rebind()
        stage_b=self.stage(backup_b);self.good(self.restore(stage_b));self.rebind()
        self.bad(self.restore(stage_a,review=True),'VERSION_CONFLICT')
        status=self.good(self.call('backup.recovery.status',{},self.owner))
        self.assertEqual(status['restore_id'],stage_b['restore_id']);self.assertTrue(status['requires_review'])
        self.assertNotIn('Restore B current',json.dumps(status));self.assertNotIn(str(self.directory),json.dumps(status))
        self.bad(self.call('backup.recovery.status',{},self.pet),'PERMISSION_DENIED')
        self.bad(self.call('memory.query',{},self.pet),'RECOVERY_REVIEW_REQUIRED')
        fresh_old_digest=self.service.backups.review_digest('a',stage_a['restore_id'],stage_a['snapshot_digest'])
        self.bad(self.call('backup.restore.commit',dict(restore_id=stage_a['restore_id'],expected_memory_epoch=self.epoch(),
            review=True,review_digest=fresh_old_digest),self.owner),'VERSION_CONFLICT')
        self.bad(self.call('backup.restore.commit',dict(restore_id=stage_b['restore_id'],expected_memory_epoch=self.epoch(),
            review=True,review_digest='0'*64),self.owner),'VERSION_CONFLICT')
        record=self.query(self.owner)[0]
        self.good(self.call('memory.correct',dict(id=record['id'],statement='Correction during paused review',expected_revision=record['revision']),self.owner))
        self.bad(self.call('backup.restore.commit',dict(restore_id=stage_b['restore_id'],expected_memory_epoch=self.epoch(),
            review=True,review_digest=status['review_digest']),self.owner),'VERSION_CONFLICT')
        self.bad(self.call('memory.query',{},self.pet),'RECOVERY_REVIEW_REQUIRED')
        rebaked=self.backup()
        self.assertTrue(self.good(self.call('backup.inspect',dict(backup_id=rebaked,password=self.password),self.owner))['requires_review'])
        self.good(self.restore(stage_b,review=True));self.rebind()
        self.assertEqual(self.query(self.pet)[0]['statement'],'Correction during paused review')
        record=self.query(self.pet)[0]
        self.good(self.call('memory.correct',dict(id=record['id'],statement='Reviewed later correction',expected_revision=record['revision']),self.owner))
        epoch=self.epoch();self.assertTrue(self.good(self.restore(stage_b,review=True))['duplicate'])
        self.assertEqual(self.epoch(),epoch);self.assertEqual(self.query(self.pet)[0]['statement'],'Reviewed later correction')

    def test_review_f3_missing_ledger_review_persists_only_for_current_role_instance(self):
        self.good(self.ingest(self.pet,'review-persistent','Explicitly reviewed memory'))
        backup=self.backup();self.activate('b')
        owner_b=self.bind('owner:local',owner=True,management=True,character='b')
        self.good(self.ingest(owner_b,'other-role-unreviewed','Other role should stay paused',character='b'))
        self.service.close();(self.directory/'sovereignty.db').rename(self.directory/'first-lost-ledger-fixture')
        self.service=CapabilityService(self.directory,clock=lambda:self.now);self.rebind()
        stage=self.stage(backup);self.good(self.restore(stage));self.rebind()
        self.good(self.restore(stage,review=True));self.rebind()
        self.assertTrue(self.query(self.pet))
        self.service.close();self.service=CapabilityService(self.directory,clock=lambda:self.now);self.rebind()
        self.assertEqual(self.query(self.pet)[0]['statement'],'Explicitly reviewed memory')
        self.activate('b');pet_b=self.bind('pet:local',owner=True,character='b')
        self.bad(self.call('memory.query',{},pet_b,'b'),'RECOVERY_REVIEW_REQUIRED')
        self.assertEqual(self.service.db.execute("SELECT value FROM sovereignty.metadata WHERE key='trusted'").fetchone()[0],'0')
        self.service.close();(self.directory/'sovereignty.db').rename(self.directory/'second-lost-ledger-fixture')
        self.service=CapabilityService(self.directory,clock=lambda:self.now);self.rebind()
        self.bad(self.call('memory.query',{},self.pet),'RECOVERY_REVIEW_REQUIRED')

    def test_channel_seam_active_source_id_and_fixed_ingest_proofs(self):
        parent=self.good(self.ingest(self.public,'public-material','Current public material'))
        source=self.good(self.call('context.sources',dict(source_event_ids=['public-material']),self.public))['sources'][0]
        self.assertEqual(source['id'],parent['id'])
        request=dict(source_event_id='owner-thought',text='Owner private thought from material',source_refs=[],
                     derived_from=[parent['id']],source_revisions={parent['id']:1},expected_memory_epoch=self.epoch())
        thought=self.good(self.call('memory.ingest',request,self.pet))
        record=next(row for row in self.query(self.pet) if row['id']==thought['id'])
        self.assertEqual(record['source_revisions'],{parent['id']:1})
        self.assertNotIn(thought['id'],{row['id'] for row in self.query(self.public)})
        request['expected_memory_epoch']=self.epoch()
        self.assertTrue(self.good(self.call('memory.ingest',request,self.pet))['duplicate'])
        another=self.good(self.ingest(self.public,'another-material','Another public material'))
        changed=dict(request,derived_from=[another['id']],source_revisions={another['id']:1},expected_memory_epoch=self.epoch())
        self.bad(self.call('memory.ingest',changed,self.pet),'VERSION_CONFLICT')
        self.good(self.call('memory.correct',dict(id=parent['id'],statement='Corrected public material',expected_revision=1),self.owner))
        inactive=self.good(self.call('context.sources',dict(source_event_ids=['owner-thought']),self.pet))['sources'][0]
        self.assertEqual(inactive['status'],'suspended');self.assertNotIn('id',inactive);self.assertNotIn('text',inactive)
        request.update(source_event_id='stale-new-thought',expected_memory_epoch=self.epoch())
        self.bad(self.call('memory.ingest',request,self.pet),'VERSION_CONFLICT')
        request['source_revisions']={parent['id']:2}
        self.good(self.call('memory.ingest',request,self.pet))

    def test_channel_seam_rejects_malformed_foreign_and_stale_proofs_atomically(self):
        parent=self.good(self.ingest(self.pet,'private-material','Private original material'))
        request=dict(source_event_id='invalid-thought',text='Rejected synthetic thought',source_refs=[],derived_from=[parent['id']],expected_memory_epoch=self.epoch())
        for proofs in ({},{parent['id']:True},{parent['id']:1,'extra':1},None):
            self.bad(self.call('memory.ingest',dict(request,source_revisions=proofs),self.pet),'INVALID_REQUEST')
        self.bad(self.call('memory.ingest',dict(request,source_revisions={parent['id']:2}),self.pet),'VERSION_CONFLICT')
        self.bad(self.call('memory.ingest',dict(request,source_revisions={parent['id']:1}),self.group1),'PERMISSION_DENIED')
        self.assertEqual(self.epoch(),request['expected_memory_epoch'])
        hidden=self.good(self.call('context.sources',dict(source_event_ids=['private-material']),self.group1))['sources'][0]
        self.assertEqual(hidden,dict(source_event_id='private-material',status='missing'))

    def test_attempt3_auto_write_off_cannot_bless_cross_scope_deleted_event(self):
        event='bili:public:BV1xx411c7mD:material'
        deleted=self.good(self.ingest(self.alice,event,'Deleted private source identity'))
        self.good(self.call('memory.delete',dict(id=deleted['id'],expected_revision=1),self.owner))
        self.good(self.call('memory.settings',dict(auto_write=False),self.owner))
        hidden=self.good(self.call('context.sources',dict(source_event_ids=[event]),self.public))['sources'][0]
        self.assertEqual(hidden,dict(source_event_id=event,status='missing'))
        before_epoch=self.epoch();before_changes=self.service.db.total_changes
        response=self.call('memory.ingest',dict(source_event_id=event,text='Freshly fetched different public wording',source_refs=[],
            expected_memory_epoch=before_epoch),self.public)
        self.bad(response,'DELETED_SOURCE')
        self.assertNotIn('id',response);self.assertNotIn('Deleted private source identity',json.dumps(response))
        self.assertEqual(self.epoch(),before_epoch);self.assertEqual(self.service.db.total_changes,before_changes)

    def test_attempt3_auto_write_off_new_event_is_read_only_but_sources_still_validated(self):
        parent=self.good(self.ingest(self.public,'current-material-off','Current allowed material'))
        private=self.good(self.ingest(self.pet,'private-material-off','Other audience material'))
        self.good(self.call('memory.settings',dict(auto_write=False),self.owner))
        epoch=self.epoch();changes=self.service.db.total_changes
        fresh=dict(source_event_id='never-stored-public-event',text='Truly new fetched public material',source_refs=[],expected_memory_epoch=epoch)
        self.bad(self.call('memory.ingest',fresh,self.public),'AUTO_WRITE_DISABLED')
        self.bad(self.call('memory.ingest',dict(fresh,source_event_id='bad-shape',derived_from=[parent['id']],source_revisions={}),self.public),'INVALID_REQUEST')
        self.bad(self.call('memory.ingest',dict(fresh,source_event_id='stale-proof',derived_from=[parent['id']],source_revisions={parent['id']:2}),self.public),'VERSION_CONFLICT')
        self.bad(self.call('memory.ingest',dict(fresh,source_event_id='hidden-proof',derived_from=[private['id']],source_revisions={private['id']:1}),self.public),'PERMISSION_DENIED')
        self.assertEqual(self.epoch(),epoch);self.assertEqual(self.service.db.total_changes,changes)
        self.assertEqual(self.good(self.call('context.sources',dict(source_event_ids=['never-stored-public-event']),self.public))['sources'],
            [dict(source_event_id='never-stored-public-event',status='missing')])

    def test_attempt3_disabled_existing_source_identity_matrix(self):
        cases=[('active','AUTO_WRITE_DISABLED'),('suspended','PERMISSION_DENIED'),('invalidated','PERMISSION_DENIED'),
               ('hidden_parent','PERMISSION_DENIED'),('foreign_scope','PERMISSION_DENIED'),('quarantine','PERMISSION_DENIED'),
               ('deleted','DELETED_SOURCE'),('other_role','AUTO_WRITE_DISABLED'),('never_stored','AUTO_WRITE_DISABLED')]
        for name,code in cases:
            with self.subTest(identity=name):
                self.good(self.call('memory.settings',dict(auto_write=True),self.owner))
                event='bili:public:identity-'+name+':material'
                if name in ('active','suspended','deleted'):
                    item=self.good(self.ingest(self.public,event,'Original '+name))
                    if name!='active':
                        self.good(self.call('memory.'+('delete' if name=='deleted' else 'suspend'),dict(id=item['id'],expected_revision=1),self.owner))
                elif name=='hidden_parent':
                    parent=self.good(self.ingest(self.public,'hidden-material-parent','Original public parent'))
                    self.good(self.call('memory.ingest',dict(source_event_id=event,text='Child with inherited source',source_refs=[],
                        derived_from=[parent['id']],source_revisions={parent['id']:1},expected_memory_epoch=self.epoch()),self.public))
                    self.good(self.call('memory.suspend',dict(id=parent['id'],expected_revision=1),self.owner))
                elif name=='foreign_scope':
                    private=self.good(self.ingest(self.alice,event,'Private retained copy'))
                elif name=='quarantine':
                    self.good(self.call('memory.migrate',dict(migration_id='off-quarantine',records=[dict(source_event_id=event,text='Legacy quarantined material')]),self.owner))
                elif name=='other_role':
                    self.activate('b');other=self.bind('owner:local',owner=True,management=True,character='b')
                    other_record=self.good(self.ingest(other,event,'Other role retained copy',character='b'))
                    self.good(self.call('memory.delete',dict(id=other_record['id'],expected_revision=1),other,'b'))
                elif name=='invalidated':
                    source=self.good(self.ingest(self.public,'invalidated-source','Original writer source'))
                    self.good(self.submit('off-invalidated-add',source,binding=self.public)[0])
                    target=self.good(self.commit('off-invalidated-add',self.public))['ids'][0]
                    event='proposal:off-invalidated-add:0'
                    next_source=self.good(self.ingest(self.public,'invalidated-new-source','New writer source'))
                    self.good(self.submit('off-invalidate',next_source,[dict(operation='invalidate',kind='preference',target_id=target,expected_revision=1)],self.public)[0])
                    self.good(self.commit('off-invalidate',self.public))
                self.good(self.call('memory.settings',dict(auto_write=False),self.owner))
                projection=self.good(self.call('context.sources',dict(source_event_ids=[event]),self.public))['sources'][0]
                if name!='active':
                    self.assertNotIn('id',projection);self.assertNotIn('text',projection)
                epoch=self.epoch();changes=self.service.db.total_changes
                result=self.call('memory.ingest',dict(source_event_id=event,text='Fresh synthetic public text '+name,source_refs=[],expected_memory_epoch=epoch),self.public)
                self.bad(result,code);self.assertNotIn('id',result)
                self.assertEqual(self.epoch(),epoch);self.assertEqual(self.service.db.total_changes,changes)
                if name=='foreign_scope':
                    # Persisted mode still retains the established per-scope contract.
                    self.good(self.call('memory.settings',dict(auto_write=True),self.owner))
                    saved=self.good(self.ingest(self.public,event,'Allowed persisted public source'))
                    self.assertNotEqual(saved['id'],private['id'])


if __name__=='__main__':
    unittest.main(verbosity=2)
