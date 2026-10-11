import contextlib
import io
import json
import logging
import os
import sys
import tempfile
import unittest
from pathlib import Path

try:
    from controller import BridgeController, WorkerError
except ImportError:
    BridgeController = None
    WorkerError = RuntimeError


class Captured:
    text = ''


@contextlib.contextmanager
def captured_output():
    """Capture fd 1/2 (os.write included), sys.stdout/stderr and logging records."""
    sys.stdout.flush()
    sys.stderr.flush()
    sink = tempfile.TemporaryFile()
    saved = [os.dup(1), os.dup(2)]
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    root = logging.getLogger()
    old_level = root.level
    root.addHandler(handler)
    root.setLevel(logging.DEBUG)
    result = Captured()
    try:
        os.dup2(sink.fileno(), 1)
        os.dup2(sink.fileno(), 2)
        with contextlib.redirect_stdout(stream), contextlib.redirect_stderr(stream):
            yield result
    finally:
        sys.stdout.flush()
        sys.stderr.flush()
        os.dup2(saved[0], 1)
        os.dup2(saved[1], 2)
        os.close(saved[0])
        os.close(saved[1])
        root.removeHandler(handler)
        root.setLevel(old_level)
        sink.seek(0)
        result.text = sink.read().decode('utf-8', 'replace') + stream.getvalue()
        sink.close()


def state_text(directory):
    return ''.join(p.read_bytes().decode('utf-8', 'replace')
                   for p in Path(directory).rglob('*') if p.is_file())


class NativeFixture:
    def __init__(self):
        self.alive = True
        self.on_recover = None
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
        self.alive = True
        if self.on_recover:
            self.on_recover()

    def running(self):
        return self.alive

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
        self.assertEqual(self.controller.credentials(
            'user-a', generation='generation-a', email='mail@example.com')['email'], 'mail@example.com')
        with self.assertRaises(WorkerError):
            self.controller.credentials('user-a', generation='generation-b', email='mail@example.com')

    def test_untrusted_address_is_rejected(self):
        self.start()
        self.native.add_user(addresses=['other@example.com'], split=True)
        self.native.event('finished', userId='user-a')
        self.assertEqual(self.controller.connection_status('attempt-a').errorCode, 'address_mismatch')

    def test_password_not_persisted_or_logged(self):
        with captured_output() as output:
            self.start()
            self.native.event('error', code='unknown', raw='secret-sentinel')
            self.controller.tick()
        self.assertNotIn('secret-sentinel', state_text(self.temp.name) + output.text)

    def test_output_capture_sees_fd_writes(self):
        with captured_output() as output:
            os.write(2, b'fd-two-probe\n')
            os.write(1, b'fd-one-probe\n')
            logging.getLogger('probe').warning('logging-probe')
        self.assertIn('fd-two-probe', output.text)
        self.assertIn('fd-one-probe', output.text)
        self.assertIn('logging-probe', output.text)

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
        with captured_output() as output:
            operation = self.start()
            self.assertEqual((operation.state, operation.errorCode), ('failed', 'worker_unavailable'))
            with self.assertRaisesRegex(WorkerError, '^login_busy$'):
                self.start('attempt-b')
            self.clock += 6
            self.controller.tick()
        self.assertEqual(self.native.recoveries, 1)
        self.assertIn('native_login_failed', output.text)
        self.assertNotIn('secret-sentinel', state_text(self.temp.name) + output.text)

    def test_journal_survives_restart_without_secrets(self):
        with captured_output() as output:
            self.start()
            self.finish()
            self.controller.commit_connection('attempt-a', 'user-a', 'generation-a')
            restarted = BridgeController(self.native, Path(self.temp.name), clock=lambda: self.clock)
            credentials = restarted.credentials('user-a', generation='generation-a',
                                                email='mail@example.com')
        self.assertEqual(credentials['userId'], 'user-a')
        self.assertEqual(restarted.connection_status('attempt-a').state, 'connected')
        self.assertTrue(list(Path(self.temp.name).glob('*.json')))
        self.assertNotIn('secret-sentinel', state_text(self.temp.name) + output.text)

    def test_remove_user_waits_for_absence_and_checks_generation(self):
        self.start()
        self.finish()
        self.controller.commit_connection('attempt-a', 'user-a', 'generation-a')
        email = 'mail@example.com'
        with self.assertRaisesRegex(WorkerError, '^generation_mismatch$'):
            self.controller.remove_user('user-a', 'generation-b', email)
        self.assertEqual(self.controller.remove_user('user-a', 'generation-a', email)['state'], 'removing')
        self.native.event('user_changed', userId='user-a')
        self.assertEqual(self.controller.remove_user('user-a', 'generation-a', email)['state'], 'removing')
        del self.native.users['user-a']
        self.native.event('user_changed', userId='user-a')
        self.assertEqual(self.native.removed_users, ['user-a'])
        with self.assertRaisesRegex(WorkerError, '^not_found$'):
            self.controller.credentials('user-a', generation='generation-a', email=email)

    # -- fix round 1 -------------------------------------------------------------------

    def commit(self, operation_id='attempt-a', email='mail@example.com', generation='generation-a'):
        self.controller.start_connection(operation_id, email, 'secret-sentinel')
        if 'user-a' not in self.native.users:
            self.native.add_user(addresses=['mail@example.com', 'alias@example.com'], split=True)
            self.native.event('finished', userId='user-a')
        else:
            self.native.event('already_logged_in', userId='user-a')
        self.controller.commit_connection(operation_id, 'user-a', generation)

    def test_recovery_reconciles_orphan_attempt_user(self):
        # I-1: the terminal event of a cancelled attempt is lost; the user exists after restart.
        self.start()
        self.controller.cancel_connection('attempt-a')
        self.native.on_recover = lambda: self.native.add_user()
        self.clock += 6
        self.controller.tick()
        self.assertEqual(self.native.recoveries, 1)
        self.assertEqual(self.native.removed_users, ['user-a'])
        with self.assertRaisesRegex(WorkerError, '^login_busy$'):
            self.start('attempt-b')
        del self.native.users['user-a']
        self.native.event('user_changed', userId='user-a')
        self.assertEqual(self.start('attempt-b').state, 'authenticating')

    def test_restart_reconciles_orphan_from_persisted_preexisting(self):
        # I-1: worker crash during an attempt; boot() removes only the attempt-created user.
        self.native.add_user('user-old', addresses=['old@example.com'], split=True)
        self.start()
        self.native.add_user()
        restarted = BridgeController(self.native, Path(self.temp.name), clock=lambda: self.clock,
                                     recovery_seconds=5)
        restarted.boot()
        self.assertEqual(self.native.removed_users, ['user-a'])
        self.assertEqual(restarted.connection_status('attempt-a').state, 'failed')

    def test_dead_process_is_reported_and_recovered(self):
        # I-2: Bridge died while committed users exist.
        self.commit()
        self.native.alive = False
        self.assertEqual(self.controller.health()['state'], 'degraded')
        self.controller.tick()
        self.assertEqual(self.native.recoveries, 1)
        self.assertNotEqual(self.controller.health()['state'], 'degraded')

    def test_stream_loss_triggers_recovery(self):
        # I-2: event stream ended (Bridge quits when its stream drops).
        self.commit()
        self.native.event('stream_ended')
        self.controller.tick()
        self.assertEqual(self.native.recoveries, 1)

    def test_credentials_restart_dead_process(self):
        # I-2: credentials restart Bridge instead of failing forever.
        self.commit()
        self.native.alive = False
        result = self.controller.credentials('user-a', generation='generation-a',
                                             email='mail@example.com')
        self.assertEqual(result['userId'], 'user-a')
        self.assertEqual(self.native.recoveries, 1)

    def test_idle_dead_process_restarts_lazily(self):
        # I-2: with nothing to serve, a dead Bridge is restarted on next use, not by tick.
        self.start()
        self.native.event('error', code='bad_password')
        self.native.alive = False
        self.controller.tick()
        self.assertEqual(self.native.recoveries, 0)
        self.assertEqual(self.controller.health()['state'], 'idle')
        self.start('attempt-b')
        self.assertEqual(self.native.run_event_stream_calls + self.native.recoveries, 2)

    def test_stuck_attempt_removal_does_not_block_logins_forever(self):
        # I-3: RemoveUser of an attempt-owned user never completes.
        self.start()
        self.native.add_user(addresses=['other@example.com'], split=True)
        self.native.event('finished', userId='user-a')
        with self.assertRaisesRegex(WorkerError, '^login_busy$'):
            self.start('attempt-b')
        for _ in range(6):
            self.clock += 121
            self.controller.tick()
        self.assertGreaterEqual(self.native.recoveries, 1)
        self.assertEqual(self.start('attempt-b').state, 'authenticating')

    def test_two_addresses_of_one_user_have_separate_links(self):
        # I-4: links are per (user ID, address).
        self.commit('attempt-a', 'mail@example.com', 'generation-a')
        self.commit('attempt-b', 'alias@example.com', 'generation-b')
        credentials = self.controller.credentials
        self.assertEqual(credentials('user-a', generation='generation-a',
                                     email='mail@example.com')['email'], 'mail@example.com')
        self.assertEqual(credentials('user-a', generation='generation-b',
                                     email='alias@example.com')['email'], 'alias@example.com')
        with self.assertRaisesRegex(WorkerError, '^generation_mismatch$'):
            credentials('user-a', generation='generation-a', email='alias@example.com')
        self.assertEqual(self.controller.remove_user(
            'user-a', 'generation-a', 'mail@example.com')['state'], 'unlinked')
        self.assertEqual(self.native.removed_users, [])
        self.assertEqual(credentials('user-a', generation='generation-b',
                                     email='alias@example.com')['email'], 'alias@example.com')
        self.assertEqual(self.controller.remove_user(
            'user-a', 'generation-b', 'alias@example.com')['state'], 'removing')
        self.assertEqual(self.native.removed_users, ['user-a'])

    def test_link_generation_rotation_is_explicit(self):
        # I-4: recommitting a link with another generation needs the previous one.
        self.commit('attempt-a', 'mail@example.com', 'generation-a')
        self.controller.start_connection('attempt-b', 'mail@example.com', 'secret-sentinel')
        self.native.event('already_logged_in', userId='user-a')
        with self.assertRaisesRegex(WorkerError, '^generation_mismatch$'):
            self.controller.commit_connection('attempt-b', 'user-a', 'generation-b')
        self.controller.commit_connection('attempt-b', 'user-a', 'generation-b',
                                          previous_generation='generation-a')
        with self.assertRaisesRegex(WorkerError, '^generation_mismatch$'):
            self.controller.credentials('user-a', generation='generation-a', email='mail@example.com')

    def test_finished_operations_are_pruned(self):
        # I-5: terminal operations disappear after the ID lifetime, from memory and journal.
        self.start()
        self.native.event('error', code='bad_password')
        self.clock += 601
        self.controller.tick()
        self.assertNotIn('attempt-a', self.controller.operations)
        self.assertNotIn('attempt-a', state_text(self.temp.name))
        with self.assertRaisesRegex(WorkerError, '^not_found$'):
            self.controller.connection_status('attempt-a')

    def test_journal_written_only_on_change(self):
        # I-5: idle ticks do not rewrite the journal.
        self.start()
        writes = []
        original = self.controller._write
        self.controller._write = lambda text: (writes.append(1), original(text))
        for _ in range(5):
            self.controller.tick()
        self.assertEqual(writes, [])
        self.controller.cancel_connection('attempt-a')
        self.assertEqual(len(writes), 1)
