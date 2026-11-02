"""T5 actual SQLCipher/DPAPI tests. All libraries are temporary synthetic data."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import unittest
import uuid
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, os.environ.get('T5_SERVICE_OVERLAY', str(ROOT / 'services/local-capabilities')))
from core import CapabilityService, encode
from storage import Store, ServiceError, dpapi
from portable_state import dedupe, merge_event, validate_summary
from schema_compat import unwrap, prepare, MAGIC


class Portable(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='surfcore-t5-')
        self.env = patch.dict(os.environ, {'SURFCORE_LOCAL_KEY': os.urandom(32).hex()})
        self.env.start()
        self.now = 1793577600
        self.service = CapabilityService(Path(self.temp.name) / 'library', clock=lambda: self.now)
        self.call('character.activate', {'character_id': 'synthetic'})
        self.token = self.service.portable.token

    def tearDown(self):
        self.service.close(); self.env.stop(); self.temp.cleanup()

    def call(self, operation, params, **fields):
        request = dict(protocol_version=1, request_id=uuid.uuid4().hex, op=operation, params=params, **fields)
        result = self.service.handle(request)
        if not result['ok']:
            raise ServiceError(result['code'], result['error'], result['hint'])
        return result['result']

    def internal(self, operation, **params):
        if operation == 'begin':params.setdefault('approval_expires_at',self.now * 1000 + 300000)
        return self.call('portable.' + operation, params, portable_coordinator=self.token)

    def summary(self):
        return self.service.portable.summary('synthetic')

    def input_summary(self, value):
        identifier = uuid.uuid4().hex
        path = self.service.backups.owned('portable-inputs', identifier, '.json')
        path.write_text(encode(value), encoding='utf-8')
        return identifier

    def stage(self, digest=None):
        captured = self.internal('capture', character_id='synthetic', password='synthetic-long-password')
        return self.internal('stage', operation_id=uuid.uuid4().hex, package_digest=digest or uuid.uuid4().hex * 2,
                             backup_id=captured['snapshot']['backup_id'], password='synthetic-long-password', target_character_id='synthetic',
                             mode='restore_same_id', expected_memory_epoch=self.service.epoch('synthetic'), persona_digest='a' * 64,
                             attention_id=captured['attention_id'])

    def test_actual_cipher_and_private_seam(self):
        self.assertTrue(self.service.db.execute('PRAGMA cipher_version').fetchone()[0])
        with self.assertRaises(ServiceError) as caught:
            self.call('portable.fence', {'character_id': 'synthetic'})
        self.assertEqual(caught.exception.code, 'PERMISSION_DENIED')
        from sqlcipher3 import dbapi2
        raw = dbapi2.connect(str(Path(self.temp.name) / 'library/memory.db'))
        try:
            with self.assertRaises(dbapi2.DatabaseError):
                raw.execute('SELECT * FROM characters').fetchall()
        finally: raw.close()

    def test_event_union_roundtrip_unknown_cannot_be_failed(self):
        db = self.service.db
        db.execute('INSERT INTO attention(character,config) VALUES(?,?)', ('synthetic', encode(dict(enabled=True,daily_limit=5,cooldown_seconds=0,quiet_start='',quiet_end='',timezone='UTC',muted=False,focused=False))))
        db.execute('INSERT INTO outreach VALUES(?,?,?,?,?,?,?,?)', ('synthetic','event-1','secret-reservation','secret-binding','old-epoch','reserved',1793577600,'2026-11-02'))
        first = self.summary(); self.assertEqual(first['events'][0]['outcome'], 'unknown')
        self.assertNotIn('secret', encode(first)); self.assertNotIn('event-1', encode(first))
        # B has a distinct lineage/eventKey; stable digest still identifies A's event.
        returned = json.loads(encode(first)); returned['events'][0]['eventKey'] = 'b' * 64
        self.service.portable.merge('synthetic', returned)
        self.service.portable.merge('synthetic', self.summary())
        self.assertEqual(len(self.service.portable.events('synthetic')), 1)
        failed = json.loads(encode(first)); failed['events'][0].update(eventKey='c'*64, outcome='failed', charged=False)
        self.service.portable.merge('synthetic', failed)
        events = self.service.portable.events('synthetic')
        self.assertTrue(events[dedupe('synthetic','event-1')]['charged'])
        self.assertEqual(events[dedupe('synthetic','event-1')]['outcome'], 'unknown')
        self.assertEqual(len(self.summary()['events']),3) # distinct accounting provenance retained
        config = json.loads(db.execute('SELECT config FROM attention').fetchone()[0]); self.assertFalse(config['enabled'])
        config['enabled'] = True
        state = db.execute('SELECT * FROM attention').fetchone()
        self.assertEqual(self.service.portable.attention_reason({'character':'synthetic'}, 'event-1', config, state, False), 'duplicate')
        conflict = json.loads(encode(first)); conflict['events'][0]['createdUtcMs'] += 1
        with self.assertRaises(ServiceError): self.service.portable.merge('synthetic', conflict)
        collision = json.loads(encode(first)); collision['events'][0]['dedupeDigest'] = 'd' * 64
        with self.assertRaises(ServiceError): self.service.portable.merge('synthetic', collision)

    def test_timezone_budget_and_conservative_state(self):
        summary = self.summary(); summary.update(unanswered=5,intensity=.25)
        summary['events'] = [dict(eventKey='1'*64,dedupeDigest='2'*64,createdUtcMs=1793577600000,outcome='sent',charged=True)]
        self.service.portable.merge('synthetic', summary)
        state = self.service.db.execute('SELECT * FROM attention').fetchone()
        self.assertEqual(state['unanswered'],5); self.assertEqual(state['intensity'],.25)
        config = json.loads(state['config']); config.update(enabled=True,daily_limit=4,cooldown_seconds=0,timezone='UTC')
        self.assertEqual(self.service.portable.attention_reason({'character':'synthetic'}, 'new', config, state, False),'daily_budget')
        old = self.service.portable.revision('synthetic')
        self.service.db.execute('UPDATE attention SET unanswered=unanswered+1')
        self.assertGreater(self.service.portable.revision('synthetic'),old)

    def test_unique_begin_receipt_and_latch_ownership(self):
        first, second = self.stage(), self.stage()
        begun = self.internal('begin',operation_id=first['operation_id'],expected_revision=first['revision'])
        with self.assertRaises(ServiceError): self.internal('begin',operation_id=second['operation_id'],expected_revision=second['revision'])
        cancelled = self.internal('cancel',operation_id=second['operation_id'],expected_revision=second['revision'])
        self.assertEqual(cancelled['status'],'cancelled')
        self.assertEqual(self.service.portable.blocked('synthetic')[0],first['operation_id'])
        with self.assertRaises(ServiceError) as caught: self.call('character.activate',{'character_id':'synthetic'})
        self.assertEqual(caught.exception.code,'ROLE_PACKAGE_PAUSED')
        committed = self.internal('commit',operation_id=first['operation_id'],expected_revision=begun['revision'])
        self.assertTrue(committed['receipt']); self.assertTrue(committed['blocked'])
        before = self.service.epoch('synthetic')
        duplicate = self.internal('commit',operation_id=first['operation_id'],expected_revision=committed['revision'])
        self.assertTrue(duplicate['duplicate']); self.assertEqual(self.service.epoch('synthetic'),before)
        # A completely new operation cannot apply the same package again.
        captured = self.service.backups.dispatch('backup.create',dict(character='synthetic',management=True),dict(password='synthetic-long-password'))
        repeat = self.internal('stage',operation_id=uuid.uuid4().hex,package_digest=first['package_digest'],backup_id=captured['backup_id'],password='synthetic-long-password',target_character_id='synthetic',mode='new')
        self.assertTrue(repeat['duplicate']); self.assertEqual(repeat['operation_id'],first['operation_id'])
        published = self.internal('publish',operation_id=first['operation_id'],expected_revision=committed['revision'],persona_digest='a'*64)
        self.service.bump('synthetic') # simulate subsequent legitimate formal write
        with self.assertRaises(ServiceError): self.internal('review',operation_id=first['operation_id'],expected_revision=published['revision'],persona_digest='a'*64,review_digest=published['native_review']['review_digest'])
        self.assertEqual(self.service.epoch('synthetic'),before+1)

    def test_staged_then_new_write_cannot_restore(self):
        stage = self.stage(); begun = self.internal('begin',operation_id=stage['operation_id'],expected_revision=stage['revision'])
        self.service.bump('synthetic')
        with self.assertRaises(ServiceError): self.internal('commit',operation_id=stage['operation_id'],expected_revision=begun['revision'])
        self.assertFalse(self.internal('status',operation_id=stage['operation_id'])['receipt'])
        self.assertTrue(self.service.portable.blocked('synthetic'))

    def test_begin_checks_original_deadline_before_any_formal_mutation(self):
        staged=self.stage();before=self.service.epoch('synthetic')
        for expires in (None,True,'300000',float('nan'),float('inf'),self.now*1000+0.5,self.now*1000-1,self.now*1000):
            with self.subTest(expires=expires),self.assertRaises(ServiceError) as caught:
                self.internal('begin',operation_id=staged['operation_id'],expected_revision=staged['revision'],approval_expires_at=expires)
            self.assertEqual(caught.exception.code,'VERSION_CONFLICT');self.assertTrue(caught.exception.hint)
            self.assertEqual(self.internal('status',operation_id=staged['operation_id'])['status'],'staged')
            self.assertEqual(self.service.epoch('synthetic'),before);self.assertFalse(self.service.portable.blocked('synthetic'))
        begun=self.internal('begin',operation_id=staged['operation_id'],expected_revision=staged['revision'],approval_expires_at=self.now*1000+1)
        self.now+=1
        committed=self.internal('commit',operation_id=staged['operation_id'],expected_revision=begun['revision'])
        self.assertTrue(committed['receipt']);self.assertEqual(committed['status'],'committed_paused')

    def test_begin_rechecks_after_last_target_read_not_before_slow_verification(self):
        staged=self.stage();before=self.service.epoch('synthetic');expires=self.now*1000+1;advanced=[False]
        def slow(statement):
            if not advanced[0] and statement.startswith('SELECT memory_epoch FROM characters'):
                advanced[0]=True;self.now+=1
        self.service.db.set_trace_callback(slow)
        try:
            with self.assertRaises(ServiceError) as caught:self.internal('begin',operation_id=staged['operation_id'],expected_revision=staged['revision'],approval_expires_at=expires)
        finally:self.service.db.set_trace_callback(None)
        self.assertTrue(advanced[0]);self.assertEqual(caught.exception.code,'VERSION_CONFLICT');self.assertTrue(caught.exception.hint)
        self.assertEqual(self.internal('status',operation_id=staged['operation_id'])['status'],'staged')
        self.assertEqual(self.service.epoch('synthetic'),before);self.assertFalse(self.service.portable.blocked('synthetic'))

    def test_bad_password_and_identity_reject_without_target_write(self):
        captured = self.internal('capture',character_id='synthetic',password='synthetic-long-password')
        for password, target, code in [('wrong-password-123','synthetic','BACKUP_AUTH_FAILED'),('synthetic-long-password','other','CHARACTER_ID_CONFLICT')]:
            with self.assertRaises(ServiceError) as caught:
                self.internal('inspect',backup_id=captured['snapshot']['backup_id'],password=password,target_character_id=target,mode='new')
            self.assertEqual(caught.exception.code,code)
        self.assertEqual(self.service.db.execute('SELECT count(*) FROM package_operations').fetchone()[0],0)


@unittest.skipUnless(os.name == 'nt', 'actual Windows DPAPI required')
class Upgrade(unittest.TestCase):
    def old_store(self):
        # Actual historical source from fixed production commit, not a mock reader.
        import subprocess
        source = subprocess.check_output(['git','show','b7bcb08:services/local-capabilities/storage.py'],cwd=ROOT)
        location = Path(self.temp.name) / 'historical_storage.py'; location.write_bytes(source)
        spec = importlib.util.spec_from_file_location('t5_historical_storage',location)
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        return module

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='surfcore-t5-dpapi-')
        self.prior = os.environ.pop('SURFCORE_LOCAL_KEY',None)
        self.old = self.old_store()

    def tearDown(self):
        if self.prior is not None: os.environ['SURFCORE_LOCAL_KEY'] = self.prior
        self.temp.cleanup()

    def test_historical_binary_rejects_actual_envelope_and_preserves_new_write(self):
        directory = Path(self.temp.name) / 'library'
        old = self.old.Store(directory); old.close()
        current = Store(directory)
        current.conn.execute("INSERT INTO characters(id,memory_epoch) VALUES('new-formal-write',77)")
        current.close()
        self.assertNotEqual(len(dpapi((directory/'key.dpapi').read_bytes(),False)),32)
        with self.assertRaises(self.old.ServiceError) as caught: self.old.Store(directory)
        self.assertEqual(caught.exception.code,'KEY_UNAVAILABLE')
        reopened = Store(directory)
        self.assertEqual(reopened.conn.execute("SELECT memory_epoch FROM characters WHERE id='new-formal-write'").fetchone()[0],77)
        reopened.close()
        self.assertTrue((directory/'key.pre-envelope.dpapi').is_file())

    def test_two_real_upgrade_interruptions(self):
        for point in ('before_envelope','after_envelope'):
            with self.subTest(point=point):
                directory = Path(self.temp.name) / point
                old = self.old.Store(directory)
                old.conn.execute("INSERT INTO characters(id,memory_epoch) VALUES('pre-upgrade-fact',33)")
                def crash(phase):
                    if phase == point: raise RuntimeError('synthetic process interruption')
                with self.assertRaises(RuntimeError): prepare(old.conn,directory,directory/'key.dpapi',old._key,False,dpapi,crash)
                old.close()
                self.assertEqual(len(dpapi((directory/'key.dpapi').read_bytes(),False)) != 32,point=='after_envelope')
                reopened = Store(directory)
                self.assertEqual(reopened.conn.execute('PRAGMA user_version').fetchone()[0],1)
                self.assertEqual(reopened.conn.execute("SELECT memory_epoch FROM characters WHERE id='pre-upgrade-fact'").fetchone()[0],33)
                reopened.close()

    def test_missing_or_corrupt_envelope_never_replaces_active_database(self):
        directory = Path(self.temp.name)/'key-errors'
        current = Store(directory); current.conn.execute("INSERT INTO characters(id,memory_epoch) VALUES('formal',19)"); current.close()
        keyfile = directory/'key.dpapi'; valid = keyfile.read_bytes(); before = (directory/'memory.db').read_bytes()
        keyfile.write_bytes(dpapi(b'corrupt-envelope',True))
        with self.assertRaises(ServiceError) as caught: Store(directory)
        self.assertEqual(caught.exception.code,'KEY_UNAVAILABLE'); self.assertEqual((directory/'memory.db').read_bytes(),before)
        keyfile.unlink()
        with self.assertRaises(ServiceError) as caught: Store(directory)
        self.assertEqual(caught.exception.code,'KEY_UNAVAILABLE'); self.assertEqual((directory/'memory.db').read_bytes(),before)
        keyfile.write_bytes(valid); reopened = Store(directory)
        self.assertEqual(reopened.conn.execute("SELECT memory_epoch FROM characters WHERE id='formal'").fetchone()[0],19); reopened.close()

    def test_newer_schema_rejected_before_any_initialization_write(self):
        directory = Path(self.temp.name)/'newer'
        current = Store(directory); current.conn.execute('PRAGMA user_version=999'); current.close()
        before = (directory/'memory.db').read_bytes()
        with self.assertRaises(ServiceError) as caught: Store(directory)
        self.assertEqual(caught.exception.code,'SCHEMA_TOO_NEW')
        self.assertEqual((directory/'memory.db').read_bytes(),before)


if __name__ == '__main__': unittest.main(verbosity=2)
