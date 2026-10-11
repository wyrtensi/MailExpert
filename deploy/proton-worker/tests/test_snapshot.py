"""Snapshot admission gate and send leases (Task 9).

A backup captures the worker state only while no Proton send is in flight and native Bridge
has exited: /snapshot/begin closes the gate, drains send leases within a bounded wait and
stops Bridge; /snapshot/end reopens the gate and starts Bridge again when it is needed.
"""

import http.client
import json
import socket
import tempfile
import threading
import unittest
from pathlib import Path

from test_controller import NativeFixture

try:
    from controller import BridgeController, WorkerError
    from worker import create_server
except ImportError:
    BridgeController = None
    WorkerError = RuntimeError
    create_server = None


class StoppingNative(NativeFixture):
    """Records shutdown as a confirmed process exit, like NativeBridge.shutdown()."""

    def __init__(self):
        super().__init__()
        self.starts = 0
        self.exit_confirmed = 0

    def start(self, callback):
        super().start(callback)
        self.starts += 1
        self.alive = True

    def shutdown(self):
        super().shutdown()
        self.alive = False
        self.exit_confirmed += 1


class SnapshotGateTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(BridgeController, 'BridgeController is not implemented')
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.clock = 100
        self.native = StoppingNative()
        self.controller = self.make()
        self.addCleanup(self.controller.shutdown)

    def make(self):
        return BridgeController(self.native, Path(self.temp.name), clock=lambda: self.clock,
                                recovery_seconds=5, snapshot_wait_seconds=0.2,
                                snapshot_ttl_seconds=300)

    def link(self):
        self.controller.start_connection('attempt-a', 'mail@example.com', 'secret-sentinel')
        self.native.add_user()
        self.native.event('finished', userId='user-a')
        self.native.users['user-a']['splitMode'] = True
        self.native.event('user_changed', userId='user-a')
        self.controller.commit_connection('attempt-a', 'user-a', 'gen-1')

    def test_snapshot_stops_bridge_and_restarts_it(self):
        self.link()
        result = self.controller.snapshot_begin('snap-1')
        self.assertEqual(result['state'], 'snapshot')
        self.assertEqual(self.native.exit_confirmed, 1)
        self.assertFalse(self.native.running())
        self.controller.tick()
        self.assertFalse(self.native.running(), 'tick must not restart Bridge during a snapshot')
        self.controller.snapshot_end('snap-1')
        self.assertTrue(self.native.running())
        self.assertEqual(self.native.starts, 2)

    def test_quit_ack_is_not_exit(self):
        # The gate reports success only after the adapter confirmed the process exit.
        self.link()
        calls = []
        original = self.native.shutdown

        def shutdown():
            calls.append('quit')
            original()
            calls.append('exit')

        self.native.shutdown = shutdown
        self.controller.snapshot_begin('snap-1')
        self.assertEqual(calls, ['quit', 'exit'])
        self.assertFalse(self.native.running())

    def test_gate_blocks_new_sends_and_lifecycle(self):
        self.link()
        self.controller.snapshot_begin('snap-1')
        with self.assertRaisesRegex(WorkerError, '^maintenance_busy$'):
            self.controller.acquire_send_lease()
        with self.assertRaisesRegex(WorkerError, '^login_busy$'):
            self.controller.start_connection('attempt-b', 'other@example.com', 'secret-sentinel')
        with self.assertRaisesRegex(WorkerError, '^maintenance_busy$'):
            self.controller.credentials('user-a', generation='gen-1', email='mail@example.com')
        with self.assertRaisesRegex(WorkerError, '^maintenance_busy$'):
            self.controller.remove_user('user-a', 'gen-1', 'mail@example.com')
        with self.assertRaisesRegex(WorkerError, '^maintenance_busy$'):
            self.controller.commit_connection('attempt-a', 'user-a', 'gen-2', previous_generation='gen-1')
        self.assertEqual(self.controller.health()['state'], 'snapshot')
        self.controller.snapshot_end('snap-1')
        lease = self.controller.acquire_send_lease()
        self.assertTrue(lease['leaseId'])

    def test_living_stalled_sender_makes_snapshot_busy(self):
        self.link()
        lease = self.controller.acquire_send_lease()
        # A live lease never expires by time: an hour later the snapshot is still refused.
        self.clock += 3600
        self.controller.tick()
        with self.assertRaisesRegex(WorkerError, '^snapshot_busy$'):
            self.controller.snapshot_begin('snap-1')
        self.assertEqual(self.native.exit_confirmed, 0)
        self.assertTrue(self.native.running())
        self.assertEqual(self.controller.health()['sendLeases'], 1)
        self.controller.release_send_lease(lease['leaseId'])
        self.assertEqual(self.controller.snapshot_begin('snap-2')['state'], 'snapshot')

    def test_snapshot_failure_releases_gate(self):
        self.link()
        lease = self.controller.acquire_send_lease()
        with self.assertRaises(WorkerError):
            self.controller.snapshot_begin('snap-1')
        # The gate is open again: new sends are admitted, nothing is left half-closed.
        self.assertTrue(self.controller.acquire_send_lease()['leaseId'])
        self.controller.release_send_lease(lease['leaseId'])
        self.assertNotEqual(self.controller.health()['state'], 'snapshot')

    def test_native_stop_failure_releases_gate(self):
        self.link()

        def broken():
            raise RuntimeError('secret-sentinel')

        original = self.native.shutdown
        self.native.shutdown = broken
        self.addCleanup(setattr, self.native, 'shutdown', original)
        with self.assertRaisesRegex(WorkerError, '^worker_unavailable$'):
            self.controller.snapshot_begin('snap-1')
        self.assertTrue(self.controller.acquire_send_lease()['leaseId'])

    def test_snapshot_waits_for_draining_sender(self):
        self.link()
        self.controller.snapshot_wait_seconds = 5
        lease = self.controller.acquire_send_lease()
        timer = threading.Timer(0.2, self.controller.release_send_lease, [lease['leaseId']])
        timer.start()
        self.addCleanup(timer.cancel)
        self.assertEqual(self.controller.snapshot_begin('snap-1')['state'], 'snapshot')
        self.assertEqual(self.native.exit_confirmed, 1)

    def test_active_login_makes_snapshot_busy(self):
        self.controller.start_connection('attempt-a', 'mail@example.com', 'secret-sentinel')
        with self.assertRaisesRegex(WorkerError, '^snapshot_busy$'):
            self.controller.snapshot_begin('snap-1')

    def test_orphan_lease_cleared_only_after_old_backend_stopped(self):
        # Leases live in memory only: a timeout never frees them, a controlled worker
        # recreation (after the old backend stopped) does.
        self.link()
        self.controller.acquire_send_lease()
        self.clock += 86400
        self.controller.tick()
        self.assertEqual(self.controller.health()['sendLeases'], 1)
        self.assertNotIn('lease', Path(self.temp.name, 'controller.json').read_text().lower())
        self.controller.shutdown()
        recreated = self.make()
        self.addCleanup(recreated.shutdown)
        self.assertEqual(recreated.health()['sendLeases'], 0)
        self.assertEqual(recreated.snapshot_begin('snap-1')['state'], 'snapshot')

    def test_snapshot_end_is_idempotent_and_checks_id(self):
        self.link()
        self.controller.snapshot_begin('snap-1')
        with self.assertRaisesRegex(WorkerError, '^operation_conflict$'):
            self.controller.snapshot_end('snap-2')
        with self.assertRaisesRegex(WorkerError, '^operation_conflict$'):
            self.controller.snapshot_begin('snap-2')
        self.controller.snapshot_end('snap-1')
        self.controller.snapshot_end('snap-1')
        self.assertEqual(self.native.starts, 2)

    def test_idle_worker_snapshot_needs_no_bridge(self):
        result = self.controller.snapshot_begin('snap-1')
        self.assertEqual(result['state'], 'snapshot')
        self.assertEqual(self.native.exit_confirmed, 0)
        self.controller.snapshot_end('snap-1')
        self.assertEqual(self.native.starts, 0)

    def test_unknown_lease_release_is_harmless(self):
        self.assertEqual(self.controller.release_send_lease('missing-lease'), {'released': False})
        with self.assertRaisesRegex(WorkerError, '^worker_invalid_request$'):
            self.controller.release_send_lease('../x')


    # -- fix round 1: a gate whose holder died, leases the backend gave up on ------------
    def test_gate_of_a_dead_holder_expires_and_bridge_restarts(self):
        self.link()
        self.controller.snapshot_begin('snap-1')
        self.assertEqual(self.controller.health()['snapshotId'], 'snap-1')
        self.clock += 299
        self.controller.tick()
        self.assertEqual(self.controller.health()['state'], 'snapshot')
        self.clock += 2
        self.controller.tick()
        health = self.controller.health()
        self.assertNotEqual(health['state'], 'snapshot')
        self.assertIsNone(health['snapshotId'])
        self.assertTrue(self.native.running())
        self.assertTrue(self.controller.acquire_send_lease('lease-a')['leaseId'])

    def test_renewal_keeps_the_gate_of_a_live_holder(self):
        self.link()
        self.controller.snapshot_begin('snap-1')
        for _ in range(4):
            self.clock += 200
            self.controller.snapshot_renew('snap-1')
            self.controller.tick()
        self.assertEqual(self.controller.health()['state'], 'snapshot')
        with self.assertRaisesRegex(WorkerError, '^operation_conflict$'):
            self.controller.snapshot_renew('snap-2')

    def test_expired_gate_is_reclaimed_by_a_new_begin(self):
        self.link()
        self.controller.snapshot_begin('snap-1')
        with self.assertRaisesRegex(WorkerError, '^operation_conflict$'):
            self.controller.snapshot_begin('snap-2')
        self.clock += 301
        self.assertEqual(self.controller.snapshot_begin('snap-2')['snapshotId'], 'snap-2')
        with self.assertRaisesRegex(WorkerError, '^operation_conflict$'):
            self.controller.snapshot_renew('snap-1')

    def test_end_reports_whether_it_closed_the_callers_gate(self):
        self.link()
        self.controller.snapshot_begin('snap-1')
        self.assertTrue(self.controller.snapshot_end('snap-1')['ended'])
        # The gate is gone already (expired, a worker restart): the caller learns it.
        self.assertFalse(self.controller.snapshot_end('snap-1')['ended'])
        self.controller.snapshot_begin('snap-2')
        self.clock += 301
        self.controller.tick()
        self.assertFalse(self.controller.snapshot_end('snap-2')['ended'])

    def test_backend_lease_id_is_idempotent(self):
        self.assertEqual(self.controller.acquire_send_lease('lease-a'), {'leaseId': 'lease-a'})
        self.assertEqual(self.controller.acquire_send_lease('lease-a'), {'leaseId': 'lease-a'})
        self.assertEqual(self.controller.health()['sendLeases'], 1)
        self.assertEqual(self.controller.release_send_lease('lease-a'), {'released': True})
        self.assertEqual(self.controller.health()['sendLeases'], 0)

    def test_late_grant_after_cancel_is_released_at_once(self):
        # The backend gave up and sent DELETE before the worker handled its POST.
        self.assertEqual(self.controller.release_send_lease('lease-b'), {'released': False})
        with self.assertRaisesRegex(WorkerError, '^lease_cancelled$'):
            self.controller.acquire_send_lease('lease-b')
        self.assertEqual(self.controller.health()['sendLeases'], 0)
        self.link()
        self.assertEqual(self.controller.snapshot_begin('snap-1')['state'], 'snapshot')


class SnapshotRouteTests(unittest.TestCase):
    def call(self, pathname, method, path, body=None):
        client = socket.socket(socket.AF_UNIX)
        client.connect(str(pathname))
        connection = http.client.HTTPConnection('localhost')
        connection.sock = client
        data = json.dumps(body).encode() if body is not None else None
        headers = {'Content-Type': 'application/json'} if data else {}
        connection.request(method, path, body=data, headers=headers)
        response = connection.getresponse()
        result = response.status, json.loads(response.read() or b'{}')
        connection.close()
        return result

    def test_lease_and_snapshot_routes(self):
        self.assertIsNotNone(create_server, 'UNIX worker is not implemented')
        seen = []

        class Controller:
            def acquire_send_lease(self, lease_id=None):
                seen.append(('acquire', lease_id))
                return {'leaseId': lease_id}

            def snapshot_renew(self, snapshot_id):
                seen.append(('renew', snapshot_id))
                return {'state': 'snapshot'}

            def release_send_lease(self, lease_id):
                seen.append(('release', lease_id))
                return {'released': True}

            def snapshot_begin(self, snapshot_id):
                seen.append(('begin', snapshot_id))
                raise WorkerError('snapshot_busy')

            def snapshot_end(self, snapshot_id):
                seen.append(('end', snapshot_id))
                return {'state': 'idle'}

        with tempfile.TemporaryDirectory() as directory:
            pathname = Path(directory) / 'worker.sock'
            server = create_server(Controller(), pathname)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                self.assertEqual(self.call(pathname, 'POST', '/leases/send', {'leaseId': 'lease-1'}),
                                 (200, {'leaseId': 'lease-1'}))
                self.assertEqual(self.call(pathname, 'POST', '/snapshot/renew', {'snapshotId': 'snap-1'}),
                                 (200, {'state': 'snapshot'}))
                self.assertEqual(self.call(pathname, 'DELETE', '/leases/lease-1'), (200, {'released': True}))
                self.assertEqual(self.call(pathname, 'POST', '/snapshot/begin', {'snapshotId': 'snap-1'}),
                                 (409, {'errorCode': 'snapshot_busy'}))
                self.assertEqual(self.call(pathname, 'POST', '/snapshot/end', {'snapshotId': 'snap-1'}),
                                 (200, {'state': 'idle'}))
                self.assertEqual(self.call(pathname, 'DELETE', '/connections/attempt-a')[0], 404)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()
        self.assertEqual(seen, [('acquire', 'lease-1'), ('renew', 'snap-1'), ('release', 'lease-1'),
                                ('begin', 'snap-1'), ('end', 'snap-1')])


if __name__ == '__main__':
    unittest.main()
