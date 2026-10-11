import contextlib
import io
import json
import tempfile
import unittest
from pathlib import Path

try:
    from controller import BridgeController, WorkerError
except ImportError:
    BridgeController = None
    WorkerError = RuntimeError


class NativeFixture:
    def __init__(self):
        self.users = {}
        self.removed_users = []
        self.run_event_stream_calls = 0
        self.stop_event_stream_calls = 0
        self.recoveries = 0
        self.calls = []

    def start(self, callback):
        self.callback = callback
        self.run_event_stream_calls += 1

    def login(self, email, password):
        self.calls.append(('login', email, password))

    def continue_login(self, email, challenge, secret):
        self.calls.append((challenge, email, secret))

    def abort(self, email):
        self.calls.append(('abort', email))

    def list_users(self):
        return list(self.users)

    def get_user(self, user_id):
        return dict(self.users[user_id])

    def set_split(self, user_id):
        self.calls.append(('split', user_id))

    def credentials(self, user_id, email):
        self.calls.append(('credentials', user_id, email))
        return {'userId': user_id, 'email': email, 'bridgePassword': 'YWJj',
                'certificatePem': 'PUBLIC', 'certificateFingerprint': 'fingerprint',
                'tlsServername': '127.0.0.1'}

    def remove_user(self, user_id):
        self.removed_users.append(user_id)

    def shutdown(self):
        self.stop_event_stream_calls += 1

    def recover(self, callback):
        self.recoveries += 1
        self.callback = callback

    def event(self, kind, **values):
        self.callback({'kind': kind, **values})

    def add_user(self, user_id='user-a', addresses=None, split=False):
        self.users[user_id] = {'id': user_id, 'addresses': addresses or ['mail@example.com'],
                               'state': 2, 'splitMode': split}


class ControllerTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(BridgeController, 'BridgeController is not implemented')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.clock = 100
        self.native = NativeFixture()
        self.controller = BridgeController(self.native, Path(self.temp.name),
                                           clock=lambda: self.clock, recovery_seconds=5)
        self.addCleanup(self.controller.shutdown)

    def start(self, operation_id='attempt-a'):
        return self.controller.start_connection(operation_id, 'mail@example.com', 'secret-sentinel')

    def finish(self, existing=False):
        self.native.add_user()
        self.native.event('already_logged_in' if existing else 'finished', userId='user-a')
        self.native.users['user-a']['splitMode'] = True
        self.native.event('user_changed', userId='user-a')

    def test_one_stream_survives_http_clients(self):
        self.start()
        for _ in range(10):
            self.controller.connection_status('attempt-a')
        self.assertEqual(self.native.run_event_stream_calls, 1)
        self.controller.shutdown()
        self.assertEqual(self.native.stop_event_stream_calls, 1)

    def test_two_logins_are_serialized(self):
        self.start()
        with self.assertRaisesRegex(WorkerError, '^login_busy$'):
            self.start('attempt-b')
        self.assertEqual(len([c for c in self.native.calls if c[0] == 'login']), 1)
        self.assertNotIn('attempt-b', self.controller.operations)

    def test_bad_password_and_hv_have_safe_codes(self):
        self.start()
        self.native.event('error', code='bad_password', raw='secret-sentinel')
        self.assertEqual(self.controller.connection_status('attempt-a').errorCode, 'invalid_credentials')
        self.start('attempt-b')
        self.native.event('hv', hvUrl='https://private.example/secret-sentinel')
        operation = self.controller.connection_status('attempt-b')
        self.assertEqual(operation.errorCode, 'verification_required')
        self.assertNotIn('secret-sentinel', json.dumps(operation.to_dict()))

    def test_2fa_and_second_password_continue_same_attempt(self):
        self.start()
        self.native.event('needs_2fa')
        self.controller.continue_connection('attempt-a', '2fa', '654321')
        self.native.event('needs_second_password')
        self.controller.continue_connection('attempt-a', 'second_password', 'second-sentinel')
        self.finish()
        self.assertEqual(self.controller.connection_status('attempt-a').state, 'connected')
        self.assertEqual(self.native.run_event_stream_calls, 1)

    def test_cancel_does_not_remove_existing_user(self):
        self.native.add_user()
        self.start()
        self.controller.cancel_connection('attempt-a')
        self.native.event('already_logged_in', userId='user-a')
        self.assertEqual(self.native.removed_users, [])
        self.assertEqual(self.controller.connection_status('attempt-a').state, 'cancelled')

    def test_cancel_retains_slot_until_terminal_reconcile(self):
        self.start()
        self.controller.cancel_connection('attempt-a')
        with self.assertRaisesRegex(WorkerError, '^login_busy$'):
            self.start('attempt-b')
        self.native.add_user()
        self.native.event('finished', userId='user-a')
        self.assertEqual(self.native.removed_users, ['user-a'])
        with self.assertRaisesRegex(WorkerError, '^login_busy$'):
            self.start('attempt-b')
        del self.native.users['user-a']
        self.native.event('user_changed', userId='user-a')
        self.assertEqual(self.start('attempt-b').state, 'authenticating')

    def test_stuck_login_recovers_process(self):
        self.start()
        self.controller.cancel_connection('attempt-a')
        self.clock += 6
        self.controller.tick()
        self.assertEqual(self.native.recoveries, 1)
        self.assertEqual(self.start('attempt-b').state, 'authenticating')

    def test_split_confirmed_before_probe(self):
        self.start()
        self.native.add_user()
        self.native.event('finished', userId='user-a')
        self.assertEqual(self.controller.connection_status('attempt-a').state, 'checking')
        with self.assertRaisesRegex(WorkerError, '^not_connected$'):
            self.controller.credentials('user-a', operation_id='attempt-a')
        self.native.event('user_changed', userId='user-a')
        self.assertEqual(self.controller.connection_status('attempt-a').state, 'checking')
        self.native.users['user-a']['splitMode'] = True
        self.native.event('user_changed', userId='user-a')
        self.assertEqual(self.controller.credentials('user-a', operation_id='attempt-a')['bridgePassword'], 'YWJj')

    def test_credentials_bound_to_addresses_user_and_generation(self):
        self.start()
        self.finish()
        with self.assertRaises(WorkerError):
            self.controller.credentials('user-b', operation_id='attempt-a')
        self.controller.commit_connection('attempt-a', 'user-a', 'generation-a')
        self.assertEqual(self.controller.credentials('user-a', generation='generation-a')['email'], 'mail@example.com')
        with self.assertRaises(WorkerError):
            self.controller.credentials('user-a', generation='generation-b')

    def test_untrusted_address_is_rejected(self):
        self.start()
        self.native.add_user(addresses=['other@example.com'], split=True)
        self.native.event('finished', userId='user-a')
        self.assertEqual(self.controller.connection_status('attempt-a').errorCode, 'address_mismatch')

    def test_password_not_persisted_or_logged(self):
        output = io.StringIO()
        with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
            self.start()
            self.native.event('error', code='unknown', raw='secret-sentinel')
        persisted = ''.join(p.read_text() for p in Path(self.temp.name).glob('*.json'))
        self.assertNotIn('secret-sentinel', persisted + output.getvalue())

    def test_expiry_aborts_but_retains_slot(self):
        self.start()
        self.clock += 601
        self.controller.tick()
        self.assertEqual(self.controller.connection_status('attempt-a').state, 'expired')
        with self.assertRaisesRegex(WorkerError, '^login_busy$'):
            self.start('attempt-b')

    def test_native_login_failure_is_safe_and_keeps_slot(self):
        def broken(email, password):
            raise RuntimeError('secret-sentinel')
        self.native.login = broken
        operation = self.start()
        self.assertEqual((operation.state, operation.errorCode), ('failed', 'worker_unavailable'))
        with self.assertRaisesRegex(WorkerError, '^login_busy$'):
            self.start('attempt-b')
        self.clock += 6
        self.controller.tick()
        self.assertEqual(self.native.recoveries, 1)

    def test_journal_survives_restart_without_secrets(self):
        self.start()
        self.finish()
        self.controller.commit_connection('attempt-a', 'user-a', 'generation-a')
        restarted = BridgeController(self.native, Path(self.temp.name), clock=lambda: self.clock)
        self.assertEqual(restarted.credentials('user-a', generation='generation-a')['userId'], 'user-a')
        self.assertEqual(restarted.connection_status('attempt-a').state, 'connected')

    def test_remove_user_waits_for_absence_and_checks_generation(self):
        self.start()
        self.finish()
        self.controller.commit_connection('attempt-a', 'user-a', 'generation-a')
        with self.assertRaisesRegex(WorkerError, '^generation_mismatch$'):
            self.controller.remove_user('user-a', 'generation-b')
        self.assertEqual(self.controller.remove_user('user-a', 'generation-a')['state'], 'removing')
        self.native.event('user_changed', userId='user-a')
        self.assertEqual(self.controller.remove_user('user-a', 'generation-a')['state'], 'removing')
        del self.native.users['user-a']
        self.native.event('user_changed', userId='user-a')
        self.assertEqual(self.native.removed_users, ['user-a'])
        with self.assertRaisesRegex(WorkerError, '^not_found$'):
            self.controller.credentials('user-a', generation='generation-a')
