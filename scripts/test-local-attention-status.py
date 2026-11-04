"""Read-only attention projection against disposable SQLCipher stores."""
import importlib.util
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('attention_fixtures', ROOT / 'scripts/test-local-capabilities-service.py')
fixtures = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fixtures)


class AttentionStatus(unittest.TestCase):
    for name in ('setUp', 'tearDown', 'call', 'good', 'bad', 'activate', 'bind', 'configure', 'reserve'):
        locals()[name] = getattr(fixtures.Behavior, name)

    def status(self, binding=None, **params):
        return self.call('attention.status', params, binding or self.pet)

    def test_read_does_not_initialize_or_modify_config(self):
        self.assertTrue(self.service.db.execute('PRAGMA cipher_version').fetchone()[0])
        self.assertEqual(self.service.db.execute('SELECT COUNT(*) FROM attention').fetchone()[0], 0)
        result = self.good(self.status())
        self.assertFalse(result['config']['enabled'])
        self.assertEqual(result['today_count'], 0)
        self.assertIsNone(result['cooldown_until_ms'])
        self.assertEqual(self.service.db.execute('SELECT COUNT(*) FROM attention').fetchone()[0], 0)
        self.configure(enabled=False, daily_limit=4, cooldown_seconds=5400, quiet_start='23:30', quiet_end='08:30')
        before = tuple(self.service.db.execute('SELECT * FROM attention').fetchone())
        self.assertEqual(self.good(self.status())['config'], self.good(self.status(self.owner))['config'])
        self.assertEqual(tuple(self.service.db.execute('SELECT * FROM attention').fetchone()), before)

    def test_no_subject_override_or_nonowner_access(self):
        for binding in (self.bob, self.group1, self.group2, self.public):
            self.bad(self.status(binding), 'PERMISSION_DENIED')
        for params in ({'character': 'other'}, {'enabled': True}, {'outreach_id': 'x'}, {'principal': 'owner'}):
            self.bad(self.status(**params), 'INVALID_REQUEST')
        self.good(self.status(self.alice))
        self.activate('b')
        owner_b = self.bind('owner:local', owner=True, management=True, character='b')
        self.assertEqual(self.good(self.call('attention.status', {}, owner_b, 'b'))['today_count'], 0)
        self.bad(self.call('attention.status', {}, self.owner, 'b'), 'BINDING_INVALID')

    def test_exact_charged_union_and_unanswered_intensity(self):
        self.configure(enabled=True, daily_limit=100, cooldown_seconds=0)
        for index, outcome in enumerate(('sent', 'unknown', 'failed', 'sent')):
            self.now += 10
            self.assertTrue(self.reserve(str(index))['reserved'])
            self.good(self.call('attention.finalize', {'outreach_id': str(index), 'outcome': outcome}, self.pet))
        self.now += 10
        self.assertTrue(self.reserve('in-flight')['reserved'])
        result = self.good(self.status())
        self.assertEqual(result['today_count'], 4)
        self.assertEqual(result['unanswered'], 3)
        self.assertEqual(result['intensity'], .5)
        self.assertEqual(result['effective_daily_limit'], 50)
        # Real portable merge of the same native events must not count them twice.
        self.service.portable.merge('a', self.service.portable.summary('a'))
        self.assertEqual(self.good(self.status())['today_count'], 4)
        self.assertEqual(set(result), {'config', 'today_count', 'effective_daily_limit', 'unanswered',
                                      'intensity', 'cooldown_until_ms', 'local_date'})

    def test_date_and_cooldown_match_authority(self):
        self.configure(enabled=True, daily_limit=4, cooldown_seconds=5400, timezone='UTC')
        reserved = self.reserve('first')
        self.assertTrue(reserved['reserved'])
        self.good(self.call('attention.finalize', {'outreach_id': 'first', 'outcome': 'unknown'}, self.pet))
        result = self.good(self.status())
        self.assertEqual(result['cooldown_until_ms'], round((self.now + 5400) * 1000))
        self.assertEqual(self.good(self.call('attention.check', {'outreach_id': 'second'}, self.pet))['reason'], 'cooldown')
        self.now += 86400
        self.assertEqual(self.good(self.status())['today_count'], 0)
        self.assertTrue(self.good(self.call('attention.check', {'outreach_id': 'second'}, self.pet))['allowed'])


if __name__ == '__main__':
    unittest.main()
