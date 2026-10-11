import http.client
import json
import os
import socket
import stat
import tempfile
import threading
import unittest
from pathlib import Path

try:
    from worker import create_server
except ImportError:
    create_server = None


class SocketTests(unittest.TestCase):
    def test_socket_is_private_and_no_tcp_listener(self):
        self.assertIsNotNone(create_server, 'UNIX worker is not implemented')
        class Controller:
            def health(self):
                return {'state': 'idle'}

        with tempfile.TemporaryDirectory() as directory:
            pathname = Path(directory) / 'worker.sock'
            server = create_server(Controller(), pathname)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                self.assertEqual(server.socket.family, socket.AF_UNIX)
                self.assertEqual(stat.S_IMODE(pathname.stat().st_mode), 0o600)
                self.assertEqual(stat.S_IMODE(Path(directory).stat().st_mode), 0o700)
                client = socket.socket(socket.AF_UNIX)
                client.connect(str(pathname))
                connection = http.client.HTTPConnection('localhost')
                connection.sock = client
                connection.request('GET', '/healthz')
                response = connection.getresponse()
                self.assertEqual(response.status, 200)
                self.assertEqual(json.loads(response.read()), {'state': 'idle'})
                connection.close()
            finally:
                server.shutdown()
                server.server_close()
                thread.join()

    def test_errors_are_mapped_without_details(self):
        self.assertIsNotNone(create_server, 'UNIX worker is not implemented')
        from controller import WorkerError

        class Controller:
            def health(self):
                raise RuntimeError('secret-sentinel')

            def connection_status(self, operation_id):
                raise WorkerError('not_found')

        with tempfile.TemporaryDirectory() as directory:
            pathname = Path(directory) / 'worker.sock'
            server = create_server(Controller(), pathname)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                def call(method, path, body=None):
                    client = socket.socket(socket.AF_UNIX)
                    client.connect(str(pathname))
                    connection = http.client.HTTPConnection('localhost')
                    connection.sock = client
                    connection.request(method, path, body=body)
                    response = connection.getresponse()
                    result = response.status, response.read().decode()
                    connection.close()
                    return result

                status, text = call('GET', '/healthz')
                self.assertEqual((status, json.loads(text)), (500, {'errorCode': 'worker_unavailable'}))
                self.assertEqual(call('GET', '/connections/attempt-a')[0], 404)
                self.assertEqual(call('GET', '/connections/../etc')[0], 404)
                self.assertEqual(call('POST', '/connections', b'x' * 70000)[0], 400)
                self.assertEqual(call('POST', '/connections', b'[1]')[0], 400)
            finally:
                server.shutdown()
                server.server_close()
                thread.join()

    def test_degraded_health_is_not_200(self):
        # I-2: a Bridge that should run but does not makes the Docker healthcheck fail.
        self.assertIsNotNone(create_server, 'UNIX worker is not implemented')

        class Controller:
            def health(self):
                return {'state': 'degraded'}

        with tempfile.TemporaryDirectory() as directory:
            pathname = Path(directory) / 'worker.sock'
            server = create_server(Controller(), pathname)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                client = socket.socket(socket.AF_UNIX)
                client.connect(str(pathname))
                connection = http.client.HTTPConnection('localhost')
                connection.sock = client
                connection.request('GET', '/healthz')
                response = connection.getresponse()
                self.assertEqual(response.status, 503)
                self.assertEqual(json.loads(response.read()), {'state': 'degraded'})
                connection.close()
            finally:
                server.shutdown()
                server.server_close()
                thread.join()
