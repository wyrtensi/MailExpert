import os
import stat
import tempfile
import unittest
from pathlib import Path

try:
    from native import NativeBridge, encode_secret, decode_bridge_password
except ImportError:
    NativeBridge = None


class NativeContractTests(unittest.TestCase):
    def setUp(self):
        self.assertIsNotNone(NativeBridge, 'native adapter is not implemented')

    def test_secret_bytes_encoding(self):
        self.assertEqual(encode_secret('páss'), b'cMOhc3M=')

    def test_bridge_password_not_decoded_twice(self):
        self.assertEqual(decode_bridge_password(b'YWJj'), 'YWJj')

    def test_quit_waits_for_process_exit(self):
        class Process:
            def __init__(self):
                self.waited = False

            def wait(self, timeout):
                self.waited = True

            def poll(self):
                return None

        class Stub:
            def StopEventStream(self, request, **kwargs):
                pass

            def Quit(self, request, **kwargs):
                pass

        with tempfile.TemporaryDirectory() as directory:
            bridge = NativeBridge(Path(directory), Path(directory))
            bridge.process = Process()
            process = bridge.process
            bridge.stub = Stub()
            bridge.shutdown()
            self.assertTrue(process.waited)

    def test_stream_end_is_reported_unless_requested(self):
        # I-2: an unexpected end of the event stream reaches the controller.
        with tempfile.TemporaryDirectory() as directory:
            events = []
            bridge = NativeBridge(Path(directory), Path(directory))
            bridge.callback = events.append
            bridge._pump(iter([]), bridge.epoch)
            self.assertEqual(events, [{'kind': 'stream_ended'}])
            bridge._pump(iter([]), bridge.epoch - 1)
            self.assertEqual(events, [{'kind': 'stream_ended'}])

    def test_native_logs_are_quiet_and_ephemeral(self):
        # I-6: Bridge logs at error level into the per-container runtime tmpfs, not the state.
        with tempfile.TemporaryDirectory() as state, tempfile.TemporaryDirectory() as runtime:
            bridge = NativeBridge(Path(state), Path(runtime))
            self.assertEqual(bridge.command()[1:], ['--grpc', '--no-window', '--log-level', 'error'])
            bridge.prepare_logs()
            logs = Path(state) / 'data' / 'protonmail' / 'bridge-v3' / 'logs'
            self.assertTrue(logs.is_symlink())
            self.assertEqual(os.path.realpath(logs), os.path.realpath(Path(runtime) / 'logs'))
            self.assertEqual(stat.S_IMODE((Path(runtime) / 'logs').stat().st_mode), 0o700)
            bridge.prepare_logs()
            self.assertTrue(logs.is_symlink())
