"""P1: disposable real SQLCipher stores, synthetic sources, no API/device action."""
import importlib.util
import json
import copy
from pathlib import Path
import subprocess
import shutil
import sys
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('metadata_fixtures', ROOT / 'scripts/test-local-capabilities-service.py')
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)
from core import CapabilityService, digest, encode


class Metadata(unittest.TestCase):
    for name in ('tearDown', 'call', 'good', 'bad', 'activate', 'bind', 'epoch', 'ingest', 'query'):
        locals()[name] = getattr(fixtures.Behavior, name)

    def setUp(self):
        fixtures.Behavior.setUp(self)
        self.pet = self.pet_binding()

    def pet_binding(self):
        return self.good(self.call('session.bind', dict(platform='pet', account_id='local', conversation_id='local',
                         principal_id='human:local', audience_scope='pet:local', is_owner=True, management=False)))['session_binding']

    def host(self, binding=None):
        return self.good(self.call('memory.ingress.open', {}, binding or self.pet))['ingress_token']

    def original(self, event, statement='Synthetic original user sentence', binding=None, kind='user_input', **extra):
        binding = binding or self.pet
        return self.ingest(binding, event, statement, ingress=dict(token=self.host(binding), kind=kind), **extra)

    def materials(self, binding=None, **params):
        return self.good(self.call('memory.materials', params, binding or self.pet))['records']

    def metadata(self, identifier, binding=None):
        return next(row['source_metadata'] for row in self.materials(binding) if row['id'] == identifier)

    def reopen(self):
        self.service.close()
        self.service = CapabilityService(self.directory, clock=lambda: self.now)
        self.activate('a')
        self.owner = self.bind('owner:local', owner=True, management=True)
        self.pet = self.pet_binding()
        self.alice = self.bind('qq:private:bot:alice', principal='alice', owner=True)
        self.bob = self.bind('qq:private:bot:bob', principal='bob')
        self.group1 = self.bind('qq:group:bot:one', principal='alice', owner=True)
        self.public = self.bind('bili:public')

    def legacy_store(self, directory=None):
        return self.historical_module('storage.py').Store(directory or self.directory)

    def historical_module(self, filename):
        # Actual pre-P1 reader source, following the existing T5 historical-reader
        # test pattern. No ignored evidence directory is a test dependency.
        source = subprocess.check_output(['git', 'show',
            '9f456d24b3165773b805879a5d59912a1e6af1e2:services/local-capabilities/' + filename], cwd=ROOT)
        location = Path(self.temporary.name) / ('historical_' + filename)
        location.write_bytes(source)
        module_spec = importlib.util.spec_from_file_location('p1_historical_' + filename.replace('.', '_'), location)
        module = importlib.util.module_from_spec(module_spec)
        module_spec.loader.exec_module(module)
        return module

    def restore(self, identifier):
        stage = self.good(self.call('backup.restore.stage', dict(backup_id=identifier, password='synthetic-metadata-password'), self.owner))
        result = self.good(self.call('backup.restore.commit', dict(restore_id=stage['restore_id'], expected_memory_epoch=self.epoch()), self.owner))
        self.activate('a')
        self.owner = self.bind('owner:local', owner=True, management=True)
        self.pet = self.pet_binding()
        return result

    def confirmed(self, event, statement, sources, binding=None, **extra):
        binding = binding or self.pet
        return self.call('memory.assistant-output', dict(source_event_id=event, text=statement,
            expected_memory_epoch=self.epoch(), ingress=dict(token=self.host(binding), kind='confirmed_assistant_output'),
            derived_from=[source['id'] for source in sources], source_revisions={source['id']: source.get('revision', 1) for source in sources}, **extra), binding)

    def test_confirmed_output_dependencies_retire_paraphrase_after_correction_and_delete(self):
        for action in ('correct', 'delete'):
            source = self.good(self.original('owner-' + action, 'Synthetic owner plan ' + action))
            reply = self.good(self.confirmed('reply-' + action, 'I promised to follow the plan ' + action, [source]))
            meta = self.metadata(reply['id'])
            self.assertEqual(meta['source_speaker']['role'], 'assistant')
            self.assertEqual(meta['statement_origin'], 'confirmed_output')
            self.assertTrue(meta['verbatim'])
            self.assertIsNone(meta['source_speaker']['owner_at_receive'])
            self.now += 100
            self.assertTrue(self.good(self.confirmed('reply-' + action, 'different replay', [source]))['duplicate'])
            self.assertEqual(self.metadata(reply['id']), meta)
            params = dict(id=source['id'], expected_revision=1)
            if action == 'correct': params['statement'] = 'New owner plan'
            self.good(self.call('memory.' + action, params, self.owner))
            self.assertNotIn(reply['id'], [row['id'] for row in self.materials()])
            visible = self.good(self.call('memory.query', {}, self.pet))['memories']
            self.assertNotIn(reply['id'], [row['id'] for row in visible])
        self.reopen()
        self.assertFalse(any('I promised' in row['statement'] for row in self.materials()))

    def test_confirmed_output_dedicated_host_contract_and_auto_write(self):
        source = self.good(self.original('host-input'))
        self.bad(self.confirmed('no-sources', 'output', []), 'PERMISSION_DENIED')
        self.bad(self.call('memory.assistant-output', dict(ingress=dict(token=self.host(), kind='confirmed_assistant_output')), self.owner), 'PERMISSION_DENIED')
        self.bad(self.original('generic-ingest-confirmed', kind='confirmed_assistant_output'), 'PERMISSION_DENIED')
        self.bad(self.original('generic-assistant-derived', kind='assistant_output', derived_from=[source['id']]), 'PERMISSION_DENIED')
        self.good(self.call('memory.settings', dict(auto_write=False), self.owner))
        self.bad(self.confirmed('disabled-output', 'body must not persist', [source]), 'AUTO_WRITE_DISABLED')
        self.assertFalse(any('body must not persist' in row['statement'] for row in self.materials()))

    def test_confirmed_output_frame_binds_dependencies_and_restore(self):
        source = self.good(self.original('frame-input'))
        reply = self.good(self.confirmed('frame-output', 'Confirmed output frame', [source]))
        exported = self.good(self.call('memory.export', {}, self.owner))
        self.assertTrue(any(row['memory'] == reply['id'] for row in exported['record_metadata']))
        backup = self.good(self.call('backup.create', dict(password='synthetic-metadata-password'), self.owner))
        self.restore(backup['backup_id'])
        self.assertEqual(self.metadata(reply['id'])['statement_origin'], 'confirmed_output')
        # An old reader changing the dependency frame cannot bless the body.
        self.service.db.execute("UPDATE memories SET derived='[]' WHERE id=?", (reply['id'],))
        self.assertEqual(self.metadata(reply['id'])['source_speaker']['role'], 'unknown')
        self.good(self.call('memory.correct', dict(id=reply['id'], expected_revision=1, statement='Corrected'), self.owner))
        self.assertEqual(self.service.db.execute('SELECT count(*) FROM record_metadata WHERE memory=?', (reply['id'],)).fetchone()[0], 0)

    def test_confirmed_output_missing_proofs_never_projects_or_exports_confirmed_identity(self):
        source = self.good(self.original('missing-proof-source'))
        output = self.good(self.confirmed('missing-proof-output', 'Old confirmed promise', [source]))
        self.service.db.execute('DELETE FROM record_source_revisions WHERE memory=?', (output['id'],))
        self.assertEqual(self.metadata(output['id'])['source_speaker']['role'], 'unknown')
        self.assertFalse(self.metadata(output['id'])['verbatim'])
        exported = self.good(self.call('memory.export', {}, self.owner))
        self.assertNotIn(output['id'], [row['memory'] for row in exported['record_metadata']])
        backup = self.good(self.call('backup.create', dict(password='synthetic-metadata-password'), self.owner))
        self.restore(backup['backup_id'])
        self.assertFalse(self.metadata(output['id'])['verbatim'])
        self.reopen()
        self.assertFalse(self.metadata(output['id'])['verbatim'])

    def test_confirmed_output_corrected_ancestor_retires_metadata_before_old_reader_aba(self):
        source = self.good(self.original('aba-source', 'Old owner fact'))
        output = self.good(self.confirmed('aba-output', 'I repeat the old owner fact', [source]))
        self.good(self.call('memory.correct', dict(id=source['id'], expected_revision=1, statement='New owner fact'), self.owner))
        self.assertEqual(self.service.db.execute('SELECT count(*) FROM record_metadata WHERE memory=?', (output['id'],)).fetchone()[0], 0)
        self.service.db.execute("UPDATE memories SET status='active', revision=1 WHERE id=?", (output['id'],))
        self.service.db.execute('UPDATE record_source_revisions SET revision=2 WHERE memory=?', (output['id'],))
        self.assertFalse(self.metadata(output['id'])['verbatim'])
        self.reopen()
        self.assertFalse(self.metadata(output['id'])['verbatim'])
        exported = self.good(self.call('memory.export', {}, self.owner))
        self.assertNotIn(output['id'], [row['memory'] for row in exported['record_metadata']])

    def test_confirmed_output_frame_binds_proof_revision_even_without_current_correction_hook(self):
        source = self.good(self.original('old-reader-source'))
        output = self.good(self.confirmed('old-reader-output', 'Exact confirmed output', [source]))
        # A pre-extension reader changes the dependency/proof frame directly.
        self.service.db.execute('UPDATE memories SET revision=2 WHERE id=?', (source['id'],))
        self.service.db.execute('UPDATE record_source_revisions SET revision=2 WHERE memory=?', (output['id'],))
        self.assertFalse(self.metadata(output['id'])['verbatim'])
        exported = self.good(self.call('memory.export', {}, self.owner))
        self.assertNotIn(output['id'], [row['memory'] for row in exported['record_metadata']])

    def test_confirmed_output_backup_uses_the_exact_projection_proof_gate(self):
        source = self.good(self.original('backup-proof-source'))
        output = self.good(self.confirmed('backup-proof-output', 'Confirmed backup output', [source]))
        snapshot = self.service.backups.collect('a')
        self.service.backups.validate(snapshot)
        for mode in ('missing', 'changed'):
            broken = copy.deepcopy(snapshot)
            proofs = broken['records']['record_source_revisions']
            if mode == 'missing':
                broken['records']['record_source_revisions'] = [row for row in proofs if row['memory'] != output['id']]
            else:
                next(row for row in proofs if row['memory'] == output['id'])['revision'] = 2
            with self.subTest(mode=mode), self.assertRaises(ValueError):
                self.service.backups.validate(broken)
        old = copy.deepcopy(snapshot)
        old['records'].pop('record_metadata')
        self.service.backups.validate(old)  # Optional metadata remains optional for old packages.

    def test_actual_cipher_new_receipt_and_actor_are_bound(self):
        self.assertTrue(self.service.db.execute('PRAGMA cipher_version').fetchone()[0])
        saved = self.good(self.original('fresh-user'))
        meta = self.metadata(saved['id'])
        self.assertEqual(meta['received_at_ms'], round(self.now * 1000))
        self.assertEqual(meta['time_basis'], 'service_received')
        self.assertEqual(meta['source_speaker'], dict(role='user', principal_id='human:local', owner_at_receive=True))
        self.assertEqual(meta['origin'], dict(platform='pet', account_id='local', conversation_id='local'))
        self.assertEqual(meta['statement_origin'], 'original')
        self.assertTrue(meta['verbatim'])
        self.assertNotEqual((self.directory / 'memory.db').read_bytes()[:16], b'SQLite format 3\x00')

    def test_unproved_refs_and_revision_actor_never_create_speaker_or_clock(self):
        event = 'unproved-original'
        saved = self.good(self.call('memory.ingest', dict(source_event_id=event, text='Old claim',
            source_refs=['writer-origin:user:' + digest(event)], expected_memory_epoch=self.epoch()), self.pet))
        self.service.db.execute("UPDATE revisions SET actor='user' WHERE memory=?", (saved['id'],))
        self.assertIsNone(self.metadata(saved['id'])['received_at_ms'])
        self.assertEqual(self.metadata(saved['id'])['source_speaker']['role'], 'unknown')
        self.assertFalse(self.metadata(saved['id'])['verbatim'])
        self.now += 100000
        self.assertTrue(self.good(self.original(event, 'Changed duplicate'))['duplicate'])
        self.assertIsNone(self.metadata(saved['id'])['received_at_ms'])
        self.assertEqual(self.service.db.execute('SELECT count(*) FROM record_metadata').fetchone()[0], 0)
        for key, value in [('received_at_ms', 1), ('source_metadata', {}), ('speaker', 'user'), ('origin', 'pet')]:
            with self.subTest(key=key):
                self.bad(self.ingest(self.pet, 'forged-' + key, 'Forged metadata', **{key: value}), 'INVALID_REQUEST')

    def test_exact_duplicate_and_correction_keep_original_received_time(self):
        saved = self.good(self.original('stable-event', 'User first sentence'))
        initial = self.metadata(saved['id'])
        self.now += 86400
        self.assertTrue(self.good(self.original('stable-event', 'Changed replay'))['duplicate'])
        self.assertEqual(self.metadata(saved['id']), initial)
        self.good(self.call('memory.correct', dict(id=saved['id'], expected_revision=1, statement='Owner correction'), self.owner))
        meta = self.metadata(saved['id'])
        self.assertEqual(meta['received_at_ms'], initial['received_at_ms'])
        self.assertEqual(meta['statement_origin'], 'revised')
        self.assertFalse(meta['verbatim'])
        self.assertEqual(meta['source_speaker']['role'], 'user')  # Original source, not a claim about revised text.
        self.now += 86400
        self.assertTrue(self.good(self.original('stable-event'))['duplicate'])
        self.assertEqual(self.metadata(saved['id']), meta)

    def test_non_user_channels_and_cached_group_principal_are_not_user_speech(self):
        assistant = self.good(self.original('assistant-output', binding=self.pet, kind='assistant_output'))
        public = self.good(self.original('public-material', binding=self.public, kind='external_source'))
        group = self.good(self.original('group-source', binding=self.group1))
        self.assertEqual(self.metadata(assistant['id'])['source_speaker']['role'], 'assistant')
        self.assertEqual(self.service.db.execute('SELECT owner_at_receive FROM record_metadata WHERE memory=?', (assistant['id'],)).fetchone()[0], 0)
        self.assertEqual(self.metadata(public['id'])['source_speaker']['role'], 'external')
        self.assertEqual(self.metadata(public['id'])['origin'], dict(platform='bili', account_id=None, conversation_id=None))
        meta = self.metadata(group['id'], self.group1)
        self.assertEqual(meta['source_speaker'], dict(role='unknown', principal_id=None, owner_at_receive=None))
        self.assertEqual(meta['origin']['conversation_id'], 'one')
        self.assertIsNotNone(meta['received_at_ms'])
        self.bad(self.original('public-user-forgery', binding=self.public), 'PERMISSION_DENIED')
        self.bad(self.original('pet-external-forgery', kind='external_source'), 'PERMISSION_DENIED')

    def test_binding_generation_management_and_scope_are_not_capabilities(self):
        token = self.host(self.pet)
        self.bad(self.ingest(self.alice, 'wrong-binding', 'No cross-binding stamp',
                            ingress=dict(token=token, kind='user_input')), 'PERMISSION_DENIED')
        self.bad(self.call('memory.ingress.open', {}, self.owner), 'PERMISSION_DENIED')
        self.bad(self.call('memory.materials', {}, self.owner), 'PERMISSION_DENIED')
        self.bad(self.call('memory.propose', dict(source_event_id='proposal', text='Not input', source_refs=[],
                            expected_memory_epoch=self.epoch(), ingress=dict(token=token, kind='user_input')), self.pet), 'PERMISSION_DENIED')
        self.good(self.original('private-source', binding=self.alice))
        self.assertEqual(self.materials(self.bob), [])
        self.assertEqual(self.materials(self.pet), [])
        self.reopen()
        self.bad(self.ingest(self.pet, 'stale-token', 'Old process token', ingress=dict(token=token, kind='user_input')), 'PERMISSION_DENIED')
        self.activate('b')
        other = self.bind('pet:local', owner=True, character='b')
        self.bad(self.call('memory.materials', {}, self.pet, 'b'), 'BINDING_INVALID')
        self.assertEqual(self.good(self.call('memory.materials', {}, other, 'b'))['records'], [])

    def test_derived_chain_and_writer_output_do_not_inherit_user_metadata(self):
        source = self.good(self.original('writer-source', 'User likes tea'))
        child = self.good(self.ingest(self.pet, 'child', 'A derived sentence', derived_from=[source['id']]))
        grandchild = self.good(self.ingest(self.pet, 'grandchild', 'A chained sentence', derived_from=[child['id']]))
        for identifier in (child['id'], grandchild['id']):
            meta = self.metadata(identifier)
            self.assertIsNone(meta['received_at_ms'])
            self.assertEqual(meta['source_speaker']['role'], 'unknown')
            self.assertEqual(meta['statement_origin'], 'derived')
            self.assertFalse(meta['verbatim'])
        self.bad(self.original('forged-derived', derived_from=[source['id']]), 'PERMISSION_DENIED')
        self.good(self.call('memory.proposals.submit', dict(proposal_id='metadata-writer', source_ids=[source['id']],
            source_revisions={source['id']: 1}, expected_memory_epoch=self.epoch(),
            proposals=[dict(operation='add', kind='preference', statement='User prefers tea')]), self.pet))
        result = self.good(self.call('memory.proposals.commit', dict(proposal_id='metadata-writer', expected_memory_epoch=self.epoch()), self.pet))
        self.assertIsNone(self.metadata(result['ids'][0])['received_at_ms'])
        self.assertFalse(self.metadata(result['ids'][0])['verbatim'])
        self.good(self.call('memory.suspend', dict(id=source['id'], expected_revision=1), self.owner))
        self.assertEqual(self.materials(), [])

    def test_bounded_projection_never_expands_audience_or_management(self):
        for index in range(23):
            self.good(self.original('bounded-' + str(index), 'Synthetic item ' + str(index)))
        response = self.good(self.call('memory.materials', dict(limit=4), self.pet))
        self.assertEqual(len(response['records']), 4)
        self.assertTrue(response['has_more'])
        for invalid in [0, 51, True, '20']:
            self.bad(self.call('memory.materials', dict(limit=invalid), self.pet), 'INVALID_REQUEST')
        self.bad(self.call('memory.materials', dict(limit=2, audience_scope='owner:local'), self.pet), 'INVALID_REQUEST')
        self.assertEqual(self.materials(self.bob), [])

    def test_auto_write_off_creates_no_metadata_or_body_and_delete_replay_denied(self):
        source = self.good(self.original('to-delete'))
        self.good(self.call('memory.delete', dict(id=source['id'], expected_revision=1), self.owner))
        self.assertEqual(self.service.db.execute('SELECT count(*) FROM record_metadata').fetchone()[0], 0)
        self.good(self.call('memory.settings', dict(auto_write=False), self.owner))
        before = self.service.db.execute('SELECT count(*) FROM memories').fetchone()[0]
        self.bad(self.original('brand-new-disabled', 'Actually new never-stored content'), 'AUTO_WRITE_DISABLED')
        self.assertEqual(self.service.db.execute('SELECT count(*) FROM memories').fetchone()[0], before)
        self.assertEqual(self.service.db.execute('SELECT count(*) FROM record_metadata').fetchone()[0], 0)
        self.bad(self.original('to-delete'), 'DELETED_SOURCE')
        self.assertEqual(self.materials(), [])

    def test_migration_ignores_claimed_time_and_original_actor(self):
        self.good(self.call('memory.migrate', dict(migration_id='old-data', records=[dict(source_event_id='old-event',
            text='Old migrated statement', received_at_ms=round(self.now * 1000), speaker='user',
            ingress=dict(token=self.host(), kind='user_input'))]), self.owner))
        self.assertEqual(self.service.db.execute('SELECT count(*) FROM record_metadata').fetchone()[0], 0)
        self.assertEqual(self.materials(), [])

    def test_old_reader_correction_delete_rebuild_never_relabels_original(self):
        source = self.good(self.original('old-reader-source'))
        received = self.metadata(source['id'])['received_at_ms']
        self.service.close()
        old = self.legacy_store()
        try:
            old.conn.execute('UPDATE memories SET statement=?,content_hash=?,revision=revision+1 WHERE id=?',
                             ('Old-reader correction', digest('Old-reader correction'), source['id']))
            old.conn.execute('INSERT INTO revisions VALUES(?,?,?,?)', (source['id'], 2, 'Old-reader correction', 'user'))
        finally:
            old.close()
        self.now += 86400
        self.reopen()
        meta = self.metadata(source['id'])
        self.assertIsNone(meta['received_at_ms'])
        self.assertFalse(meta['verbatim'])
        self.assertEqual(meta['statement_origin'], 'unknown')
        self.service.close()
        old = self.legacy_store()
        try:
            row = dict(old.conn.execute('SELECT * FROM memories WHERE id=?', (source['id'],)).fetchone())
            old.conn.execute('DELETE FROM memories WHERE id=?', (source['id'],))
            old.conn.execute('DELETE FROM revisions WHERE memory=?', (source['id'],))
        finally:
            old.close()
        self.reopen()
        self.assertEqual(self.materials(), [])  # Orphan optional metadata is not queryable.
        self.assertEqual(self.service.metadata.export_rows('a'), [])
        self.assertEqual(self.service.db.execute('SELECT count(*) FROM record_metadata').fetchone()[0], 0)
        self.service.close()
        old = self.legacy_store()
        try:
            row.update(statement='Rebuilt unrelated source', event_hash=digest('rebuilt-event'), content_hash=digest('Rebuilt unrelated source'), revision=1)
            columns=list(row)
            old.conn.execute('INSERT INTO memories ('+','.join(columns)+') VALUES('+','.join('?' for _ in columns)+')', [row[k] for k in columns])
            old.conn.execute('INSERT INTO revisions VALUES(?,?,?,?)', (source['id'], 1, row['statement'], 'ingest'))
        finally:
            old.close()
        self.now += 86400
        self.reopen()
        self.assertIsNone(self.metadata(source['id'])['received_at_ms'])
        self.assertFalse(self.metadata(source['id'])['verbatim'])

    def assert_legacy_metadata_invalid_through_correction_and_restore(self, identifier):
        meta = self.metadata(identifier)
        self.assertIsNone(meta['received_at_ms'])
        self.assertEqual(meta['time_basis'], 'unknown')
        self.assertEqual(meta['source_speaker'], dict(role='unknown', principal_id=None, owner_at_receive=None))
        self.assertFalse(meta['verbatim'])
        self.assertEqual(self.good(self.call('memory.export', {}, self.owner))['record_metadata'], [])
        snapshot = self.service.backups.collect('a')
        self.assertEqual(snapshot['records']['record_metadata'], [])
        # The stored stale sidecar is rejected, not silently accepted on import.
        raw = dict(self.service.db.execute('SELECT * FROM record_metadata WHERE memory=?', (identifier,)).fetchone())
        forged = copy.deepcopy(snapshot)
        forged['records']['record_metadata'] = [raw]
        with self.assertRaises(ValueError):
            self.service.backups.validate(forged)
        self.good(self.call('memory.correct', dict(id=identifier, expected_revision=1,
                                                 statement='Legitimate later owner correction'), self.owner))
        self.assertIsNone(self.metadata(identifier)['received_at_ms'])
        self.assertEqual(self.metadata(identifier)['source_speaker']['role'], 'unknown')
        # Retire the invalid frame atomically; skipping an update permits ABA.
        self.assertIsNone(self.service.db.execute('SELECT 1 FROM record_metadata WHERE memory=?',
                                                (identifier,)).fetchone())
        self.assertEqual(self.good(self.call('memory.export', {}, self.owner))['record_metadata'], [])
        backup = self.good(self.call('backup.create', dict(password='synthetic-metadata-password'), self.owner))
        self.now += 86400
        self.restore(backup['backup_id'])
        self.assertIsNone(self.metadata(identifier)['received_at_ms'])
        self.assertEqual(self.metadata(identifier)['source_speaker']['role'], 'unknown')
        self.assertEqual(self.service.db.execute('SELECT count(*) FROM record_metadata').fetchone()[0], 0)

    def test_actual_old_reader_content_hash_only_invalidates_all_metadata_paths(self):
        saved = self.good(self.original('legacy-hash-only', 'Original hash-bound user sentence'))
        self.service.close()
        old = self.legacy_store()
        try:
            changed = digest('Different historical source identity')
            old.conn.execute('UPDATE memories SET content_hash=? WHERE id=?', (changed, saved['id']))
            old.conn.execute('INSERT OR IGNORE INTO fingerprints VALUES(?,?,?,?)', (saved['id'], 'a', 'content', changed))
        finally:
            old.close()
        self.reopen()
        self.assert_legacy_metadata_invalid_through_correction_and_restore(saved['id'])

    def test_actual_old_reader_rebuilt_derived_identity_invalidates_all_metadata_paths(self):
        parent = self.good(self.ingest(self.pet, 'legacy-valid-parent', 'An independent unproved ancestor'))
        for number, (kind, derived) in enumerate((('preference', []), ('episode', [parent['id']]),
                                                ('preference', [parent['id']]))):
            with self.subTest(kind=kind, derived=bool(derived)):
                saved = self.good(self.original('legacy-rebuilt-' + str(number), 'Actual user sentence ' + str(number)))
                self.service.close()
                old = self.legacy_store()
                try:
                    old.conn.execute('UPDATE memories SET kind=?,derived=? WHERE id=?', (kind, encode(derived), saved['id']))
                    if derived:
                        old.conn.execute('INSERT INTO record_source_revisions VALUES(?,?,?)', (saved['id'], parent['id'], 1))
                finally:
                    old.close()
                self.reopen()
                self.assert_legacy_metadata_invalid_through_correction_and_restore(saved['id'])

    def test_actual_old_reader_revision_aba_cannot_reattach_invalid_metadata(self):
        first, corrected = 'Original ABA sentence', 'Legitimate corrected ABA sentence'
        saved = self.good(self.original('old-reader-aba', first))
        received = self.metadata(saved['id'])['received_at_ms']
        self.good(self.call('memory.correct', dict(id=saved['id'], expected_revision=1, statement=corrected), self.owner))
        self.assertEqual(self.metadata(saved['id'])['received_at_ms'], received)
        self.assertEqual(self.service.db.execute('SELECT record_revision FROM record_metadata WHERE memory=?',
                                                (saved['id'],)).fetchone()[0], 2)
        self.service.close()
        old = self.legacy_store()
        try:
            old.conn.execute('UPDATE memories SET revision=1,statement=? WHERE id=?', (first, saved['id']))
            old.conn.execute('DELETE FROM revisions WHERE memory=? AND revision>1', (saved['id'],))
        finally:
            old.close()
        self.reopen()
        self.assertIsNone(self.metadata(saved['id'])['received_at_ms'])
        from sqlcipher3 import dbapi2
        dispatch = self.service.dispatch
        def deny_commit(action, first, second, database, trigger):
            return dbapi2.SQLITE_DENY if action == dbapi2.SQLITE_TRANSACTION and first == 'COMMIT' else dbapi2.SQLITE_OK
        def fail_after_correction(op, request, params):
            result = dispatch(op, request, params)
            if op == 'memory.correct':
                self.service.db.set_authorizer(deny_commit)
            return result
        self.service.dispatch = fail_after_correction
        before_epoch = self.epoch()
        try:
            self.bad(self.call('memory.correct', dict(id=saved['id'], expected_revision=1,
                                                    statement=corrected), self.owner), 'SERVICE_UNAVAILABLE')
        finally:
            self.service.db.set_authorizer(None)
            self.service.dispatch = dispatch
        self.assertEqual(self.epoch(), before_epoch)
        self.assertEqual(self.service.db.execute('SELECT revision FROM memories WHERE id=?', (saved['id'],)).fetchone()[0], 1)
        self.assertEqual(self.service.db.execute('SELECT record_revision FROM record_metadata WHERE memory=?',
                                                (saved['id'],)).fetchone()[0], 2)
        self.assertIsNone(self.metadata(saved['id'])['received_at_ms'])
        # Returning to precisely the prior valid revision/body must not resurrect
        # a receipt that was invalid before this legitimate correction began.
        self.good(self.call('memory.correct', dict(id=saved['id'], expected_revision=1, statement=corrected), self.owner))
        self.assertIsNone(self.metadata(saved['id'])['received_at_ms'])
        self.assertEqual(self.metadata(saved['id'])['source_speaker']['role'], 'unknown')
        self.assertIsNone(self.service.db.execute('SELECT 1 FROM record_metadata WHERE memory=?', (saved['id'],)).fetchone())
        self.assertEqual(self.good(self.call('memory.export', {}, self.owner))['record_metadata'], [])
        backup = self.good(self.call('backup.create', dict(password='synthetic-metadata-password'), self.owner))
        self.restore(backup['backup_id'])
        self.assertIsNone(self.metadata(saved['id'])['received_at_ms'])

    def test_pre_metadata_database_upgrade_has_no_invented_clock(self):
        self.service.close()
        directory = self.directory / 'actual-old-schema'
        old = self.legacy_store(directory)
        try:
            old.conn.execute("INSERT INTO characters(id) VALUES('a')")
            old.conn.execute('INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
                ('old-id', 'a', 'pet:local', 'human:local', 'Actual pre-metadata record', 1, 'active', 0,
                 digest('old-event'), digest('Actual pre-metadata record'), '[]', '[]', 'episode'))
            old.conn.execute('INSERT INTO revisions VALUES(?,?,?,?)', ('old-id', 1, 'Actual pre-metadata record', 'user'))
            self.assertFalse(old.conn.execute("SELECT 1 FROM sqlite_master WHERE name='record_metadata'").fetchone())
        finally:
            old.close()
        self.directory = directory
        self.reopen()
        meta = self.metadata('old-id')
        self.assertIsNone(meta['received_at_ms'])
        self.assertEqual(meta['source_speaker']['role'], 'unknown')
        self.assertEqual(self.service.db.execute('PRAGMA user_version').fetchone()[0], 1)

    def test_metadata_and_source_rollback_together_on_commit_failure(self):
        from sqlcipher3 import dbapi2
        token = self.host()
        seen = [False]
        def authorizer(action, first, second, database, trigger):
            if action == dbapi2.SQLITE_TRANSACTION and first == 'COMMIT':
                return dbapi2.SQLITE_DENY
            return dbapi2.SQLITE_OK
        dispatch = self.service.dispatch
        def inject_commit_failure(op, request, params):
            result = dispatch(op, request, params)
            if op == 'memory.ingest':
                seen[0] = self.service.db.execute('SELECT count(*) FROM record_metadata').fetchone()[0] == 1
                # Installing after the write invalidates any COMMIT prepared by
                # request polling, so denial happens at the real owning commit.
                self.service.db.set_authorizer(authorizer)
            return result
        self.service.dispatch = inject_commit_failure
        try:
            self.bad(self.ingest(self.pet, 'rollback-source', 'Atomic metadata',
                                ingress=dict(token=token, kind='user_input')), 'SERVICE_UNAVAILABLE')
        finally:
            self.service.db.set_authorizer(None)
            self.service.dispatch = dispatch
        self.assertTrue(seen[0])
        self.assertEqual(self.service.db.execute('SELECT count(*) FROM memories').fetchone()[0], 0)
        self.assertEqual(self.service.db.execute('SELECT count(*) FROM record_metadata').fetchone()[0], 0)
        self.assertEqual(self.epoch(), 0)

    def test_export_and_new_backup_restore_preserve_original_time_and_revised_frame(self):
        saved = self.good(self.original('backup-original', 'Before correction'))
        received = self.metadata(saved['id'])['received_at_ms']
        self.good(self.call('memory.correct', dict(id=saved['id'], expected_revision=1, statement='Corrected before backup'), self.owner))
        exported = self.good(self.call('memory.export', {}, self.owner))
        self.assertEqual(len(exported['record_metadata']), 1)
        self.assertEqual(exported['record_metadata'][0]['record_revision'], 2)
        self.assertNotIn('ingress_token', encode(exported))
        self.bad(self.call('memory.export', {}, self.pet), 'PERMISSION_DENIED')
        backup = self.good(self.call('backup.create', dict(password='synthetic-metadata-password'), self.owner))
        from backup import COLUMNS
        self.assertEqual(set(backup['manifest']['counts']), set(COLUMNS))
        self.assertEqual(backup['manifest']['format_version'], 1)
        self.now += 10 * 86400
        self.good(self.call('memory.correct', dict(id=saved['id'], expected_revision=2, statement='Later content'), self.owner))
        self.restore(backup['backup_id'])
        self.assertEqual(self.materials()[0]['statement'], 'Corrected before backup')
        meta = self.metadata(saved['id'])
        self.assertEqual(meta['received_at_ms'], received)
        self.assertEqual(meta['statement_origin'], 'revised')
        self.assertFalse(meta['verbatim'])
        self.assertNotEqual(meta['received_at_ms'], round(self.now * 1000))

    def test_actual_old_snapshot_reads_as_unknown_and_old_reader_rejects_sidecar(self):
        self.good(self.original('snapshot-compatibility'))
        newest = self.good(self.call('backup.create', dict(password='synthetic-metadata-password'), self.owner))
        old_manager = self.historical_module('backup.py').BackupManager(self.service)
        from storage import ServiceError
        with self.assertRaises(ServiceError) as caught:
            old_manager.open_backup(newest['backup_id'], 'synthetic-metadata-password')
        self.assertEqual(caught.exception.code, 'BACKUP_CORRUPT')
        current = self.service.backups
        self.service.backups = old_manager
        try:
            old_backup = self.good(self.call('backup.create', dict(password='synthetic-metadata-password'), self.owner))
        finally:
            self.service.backups = current
        self.now += 86400
        self.restore(old_backup['backup_id'])
        self.assertIsNone(self.materials()[0]['source_metadata']['received_at_ms'])
        self.assertEqual(self.service.db.execute('SELECT count(*) FROM record_metadata').fetchone()[0], 0)

    def test_backup_delete_ledger_removes_source_and_metadata_after_restart(self):
        saved = self.good(self.original('deleted-before-restore'))
        identifier = self.good(self.call('backup.create', dict(password='synthetic-metadata-password'), self.owner))['backup_id']
        self.good(self.call('memory.delete', dict(id=saved['id'], expected_revision=1), self.owner))
        self.restore(identifier)
        self.reopen()
        self.assertEqual(self.materials(), [])
        self.assertEqual(self.service.db.execute('SELECT count(*) FROM record_metadata').fetchone()[0], 0)
        self.bad(self.original('deleted-before-restore'), 'DELETED_SOURCE')

    def test_sidecar_duplicate_orphan_and_forged_frame_are_rejected(self):
        saved = self.good(self.original('validated-sidecar'))
        data = self.service.backups.collect('a')
        self.service.backups.validate(data)
        mutations = [
            lambda d: d['records']['record_metadata'].append(dict(d['records']['record_metadata'][0])),
            lambda d: d['records']['record_metadata'][0].update(memory='orphan'),
            lambda d: d['records']['record_metadata'][0].update(record_revision=2),
            lambda d: d['records']['record_metadata'][0].update(record_content_hash='f' * 64),
            lambda d: d['records']['record_metadata'][0].update(scope='owner:local'),
            lambda d: d['records']['record_metadata'][0].update(bound_principal='other-person'),
            lambda d: d['records']['record_metadata'][0].update(source_kind='external_source'),
            lambda d: d['records']['record_metadata'][0].update(source_kind='assistant_output'),
            lambda d: d['records']['record_metadata'][0].update(received_at_ms=True),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutations.index(mutate)):
                corrupt = copy.deepcopy(data)
                mutate(corrupt)
                with self.assertRaises((ValueError, KeyError)):
                    self.service.backups.validate(corrupt)
        self.good(self.call('memory.suspend', dict(id=saved['id'], expected_revision=1), self.owner))
        self.assertEqual(self.materials(), [])

    def test_portable_native_restore_preserves_metadata_without_ingress_token(self):
        saved = self.good(self.original('portable-original'))
        received = self.metadata(saved['id'])['received_at_ms']
        old_token = self.host()
        def internal(operation, **params):
            return self.good(self.call('portable.' + operation, params, portable_coordinator=self.service.portable.token))
        captured = internal('capture', character_id='a', password='synthetic-metadata-password')
        stage = internal('stage', operation_id=uuid.uuid4().hex, package_digest='c' * 64,
                         backup_id=captured['snapshot']['backup_id'], password='synthetic-metadata-password',
                         target_character_id='a', mode='restore_same_id', expected_memory_epoch=self.epoch(),
                         persona_digest='a' * 64, attention_id=captured['attention_id'])
        begun = internal('begin', operation_id=stage['operation_id'], expected_revision=stage['revision'],
                         approval_expires_at=round(self.now * 1000 + 300000))
        self.bad(self.call('memory.materials', {}, self.pet), 'ROLE_PACKAGE_PAUSED')
        self.now += 86400
        committed = internal('commit', operation_id=stage['operation_id'], expected_revision=begun['revision'])
        published = internal('publish', operation_id=stage['operation_id'], expected_revision=committed['revision'], persona_digest='a' * 64)
        internal('review', operation_id=stage['operation_id'], expected_revision=published['revision'],
                 persona_digest='a' * 64, review_digest=published['native_review']['review_digest'])
        self.activate('a')
        self.owner = self.bind('owner:local', owner=True, management=True)
        self.pet = self.pet_binding()
        self.assertEqual(self.metadata(saved['id'])['received_at_ms'], received)
        self.bad(self.ingest(self.pet, 'token-not-portable', 'Old source token cannot migrate',
                            ingress=dict(token=old_token, kind='user_input')), 'PERMISSION_DENIED')

    def test_shared_owner_scope_preserves_original_transport_not_current_reader(self):
        shared_pet = self.good(self.call('session.bind', dict(platform='pet', account_id='local', conversation_id='local',
            principal_id='human:local', audience_scope='owner:local', is_owner=True, management=False)))['session_binding']
        shared_qq = self.good(self.call('session.bind', dict(platform='qq', account_id='bot', conversation_id='alice',
            principal_id='alice', audience_scope='owner:local', is_owner=True, management=False)))['session_binding']
        source = self.good(self.original('shared-pet-original', binding=shared_pet))
        meta = self.metadata(source['id'], shared_qq)
        self.assertEqual(meta['origin']['platform'], 'pet')
        self.assertEqual(meta['source_speaker']['principal_id'], 'human:local')
        self.assertEqual(self.materials(self.bob), [])
        self.assertEqual(self.materials(self.group2), [])

    def test_private_ancestor_cannot_expose_derived_metadata_to_shared_reader(self):
        source = self.good(self.original('pet-private-ancestor'))
        self.good(self.ingest(self.owner, 'owner-derived', 'Private-derived material', derived_from=[source['id']]))
        shared_qq = self.good(self.call('session.bind', dict(platform='qq', account_id='bot', conversation_id='alice',
            principal_id='alice', audience_scope='owner:local', is_owner=True, management=False)))['session_binding']
        self.assertEqual(self.materials(shared_qq), [])
        self.reopen()
        shared_qq = self.good(self.call('session.bind', dict(platform='qq', account_id='bot', conversation_id='alice',
            principal_id='alice', audience_scope='owner:local', is_owner=True, management=False)))['session_binding']
        self.assertEqual(self.materials(shared_qq), [])

    def test_old_physical_main_replay_cannot_restore_deleted_metadata(self):
        source = self.good(self.original('physical-replay'))
        self.service.close()
        snapshot = self.directory / 'synthetic-before-delete.db'
        shutil.copy2(self.directory / 'memory.db', snapshot)
        self.reopen()
        self.good(self.call('memory.delete', dict(id=source['id'], expected_revision=1), self.owner))
        self.service.close()
        # Only this TemporaryDirectory's synthetic main file is replaced. The
        # independent latest ledger remains in place, exactly as in old-file replay.
        self.assertTrue(snapshot.resolve().is_relative_to(Path(self.temporary.name).resolve()))
        shutil.copy2(snapshot, self.directory / 'memory.db')
        self.now += 86400
        self.reopen()
        self.assertEqual(self.materials(), [])
        self.assertEqual(self.service.db.execute('SELECT count(*) FROM record_metadata').fetchone()[0], 0)
        self.bad(self.original('physical-replay'), 'DELETED_SOURCE')

    def test_optional_sidecar_is_in_byte_limit_and_full_encrypted_file_hash(self):
        from unittest.mock import patch
        from backup import snapshot_connection
        self.good(self.original('sidecar-integrity'))
        data = self.service.backups.collect('a')
        legacy = copy.deepcopy(data)
        legacy['records'].pop('record_metadata')
        limit = (len(encode(data).encode('utf-8')) + len(encode(legacy).encode('utf-8'))) // 2
        with patch('backup.MAX_BYTES', limit):
            self.service.backups.validate(legacy)
            with self.assertRaises(ValueError):
                self.service.backups.validate(data)
        backup = self.good(self.call('backup.create', dict(password='synthetic-metadata-password'), self.owner))
        file = self.service.backups.owned('backups', backup['backup_id'], '.db')
        connection = snapshot_connection(file, self.service.backups.key('synthetic-metadata-password', backup['manifest']['salt']))
        try:
            encoded = connection.execute("SELECT payload FROM snapshot_rows WHERE name='record_metadata'").fetchone()[0]
            metadata = json.loads(encoded)
            metadata[0]['received_at_ms'] += 1
            connection.execute("UPDATE snapshot_rows SET payload=? WHERE name='record_metadata'", (encode(metadata),))
        finally:
            connection.close()
        self.bad(self.call('backup.inspect', dict(backup_id=backup['backup_id'], password='synthetic-metadata-password'), self.owner), 'BACKUP_CORRUPT')


if __name__ == '__main__':
    unittest.main()
