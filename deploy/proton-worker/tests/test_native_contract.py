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
